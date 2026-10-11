import type { Booking, PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import type { QuickBookConfig, QuickBookResource, QuickBookService } from "@lcqb/contracts";
import type { TelegramTransport } from "../../adapters/telegram/transport.js";
import type { Logger } from "../../core/logger.js";
import { notifyAdmins } from "../shared/notification.js";
import { parseAndNormalizePhone } from "../shared/phone.js";
import { releaseSlotLock } from "./slot-lock.js";
import {
  getAlternativeSlots,
  parseTimeToMinutes,
  type TimeSlot,
} from "./slot-generator.js";
import { formatTashkentDateTime } from "../shared/payment-service.js";

export const REMINDER_ZSET_KEY = "booking:reminders";
export { formatTashkentDateTime };

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
  lockToken?: string;
  now?: Date;
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
      error: "SLOT_TAKEN" | "SLOT_IN_PAST" | "OUTSIDE_HORIZON" | "NOT_IN_SCHEDULE" | "SLOT_IN_BREAK";
      alternativeSlots: TimeSlot[];
    };

/**
 * Extracts Tashkent local time components (UTC+5) for scheduling and break checks.
 */
export function getTashkentTimeParts(date: Date): {
  year: number;
  month: number;
  day: number;
  dayOfWeek: number;
  minutesOfDay: number;
  dateStr: string;
} {
  const tashkentMs = date.getTime() + 5 * 3600 * 1000;
  const d = new Date(tashkentMs);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const dayOfWeek = d.getUTCDay();
  const minutesOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
  const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { year, month, day, dayOfWeek, minutesOfDay, dateStr };
}

/**
 * Validates slot eligibility: service-resource compatibility, past date,
 * booking horizon, resource working days, working hours, and break intervals.
 */
export function validateBookingSlotEligibility(params: {
  config: QuickBookConfig;
  service: QuickBookService;
  staff: QuickBookResource;
  slotDate: Date;
  now?: Date;
}):
  | { valid: true }
  | {
      valid: false;
      error: "SERVICE_NOT_SUPPORTED" | "SLOT_IN_PAST" | "OUTSIDE_HORIZON" | "NOT_IN_SCHEDULE" | "SLOT_IN_BREAK";
    } {
  const { config, service, staff, slotDate } = params;
  const now = params.now ?? new Date();

  // 1. Service supported by resource
  if (staff.serviceIds && staff.serviceIds.length > 0 && !staff.serviceIds.includes(service.id)) {
    return { valid: false, error: "SERVICE_NOT_SUPPORTED" };
  }

  // 2. Past time (slot must be strictly in the future)
  if (slotDate.getTime() <= now.getTime()) {
    return { valid: false, error: "SLOT_IN_PAST" };
  }

  // 3. Booking horizon
  const horizonDays = config.bookingHorizonDays ?? 14;
  const maxTimeMs = now.getTime() + horizonDays * 24 * 3600 * 1000;
  if (slotDate.getTime() > maxTimeMs) {
    return { valid: false, error: "OUTSIDE_HORIZON" };
  }

  // 4. Schedule & breaks in Tashkent time
  const { dayOfWeek, minutesOfDay } = getTashkentTimeParts(slotDate);

  if (!staff.workDays.includes(dayOfWeek)) {
    return { valid: false, error: "NOT_IN_SCHEDULE" };
  }

  const workStartMin = parseTimeToMinutes(staff.workHours.start);
  const workEndMin = parseTimeToMinutes(staff.workHours.end);
  const slotStartMin = minutesOfDay;
  const slotEndMin = slotStartMin + service.durationMin;

  if (slotStartMin < workStartMin || slotEndMin > workEndMin) {
    return { valid: false, error: "NOT_IN_SCHEDULE" };
  }

  if (staff.breakHours) {
    const breakStartMin = parseTimeToMinutes(staff.breakHours.start);
    const breakEndMin = parseTimeToMinutes(staff.breakHours.end);
    if (slotStartMin < breakEndMin && slotEndMin > breakStartMin) {
      return { valid: false, error: "SLOT_IN_BREAK" };
    }
  }

  return { valid: true };
}

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
  const dateStr = slotDate.toISOString().slice(0, 10);

  // 3. Check slot business eligibility (schedule, duration, break, past, horizon, compatibility)
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
    // 4. Insert booking in Prisma interactive transaction with PostgreSQL resource advisory lock
    const booking = await prisma.$transaction(
      async (tx) => {
        // Advisory transaction lock serializes concurrent bookings for this specific staff on this bot
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${botId}:${staffId}`}));`;

        // Check for ANY overlapping active booking: [slotDate, endTime) overlaps [b.slotTime, b.endTime)
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
          // Idempotent retry: if same customerTgId and exact same slotTime
          if (
            existing.customerTgId === BigInt(customerTgId) &&
            existing.slotTime.getTime() === slotDate.getTime()
          ) {
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
            endTime,
            status: "CONFIRMED",
          },
        });
      },
      { maxWait: 15000, timeout: 20000 },
    );

    // 5. Release Redis lock for this slot safely
    await releaseSlotLock(redis, {
      botId,
      staffId,
      slotTime: slotDate,
      userId: customerTgId,
      lockToken: params.lockToken,
      durationMin: service.durationMin,
      slotIntervalMin: config.slotIntervalMin,
    }).catch(() => {});

    // 6. Schedule 2-hour reminder in Redis ZSET
    const reminderScore = slotDate.getTime() - 2 * 3600 * 1000;
    await redis.zadd(REMINDER_ZSET_KEY, reminderScore, booking.id).catch((err) => {
      logger.warn({ err: (err as Error).message }, "Could not schedule reminder in Redis");
    });

    // 7. Notify admins
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
    const errorMsg = (err as Error).message ?? "";
    const errObj = typeof err === "object" && err !== null ? (err as Record<string, unknown>) : {};
    const errCode = (errObj.code as string | undefined) ?? (errObj.meta as { code?: string } | undefined)?.code;

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
    data: {
      status: "CANCELLED",
      reminderLockedUntil: null,
    },
  });

  // Remove from reminders ZSET
  await redis.zrem(REMINDER_ZSET_KEY, opts.bookingId).catch(() => {});

  return { success: true, booking: updated, alreadyCancelled: false };
}
