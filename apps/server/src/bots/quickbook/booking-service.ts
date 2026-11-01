import type { Booking, PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import type { QuickBookConfig } from "@lcqb/contracts";
import type { TelegramTransport } from "../../adapters/telegram/transport.js";
import type { Logger } from "../../core/logger.js";
import {
  enqueueAdminNotifications,
  dispatchQueuedNotifications,
  bookingNotification,
} from "../shared/notification-outbox.js";
import { parseAndNormalizePhone } from "../shared/phone.js";
import { releaseSlotLock } from "./slot-lock.js";
import { getAlternativeSlots, type TimeSlot } from "./slot-generator.js";
import { formatTashkentDateTime } from "../shared/payment-service.js";
import { REMINDER_ZSET_KEY, REMINDER_LEAD_TIME_MS } from "./booking-constants.js";
import { getTashkentTimeParts, validateBookingSlotEligibility } from "./booking-validator.js";
import { BookingPolicyError, checkBookingPolicy, lockBookingPolicy } from "./booking-policy.js";

export { REMINDER_ZSET_KEY, REMINDER_LEAD_TIME_MS, formatTashkentDateTime };
export { getTashkentTimeParts, validateBookingSlotEligibility };
export {
  cancelBooking,
  type CancelBookingOptions,
  type CancelBookingResult,
} from "./booking-cancel-service.js";

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
  createdByTgId?: number | bigint | null;
  /** Price the customer/owner saw on the confirmation; a mismatch demands a fresh confirmation. */
  expectedPriceUzs?: number;
}

export type CreateBookingError =
  | "INVALID_PHONE"
  | "SERVICE_NOT_FOUND"
  | "STAFF_NOT_FOUND"
  | "SERVICE_NOT_SUPPORTED"
  | "SLOT_IN_PAST"
  | "TOO_SOON"
  | "OUTSIDE_HORIZON"
  | "NOT_IN_SCHEDULE"
  | "SLOT_IN_BREAK"
  | "SLOT_TAKEN";

export type CreateBookingResult =
  | { success: true; booking: Booking }
  | { success: false; error: "INVALID_PHONE" }
  | { success: false; error: "SERVICE_NOT_FOUND" | "STAFF_NOT_FOUND" | "SERVICE_NOT_SUPPORTED" }
  | { success: false; error: "PRICE_CHANGED"; priceUzs: number }
  | {
      success: false;
      error:
        | "SLOT_TAKEN"
        | "SLOT_IN_PAST"
        | "TOO_SOON"
        | "OUTSIDE_HORIZON"
        | "NOT_IN_SCHEDULE"
        | "SLOT_IN_BREAK";
      alternativeSlots: TimeSlot[];
    };

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
    lang = "RU",
  } = params;
  let config = params.config;
  const isManual = (params.source ?? (customerTgId != null ? "TELEGRAM" : "MANUAL")) === "MANUAL";

  const parsedPhone = parseAndNormalizePhone(customerPhone);
  if (!parsedPhone.isValid || !parsedPhone.normalized) {
    return { success: false, error: "INVALID_PHONE" };
  }
  const normalizedPhone = parsedPhone.normalized;

  const slotDate = typeof slotTime === "string" ? new Date(slotTime) : slotTime;
  const dateStr = getTashkentTimeParts(slotDate).dateStr;

  try {
    const booking = await prisma.$transaction(
      async (tx) => {
        await lockBookingPolicy(tx, botId, staffId);
        const {
          config: liveConfig,
          service: liveService,
          endTime,
        } = await checkBookingPolicy(tx, {
          botId,
          serviceId,
          staffId,
          slotDate,
          now: params.now,
          skipMinLead: isManual,
          expectedPriceUzs: params.expectedPriceUzs,
        });
        config = liveConfig;
        const serviceName = lang === "UZ" ? liveService.name.uz : liveService.name.ru;

        // Check for conflicting TimeBlock
        const timeBlock = tx.timeBlock?.findFirst
          ? await tx.timeBlock.findFirst({
              where: {
                botId,
                resourceId: { in: [staffId, "all"] },
                startsAt: { lt: endTime },
                endsAt: { gt: slotDate },
              },
            })
          : null;
        if (timeBlock) {
          throw new Error("TIME_BLOCKED");
        }

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

        const created = await tx.booking.create({
          data: {
            botId,
            customerTgId: customerTgId != null ? BigInt(customerTgId) : null,
            customerName: customerName ?? null,
            customerPhone: normalizedPhone,
            phoneVerified,
            serviceId,
            serviceName,
            staffId,
            durationMin: liveService.durationMin,
            priceUzs: liveService.priceUzs,
            slotTime: slotDate,
            endTime,
            status: "CONFIRMED",
            source,
            createdByTgId: params.createdByTgId != null ? BigInt(params.createdByTgId) : null,
          },
        });
        await enqueueAdminNotifications(
          tx,
          botId,
          `booking:${created.id}:created`,
          bookingNotification(created, "BOOKING"),
        );
        return created;
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
        durationMin: booking.durationMin,
        slotIntervalMin: config.slotIntervalMin,
      }).catch(() => {});
    }

    const reminderScore = slotDate.getTime() - REMINDER_LEAD_TIME_MS;
    await redis.zadd(REMINDER_ZSET_KEY, reminderScore, booking.id).catch((err) => {
      logger.warn({ err: (err as Error).message }, "Could not schedule reminder in Redis");
    });

    await dispatchQueuedNotifications({
      prisma,
      transport,
      logger,
      eventKey: `booking:${booking.id}:created`,
    });

    return { success: true, booking };
  } catch (err: unknown) {
    if (err instanceof BookingPolicyError) {
      if (err.code === "PRICE_CHANGED")
        return { success: false, error: "PRICE_CHANGED", priceUzs: err.priceUzs! };
      if (
        err.code === "SERVICE_NOT_FOUND" ||
        err.code === "STAFF_NOT_FOUND" ||
        err.code === "SERVICE_NOT_SUPPORTED"
      ) {
        return { success: false, error: err.code };
      }
      return {
        success: false,
        error: err.code,
        alternativeSlots: await getAlternativeSlots({
          botId,
          config: err.config ?? config,
          serviceId,
          staffId,
          dateStr,
          prisma,
          redis,
          now: params.now,
          lang,
          skipMinLead: isManual,
        }),
      };
    }
    const errorMsg = (err as Error).message ?? "";
    const errObj = typeof err === "object" && err !== null ? (err as Record<string, unknown>) : {};
    const errCode =
      (errObj.code as string | undefined) ?? (errObj.meta as { code?: string } | undefined)?.code;

    const isConflict =
      errorMsg.includes("SLOT_ALREADY_BOOKED") ||
      errorMsg.includes("TIME_BLOCKED") ||
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
        skipMinLead: isManual,
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
