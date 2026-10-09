import type { PrismaClient } from "@prisma/client";
import { InlineKeyboard } from "grammy";
import type { Redis } from "ioredis";
import { createBotApi, type TelegramTransport } from "../adapters/telegram/transport.js";
import { decryptSecret } from "../core/crypto.js";
import { env } from "../core/env.js";
import type { Logger } from "../core/logger.js";
import { t } from "../bots/shared/i18n.js";
import { REMINDER_ZSET_KEY, formatTashkentDateTime } from "../bots/quickbook/booking-service.js";

export interface BookingReminderWorkerOptions {
  prisma: PrismaClient;
  redis: Redis;
  transport: TelegramTransport;
  logger: Logger;
  now?: Date;
  lockTtlSec?: number;
}

export interface BookingReminderWorkerResult {
  executed: boolean;
  sentCount: number;
}

const LOCK_KEY = "lock:worker:booking-reminder";

/**
 * Background worker checking for upcoming bookings to send a reminder 2 hours before the slot.
 * Operates on Redis ZSET (score = slotTime - 2 hours).
 */
export async function runBookingReminderWorker(
  opts: BookingReminderWorkerOptions,
): Promise<BookingReminderWorkerResult> {
  const { prisma, redis, transport, logger } = opts;
  const now = opts.now ?? new Date();
  const lockTtl = opts.lockTtlSec ?? 60;

  // 1. Acquire distributed lock
  let acquired = false;
  try {
    const lockRes = await redis.set(LOCK_KEY, "1", "EX", lockTtl, "NX");
    acquired = lockRes === "OK";
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Redis error during booking reminder worker lock");
    return { executed: false, sentCount: 0 };
  }

  if (!acquired) {
    logger.debug("Booking reminder worker lock already held; skipping tick");
    return { executed: false, sentCount: 0 };
  }

  try {
    // 2. Fetch all booking IDs where reminder timestamp <= now
    const dueBookingIds = await redis.zrangebyscore(REMINDER_ZSET_KEY, 0, now.getTime());

    if (dueBookingIds.length === 0) {
      return { executed: true, sentCount: 0 };
    }

    let sentCount = 0;

    for (const bookingId of dueBookingIds) {
      // 3. Remove from ZSET first to prevent repeated processing
      await redis.zrem(REMINDER_ZSET_KEY, bookingId).catch(() => {});

      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { bot: true },
      });

      // If booking cancelled or already reminded or deleted -> skip
      if (!booking || booking.status !== "CONFIRMED" || booking.reminderSent) {
        continue;
      }

      // 4. Mark reminder as sent in DB
      await prisma.booking.update({
        where: { id: bookingId },
        data: { reminderSent: true },
      });

      // 5. Send reminder Telegram message to client
      try {
        const token = decryptSecret(booking.bot.botTokenEnc, env.TOKEN_ENCRYPTION_KEY);
        const api = createBotApi(token, booking.bot.id, transport);

        // Find customer language
        const user = await prisma.botUser.findUnique({
          where: {
            botId_tgId: {
              botId: booking.bot.id,
              tgId: booking.customerTgId,
            },
          },
        });
        const lang = user?.lang ?? "RU";

        const text = t(lang, "qb_reminder_text", {
          time: formatTashkentDateTime(booking.slotTime),
          service: booking.serviceName,
          label: lang === "UZ" ? "Mutaxassis" : "Специалист",
          resource: booking.staffId,
        });

        const keyboard = new InlineKeyboard()
          .text(t(lang, "qb_btn_confirm"), `book:confirm:${booking.id}`)
          .text(t(lang, "qb_btn_cancel"), `book:cancel:${booking.id}`);

        await api.sendMessage(Number(booking.customerTgId), text, {
          reply_markup: keyboard,
        });

        sentCount++;
      } catch (err) {
        logger.error(
          { err: (err as Error).message, bookingId },
          "Failed to send booking reminder message to client",
        );
      }
    }

    return { executed: true, sentCount };
  } finally {
    // Release lock
    await redis.del(LOCK_KEY).catch(() => {});
  }
}
