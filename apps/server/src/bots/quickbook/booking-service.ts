import type { Booking, PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import type { QuickBookConfig } from "@lcqb/contracts";
import type { TelegramTransport } from "../../adapters/telegram/transport.js";
import type { Logger } from "../../core/logger.js";
import { notifyAdmins } from "../shared/notification.js";
import { parseAndNormalizePhone } from "../shared/phone.js";
import { releaseSlotLock } from "./slot-lock.js";
import { getAlternativeSlots, type TimeSlot } from "./slot-generator.js";
import { formatTashkentDateTime } from "../shared/payment-service.js";

export const REMINDER_ZSET_KEY = "booking:reminders";
export const REMINDER_LEAD_TIME_MS = 1 * 3600 * 1000;
export { formatTashkentDateTime };

export interface CreateBookingParams {
  prisma: PrismaClient;
  redis: Redis;
  transport: TelegramTransport;
  logger: Logger;
  botId: string;
  customerTgId?: number | bigint | null;
  customerName?: string | null;
  customerPhone: string;
  phoneVerified?: boolean;
  serviceId: string;
  staffId: string;
  slotTime: Date | string;
  config: QuickBookConfig;
  lang?: "RU" | "UZ";
  lockToken?: string;
  now?: Date;
  source?: "TELEGRAM" | "MANUAL";
}

export type CreateBookingError =
  | "INVALID_PHONE"
  | "SERVICE_NOT_FOUND"
  | "STAFF_NOT_FOUND"
  | "SERVICE_NOT_SUPPORTED"
  | "SLOT_IN_PAST"
  | "OUTSIDE_HORIZON"
  | "NOT_IN_SCHEDULE"
  | "SLOT_IN_BREAK"
  | "SLOT_TAKEN";

export type CreateBookingResult =
  | { success: true; booking: Booking }
  | { success: false; error: "INVALID_PHONE" }
  | { success: false; error: "SERVICE_NOT_FOUND" | "STAFF_NOT_FOUND" | "SERVICE_NOT_SUPPORTED" }
  | {
      success: false;
      error:
        | "SLOT_TAKEN"
        | "SLOT_IN_PAST"
        | "OUTSIDE_HORIZON"
        | "NOT_IN_SCHEDULE"
        | "SLOT_IN_BREAK";
      alternativeSlots: TimeSlot[];
    };

import { getTashkentTimeParts, validateBookingSlotEligibility } from "./booking-validator.js";
export { getTashkentTimeParts, validateBookingSlotEligibility };

export async function createBooking(params: CreateBookingParams): Promise<CreateBookingResult> {
  const {
    prisma,
    redis,
    transport,
    logger,
    botId,
    customerTgId,
    customerName,
    customerPhone,
    phoneVerified = false,
    serviceId,
    staffId,
    slotTime,
    config,
    lang = "RU",
  } = params;

  const parsedPhone = parseAndNormalizePhone(customerPhone);
  if (!parsedPhone.isValid || !parsedPhone.normalized) {
    return { success: false, error: "INVALID_PHONE" };
  }
  const normalizedPhone = parsedPhone.normalized;

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
  const dateStr = getTashkentTimeParts(slotDate).dateStr;

  const eligibility = validateBookingSlotEligibility({
    config,
    service,
    staff,
    slotDate,
    now: params.now,
  });

  if (!eligibility.valid) {
    if (eligibility.error === "SERVICE_NOT_SUPPORTED") {
      return { success: false, error: "SERVICE_NOT_SUPPORTED" };
    }

    const alternativeSlots = await getAlternativeSlots({
      botId,
      config,
      serviceId,
      staffId,
      dateStr,
      prisma,
      redis,
      now: params.now,
      lang,
    });

    return {
      success: false,
      error: eligibility.error,
      alternativeSlots,
    };
  }

  const endTime = new Date(slotDate.getTime() + service.durationMin * 60000);

  try {
    const booking = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${botId}:${staffId}`}));`;

        const existing = await tx.booking.findFirst({
          where: {
            botId,
            staffId,
            status: { in: ["PENDING", "CONFIRMED"] },
            slotTime: { lt: endTime },
            endTime: { gt: slotDate },
          },
        });

        if (existing) {
          if (
            customerTgId != null &&
            existing.customerTgId === BigInt(customerTgId) &&
            existing.slotTime.getTime() === slotDate.getTime()
          ) {
            return existing;
          }
          throw new Error("SLOT_ALREADY_BOOKED");
        }

        const source = params.source ?? (customerTgId != null ? "TELEGRAM" : "MANUAL");

        return tx.booking.create({
          data: {
            botId,
            customerTgId: customerTgId != null ? BigInt(customerTgId) : null,
            customerName: customerName ?? null,
            customerPhone: normalizedPhone,
            phoneVerified,
            serviceId,
            serviceName,
            staffId,
            durationMin: service.durationMin,
            slotTime: slotDate,
            endTime,
            status: "CONFIRMED",
            source,
          },
        });
      },
      { maxWait: 15000, timeout: 20000 },
    );

    if (customerTgId != null) {
      await releaseSlotLock(redis, {
        botId,
        staffId,
        slotTime: slotDate,
        userId: customerTgId,
        lockToken: params.lockToken,
        durationMin: service.durationMin,
        slotIntervalMin: config.slotIntervalMin,
      }).catch(() => {});
    }

    const reminderScore = slotDate.getTime() - REMINDER_LEAD_TIME_MS;
    await redis.zadd(REMINDER_ZSET_KEY, reminderScore, booking.id).catch((err) => {
      logger.warn({ err: (err as Error).message }, "Could not schedule reminder in Redis");
    });

    const timeFormatted = formatTashkentDateTime(slotDate);
    await notifyAdmins(
      botId,
      {
        kind: "BOOKING",
        name: customerName,
        phone: normalizedPhone,
        phoneVerified,
        service: serviceName,
        staff: staffName,
        time: timeFormatted,
        serviceId,
        staffId,
      },
      { prisma, transport, logger },
    ).catch((err) => {
      logger.error({ err: (err as Error).message }, "Failed to notify admins of new booking");
    });

    return { success: true, booking };
  } catch (err: unknown) {
    const errorMsg = (err as Error).message ?? "";
    const errObj = typeof err === "object" && err !== null ? (err as Record<string, unknown>) : {};
    const errCode =
      (errObj.code as string | undefined) ?? (errObj.meta as { code?: string } | undefined)?.code;

    const isConflict =
      errorMsg.includes("SLOT_ALREADY_BOOKED") ||
      errorMsg.includes("booking_no_overlap_excl") ||
      errorMsg.includes("conflicts with existing key") ||
      errorMsg.includes("Unable to start a transaction in the given time") ||
      errCode === "P2002" ||
      errCode === "23P01" ||
      errCode === "P2010" ||
      errCode === "P2028";

    if (isConflict) {
      logger.warn(
        { botId, staffId, slotTime: slotDate.toISOString() },
        "Booking slot conflict detected, fetching alternative slots",
      );

      const alternativeSlots = await getAlternativeSlots({
        botId,
        config,
        serviceId,
        staffId,
        dateStr,
        prisma,
        redis,
        now: params.now,
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

  if (opts.botId && booking.botId !== opts.botId) {
    return { success: false, error: "FORBIDDEN" };
  }

  if (opts.userId !== undefined && opts.userId !== null && opts.userId !== 0) {
    const isOwner = booking.customerTgId === BigInt(opts.userId);
    if (!isOwner && !opts.isAdmin) {
      return { success: false, error: "FORBIDDEN" };
    }
  }

  if (booking.status === "CANCELLED") {
    return { success: true, booking, alreadyCancelled: true };
  }

  const updated = await prisma.booking.update({
    where: { id: opts.bookingId },
    data: {
      status: "CANCELLED",
      reminderLockedUntil: null,
    },
  });

  await redis.zrem(REMINDER_ZSET_KEY, opts.bookingId).catch(() => {});

  return { success: true, booking: updated, alreadyCancelled: false };
}
