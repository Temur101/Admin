import type { Booking, PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { REMINDER_ZSET_KEY } from "./booking-constants.js";

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
