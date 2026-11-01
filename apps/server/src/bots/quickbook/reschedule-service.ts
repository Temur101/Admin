import type { Booking, PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import type { QuickBookConfig } from "@lcqb/contracts";
import type { TelegramTransport } from "../../adapters/telegram/transport.js";
import type { Logger } from "../../core/logger.js";
import { randomUUID } from "node:crypto";
import {
  enqueueAdminNotifications,
  dispatchQueuedNotifications,
  bookingNotification,
} from "../shared/notification-outbox.js";
import { REMINDER_ZSET_KEY, REMINDER_LEAD_TIME_MS } from "./booking-constants.js";
import { validateBookingSlotEligibility } from "./booking-validator.js";

export interface RescheduleBookingParams {
  prisma: PrismaClient;
  redis: Redis;
  transport: TelegramTransport;
  logger: Logger;
  botId: string;
  bookingId: string;
  newSlotTime: Date | string;
  userId?: number | bigint;
  isAdmin?: boolean;
  config: QuickBookConfig;
  lang?: "RU" | "UZ";
  now?: Date;
}

export type RescheduleBookingResult =
  | { success: true; booking: Booking }
  | { success: false; error: "NOT_FOUND" | "FORBIDDEN" | "SLOT_TAKEN" | "INVALID_SLOT" };

export async function rescheduleBooking(
  params: RescheduleBookingParams,
): Promise<RescheduleBookingResult> {
  const {
    prisma,
    redis,
    transport,
    logger,
    botId,
    bookingId,
    newSlotTime,
    userId,
    isAdmin = false,
    config,
  } = params;

  const now = params.now ?? new Date();
  const slotDate = typeof newSlotTime === "string" ? new Date(newSlotTime) : newSlotTime;

  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
  });

  if (!booking || booking.botId !== botId) {
    return { success: false, error: "NOT_FOUND" };
  }

  if (!isAdmin && (userId == null || userId === 0 || booking.customerTgId !== BigInt(userId))) {
    return { success: false, error: "FORBIDDEN" };
  }

  if (booking.status !== "PENDING" && booking.status !== "CONFIRMED") {
    return { success: false, error: "INVALID_SLOT" };
  }

  const service = config.services.find((s) => s.id === booking.serviceId);
  const staff = config.resources.find((r) => r.id === booking.staffId);
  if (!service || !staff) {
    return { success: false, error: "INVALID_SLOT" };
  }

  const eligibility = validateBookingSlotEligibility({
    config,
    service: { ...service, durationMin: booking.durationMin },
    staff,
    slotDate,
    now,
  });

  if (!eligibility.valid) {
    return { success: false, error: "SLOT_TAKEN" };
  }

  const endTime = new Date(slotDate.getTime() + booking.durationMin * 60000);

  try {
    const eventKey = `booking:${bookingId}:rescheduled:${randomUUID()}`;
    const updated = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${`calendar:${botId}`}));`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${botId}:${booking.staffId}`}));`;

        const current = await tx.booking.findUnique({ where: { id: bookingId } });
        if (!current || !["PENDING", "CONFIRMED"].includes(current.status))
          throw new Error("BOOKING_INACTIVE");
        // Check for conflicting TimeBlock
        const timeBlock = await tx.timeBlock.findFirst({
          where: {
            botId,
            resourceId: { in: [booking.staffId, "all"] },
            startsAt: { lt: endTime },
            endsAt: { gt: slotDate },
          },
        });
        if (timeBlock) {
          throw new Error("TIME_BLOCKED");
        }

        // Check for conflicting Booking (excluding self!)
        const conflict = await tx.booking.findFirst({
          where: {
            botId,
            staffId: booking.staffId,
            id: { not: bookingId },
            status: { in: ["PENDING", "CONFIRMED"] },
            slotTime: { lt: endTime },
            endTime: { gt: slotDate },
          },
        });

        if (conflict) {
          throw new Error("SLOT_ALREADY_BOOKED");
        }

        if (current.slotTime.getTime() === slotDate.getTime()) return current;
        const updatedBooking = await tx.booking.update({
          where: { id: bookingId },
          data: {
            slotTime: slotDate,
            endTime,
            reminderSent: false,
            reminderAttempts: 0,
            reminderLockedUntil: null,
            reminderLastError: null,
          },
        });
        await enqueueAdminNotifications(
          tx,
          botId,
          eventKey,
          bookingNotification(updatedBooking, "BOOKING_RESCHEDULED"),
        );
        return updatedBooking;
      },
      { maxWait: 15000, timeout: 20000 },
    );

    // Update reminder score in Redis
    const reminderScore = slotDate.getTime() - REMINDER_LEAD_TIME_MS;
    await redis.zadd(REMINDER_ZSET_KEY, reminderScore, booking.id).catch(() => {});

    await dispatchQueuedNotifications({ prisma, transport, logger, eventKey });

    return { success: true, booking: updated };
  } catch (err: unknown) {
    const errorMsg = (err as Error).message ?? "";
    if (errorMsg.includes("BOOKING_INACTIVE")) return { success: false, error: "INVALID_SLOT" };
    const isConflict =
      errorMsg.includes("SLOT_ALREADY_BOOKED") ||
      errorMsg.includes("TIME_BLOCKED") ||
      errorMsg.includes("booking_no_overlap_excl") ||
      errorMsg.includes("conflicts with existing key");

    if (isConflict) {
      return { success: false, error: "SLOT_TAKEN" };
    }
    throw err;
  }
}
