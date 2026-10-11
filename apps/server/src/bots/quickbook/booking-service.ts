import type { Booking, PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import type { QuickBookConfig } from "@lcqb/contracts";
import type { TelegramTransport } from "../../adapters/telegram/transport.js";
import type { Logger } from "../../core/logger.js";
import { notifyAdmins } from "../shared/notification.js";
import { parseAndNormalizePhone } from "../shared/phone.js";
import { releaseSlotLock } from "./slot-lock.js";
import { getAlternativeSlots, type TimeSlot } from "./slot-generator.js";

export interface CreateBookingParams {
  prisma: PrismaClient;
  redis: Redis;
  transport: TelegramTransport;
  logger: Logger;
  botId: string;
  customerTgId: number | bigint;
  customerName?: string | null;
  customerPhone: string;
  serviceId: string;
  staffId: string;
  slotTime: Date | string;
  config: QuickBookConfig;
  lang?: "RU" | "UZ";
}

export type CreateBookingResult =
  | { success: true; booking: Booking }
  | { success: false; error: "INVALID_PHONE" }
  | { success: false; error: "SERVICE_NOT_FOUND" | "STAFF_NOT_FOUND" }
  | { success: false; error: "SLOT_TAKEN"; alternativeSlots: TimeSlot[] };

import { formatTashkentDateTime } from "../shared/payment-service.js";

export const REMINDER_ZSET_KEY = "booking:reminders";
export { formatTashkentDateTime };

export async function createBooking(
  params: CreateBookingParams,
): Promise<CreateBookingResult> {
  const {
    prisma,
    redis,
    transport,
    logger,
    botId,
    customerTgId,
    customerName,
    customerPhone,
    serviceId,
    staffId,
    slotTime,
    config,
    lang = "RU",
  } = params;

  // 1. Normalize phone
  const parsedPhone = parseAndNormalizePhone(customerPhone);
  if (!parsedPhone.isValid || !parsedPhone.normalized) {
    return { success: false, error: "INVALID_PHONE" };
  }
  const normalizedPhone = parsedPhone.normalized;

  // 2. Validate service and staff in config
  const service = config.services.find((s) => s.id === serviceId);
  if (!service) {
    return { success: false, error: "SERVICE_NOT_FOUND" };
  }

  const staff = config.resources.find((r) => r.id === staffId);
  if (!staff) {
    return { success: false, error: "STAFF_NOT_FOUND" };
  }

  const slotDate = typeof slotTime === "string" ? new Date(slotTime) : slotTime;
  const serviceName = lang === "UZ" ? service.name.uz : service.name.ru;
  const staffName = lang === "UZ" ? staff.name.uz : staff.name.ru;

  try {
    // 3. Insert booking in Prisma interactive transaction
    const booking = await prisma.$transaction(async (tx) => {
      // Check active booking conflict inside transaction
      const existing = await tx.booking.findFirst({
        where: {
          botId,
          staffId,
          slotTime: slotDate,
          status: { in: ["PENDING", "CONFIRMED"] },
        },
      });

      if (existing) {
        if (existing.customerTgId === BigInt(customerTgId)) {
          return existing;
        }
        throw new Error("SLOT_ALREADY_BOOKED");
      }

      return tx.booking.create({
        data: {
          botId,
          customerTgId: BigInt(customerTgId),
          customerName: customerName ?? null,
          customerPhone: normalizedPhone,
          serviceId,
          serviceName,
          staffId,
          durationMin: service.durationMin,
          slotTime: slotDate,
          status: "CONFIRMED",
        },
      });
    });

    // 4. Release Redis lock for this slot safely
    await releaseSlotLock(redis, {
      botId,
      staffId,
      slotTime: slotDate,
      userId: customerTgId,
    }).catch(() => {});

    // 5. Schedule 2-hour reminder in Redis ZSET
    // score = slotTime - 2 hours (ms)
    const reminderScore = slotDate.getTime() - 2 * 3600 * 1000;
    await redis.zadd(REMINDER_ZSET_KEY, reminderScore, booking.id).catch((err) => {
      logger.warn({ err: (err as Error).message }, "Could not schedule reminder in Redis");
    });

    // 6. Notify admins
    const timeFormatted = formatTashkentDateTime(slotDate);
    await notifyAdmins(
      botId,
      {
        kind: "BOOKING",
        name: customerName,
        phone: normalizedPhone,
        service: serviceName,
        staff: staffName,
        time: timeFormatted,
      },
      { prisma, transport, logger },
    ).catch((err) => {
      logger.error({ err: (err as Error).message }, "Failed to notify admins of new booking");
    });

    return { success: true, booking };
  } catch (err: unknown) {
    const errorMsg = (err as Error).message;
    // P2002 is Prisma unique constraint violation code (our booking_slot_active_uq partial index!)
    const isConflict =
      errorMsg.includes("SLOT_ALREADY_BOOKED") ||
      (typeof err === "object" && err !== null && "code" in err && err.code === "P2002");

    if (isConflict) {
      logger.warn(
        { botId, staffId, slotTime: slotDate.toISOString() },
        "Booking slot conflict detected, fetching alternative slots",
      );

      const dateStr = slotDate.toISOString().slice(0, 10);
      const alternativeSlots = await getAlternativeSlots({
        botId,
        config,
        serviceId,
        staffId,
        dateStr,
        prisma,
        redis,
        lang,
      });

      return {
        success: false,
        error: "SLOT_TAKEN",
        alternativeSlots,
      };
    }

    throw err;
  }
}

export interface CancelBookingOptions {
  bookingId: string;
  botId?: string;
  userId?: number | bigint;
  isAdmin?: boolean;
}

export type CancelBookingResult =
  | { success: true; booking: Booking; alreadyCancelled: boolean }
  | { success: false; error: "NOT_FOUND" | "FORBIDDEN" };

export async function cancelBooking(
  prisma: PrismaClient,
  redis: Redis,
  bookingIdOrOpts: string | CancelBookingOptions,
  botId?: string,
  userId?: number | bigint,
  isAdmin?: boolean,
): Promise<CancelBookingResult> {
  const opts: CancelBookingOptions =
    typeof bookingIdOrOpts === "string"
      ? {
          bookingId: bookingIdOrOpts,
          botId,
          userId,
          isAdmin,
        }
      : bookingIdOrOpts;

  const booking = await prisma.booking.findUnique({
    where: { id: opts.bookingId },
  });

  if (!booking) {
    return { success: false, error: "NOT_FOUND" };
  }

  // Must match current bot if botId specified
  if (opts.botId && booking.botId !== opts.botId) {
    return { success: false, error: "FORBIDDEN" };
  }

  // Must match booking owner or bot admin
  if (opts.userId !== undefined && opts.userId !== null && opts.userId !== 0) {
    const isOwner = booking.customerTgId === BigInt(opts.userId);
    if (!isOwner && !opts.isAdmin) {
      return { success: false, error: "FORBIDDEN" };
    }
  }

  // Safe idempotent return if already cancelled
  if (booking.status === "CANCELLED") {
    return { success: true, booking, alreadyCancelled: true };
  }

  const updated = await prisma.booking.update({
    where: { id: opts.bookingId },
    data: { status: "CANCELLED" },
  });

  // Remove from reminders ZSET
  await redis.zrem(REMINDER_ZSET_KEY, opts.bookingId).catch(() => {});

  return { success: true, booking: updated, alreadyCancelled: false };
}
