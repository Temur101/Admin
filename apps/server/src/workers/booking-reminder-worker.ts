import { randomUUID } from "node:crypto";
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
  batchSize?: number;
  maxAttempts?: number;
  leaseDurationMs?: number;
  backoffMs?: number | ((attempt: number) => number);
  enableRecoveryFromDb?: boolean;
}

export interface BookingReminderWorkerResult {
  executed: boolean;
  sentCount: number;
  skippedCount?: number;
  failedCount?: number;
}

const LOCK_KEY = "lock:worker:booking-reminder";

const RELEASE_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/**
 * Background worker checking for upcoming bookings to send a reminder 2 hours before the slot.
 * Ensures resilient processing:
 * 1. Redis ZSET + DB recovery (handles Redis crashes / downtime during booking).
 * 2. Atomic row-level claim/lease preventing race conditions between multiple workers.
 * 3. Success (reminderSent=true) marked strictly AFTER Telegram delivery confirmation.
 * 4. Bounded retries with exponential backoff and dead-letter classification.
 * 5. Expired/overdue tasks after long downtime are safely skipped without user spam.
 *
 * NOTE on external push delivery:
 * Telegram Bot API sendMessage does not provide request idempotency tokens. If a worker
 * process crashes or network drops after Telegram accepts the message but before HTTP 200
 * is acknowledged, subsequent recovery will re-send (at-least-once external delivery guarantee).
 */
export async function runBookingReminderWorker(
  opts: BookingReminderWorkerOptions,
): Promise<BookingReminderWorkerResult> {
  const { prisma, redis, transport, logger } = opts;
  const now = opts.now ?? new Date();
  const lockTtl = opts.lockTtlSec ?? 60;
  const batchSize = opts.batchSize ?? 50;
  const maxAttempts = opts.maxAttempts ?? 3;
  const leaseDurationMs = opts.leaseDurationMs ?? 30_000;
  const enableDbRecovery = opts.enableRecoveryFromDb ?? true;

  const lockToken = randomUUID();
  let acquired = false;
  let pgLockAcquired = false;

  // 1. Acquire distributed lock (Redis with PX/NX, fallback to PG advisory lock)
  try {
    const lockRes = await redis.set(LOCK_KEY, lockToken, "EX", lockTtl, "NX");
    acquired = lockRes === "OK";
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Redis error during booking reminder worker lock");
  }

  if (!acquired) {
    // If Redis is unreachable or errored, try PG advisory lock to allow worker execution
    const isRedisReady = redis.status === "ready" || redis.status === "connect";
    if (!isRedisReady) {
      try {
        const rows = await prisma.$queryRaw<Array<{ acquired: boolean }>>`
          SELECT pg_try_advisory_lock(hashtext('booking-reminder-worker')) AS acquired
        `;
        if (rows[0]?.acquired) {
          acquired = true;
          pgLockAcquired = true;
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "PG advisory lock failed for reminder worker");
      }
    }
  }

  if (!acquired) {
    logger.debug("Booking reminder worker lock already held; skipping tick");
    return { executed: false, sentCount: 0, skippedCount: 0, failedCount: 0 };
  }

  try {
    // 2. Fetch candidate booking IDs
    // Source A: Redis ZSET (scores <= now)
    let redisDueIds: string[] = [];
    try {
      redisDueIds = await redis.zrangebyscore(REMINDER_ZSET_KEY, 0, now.getTime(), "LIMIT", 0, batchSize);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "Redis error querying reminder ZSET; relying on DB query");
    }

    // Source B: Database query (Recovery for bookings created when Redis was down or evicted)
    let dbDueIds: string[] = [];
    if (enableDbRecovery) {
      try {
        const twoHoursAhead = new Date(now.getTime() + 2 * 3600 * 1000);
        const dbDueBookings = await prisma.booking.findMany({
          where: {
            status: "CONFIRMED",
            reminderSent: false,
            slotTime: { lte: twoHoursAhead },
            reminderAttempts: { lt: maxAttempts },
            OR: [
              { reminderLockedUntil: null },
              { reminderLockedUntil: { lte: now } },
            ],
          },
          select: { id: true },
          take: batchSize,
          orderBy: { slotTime: "asc" },
        });
        dbDueIds = dbDueBookings.map((b) => b.id);
      } catch (err) {
        logger.error({ err: (err as Error).message }, "Failed to query database for due reminder bookings");
      }
    }

    // Deduplicate and apply batch size
    const dueBookingIds = Array.from(new Set([...redisDueIds, ...dbDueIds])).slice(0, batchSize);

    if (dueBookingIds.length === 0) {
      return { executed: true, sentCount: 0, skippedCount: 0, failedCount: 0 };
    }

    let sentCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const bookingId of dueBookingIds) {
      // 3. Atomically claim/lease the booking in DB to prevent concurrent workers from sending duplicate
      const leaseUntil = new Date(now.getTime() + leaseDurationMs);

      const claimResult = await prisma.booking.updateMany({
        where: {
          id: bookingId,
          status: "CONFIRMED",
          reminderSent: false,
          reminderAttempts: { lt: maxAttempts },
          OR: [
            { reminderLockedUntil: null },
            { reminderLockedUntil: { lte: now } },
          ],
        },
        data: {
          reminderLockedUntil: leaseUntil,
          reminderAttempts: { increment: 1 },
        },
      });

      if (claimResult.count === 0) {
        // Could not claim: either locked by another worker, cancelled, already sent, or max attempts reached
        const check = await prisma.booking.findUnique({
          where: { id: bookingId },
          select: { status: true, reminderSent: true, reminderAttempts: true },
        });

        // Clean up from Redis if terminal
        if (!check || check.status !== "CONFIRMED" || check.reminderSent || check.reminderAttempts >= maxAttempts) {
          await redis.zrem(REMINDER_ZSET_KEY, bookingId).catch(() => {});
        }
        continue;
      }

      // 4. Fetch full booking details
      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { bot: true },
      });

      if (!booking || booking.status !== "CONFIRMED") {
        await redis.zrem(REMINDER_ZSET_KEY, bookingId).catch(() => {});
        skippedCount++;
        continue;
      }

      // Check for overdue / expired task (server downtime recovery):
      // If slotTime has already started or passed, sending a "2 hours before" reminder is obsolete.
      if (booking.slotTime.getTime() <= now.getTime()) {
        logger.info(
          { bookingId, slotTime: booking.slotTime.toISOString(), now: now.toISOString() },
          "Booking slot already passed; marking reminder as expired/skipped without sending",
        );
        await prisma.booking.update({
          where: { id: bookingId },
          data: {
            reminderSent: true,
            reminderLockedUntil: null,
            reminderLastError: "EXPIRED_PAST_SLOT",
          },
        });
        await redis.zrem(REMINDER_ZSET_KEY, bookingId).catch(() => {});
        skippedCount++;
        continue;
      }

      // 5. Check if booking is manual / has no customerTgId
      if (!booking.customerTgId || booking.source === "MANUAL") {
        logger.info({ bookingId }, "Booking is manual or has no customerTgId; skipping Telegram push");
        await prisma.booking.update({
          where: { id: bookingId },
          data: {
            reminderSent: true,
            reminderLockedUntil: null,
            reminderLastError: null,
          },
        });
        await redis.zrem(REMINDER_ZSET_KEY, bookingId).catch(() => {});
        skippedCount++;
        continue;
      }

      // 6. Send reminder via Telegram API
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

        // 6. Mark success strictly AFTER Telegram delivery confirmation
        await prisma.booking.update({
          where: { id: bookingId },
          data: {
            reminderSent: true,
            reminderLockedUntil: null,
            reminderLastError: null,
          },
        });

        // Remove from Redis ZSET on success
        await redis.zrem(REMINDER_ZSET_KEY, bookingId).catch(() => {});
        sentCount++;
      } catch (err: unknown) {
        const errorMsg = (err as Error).message || String(err);
        const currentAttempts = booking.reminderAttempts;

        logger.error(
          { err: errorMsg, bookingId, attempts: currentAttempts, maxAttempts },
          "Failed to send booking reminder message to client",
        );

        if (currentAttempts >= maxAttempts) {
          // Dead-letter: maximum attempts exhausted
          logger.error(
            { bookingId, attempts: currentAttempts, err: errorMsg },
            "Booking reminder reached max attempts; moved to dead-letter",
          );
          await prisma.booking.update({
            where: { id: bookingId },
            data: {
              reminderLockedUntil: null,
              reminderLastError: `DEAD_LETTER: ${errorMsg}`,
            },
          });
          await redis.zrem(REMINDER_ZSET_KEY, bookingId).catch(() => {});
        } else {
          // Bounded retry with exponential backoff
          const backoffDelay =
            typeof opts.backoffMs === "function"
              ? opts.backoffMs(currentAttempts)
              : (opts.backoffMs ?? Math.min(300_000, Math.pow(2, currentAttempts - 1) * 5_000));
          const nextRetryAt = new Date(now.getTime() + backoffDelay);

          await prisma.booking.update({
            where: { id: bookingId },
            data: {
              reminderLockedUntil: nextRetryAt,
              reminderLastError: errorMsg,
            },
          });
          await redis.zadd(REMINDER_ZSET_KEY, nextRetryAt.getTime(), bookingId).catch(() => {});
        }

        failedCount++;
      }
    }

    return { executed: true, sentCount, skippedCount, failedCount };
  } finally {
    // Release locks
    if (pgLockAcquired) {
      await prisma.$executeRaw`SELECT pg_advisory_unlock(hashtext('booking-reminder-worker'))`.catch(() => {});
    }
    await redis.eval(RELEASE_LOCK_LUA, 1, LOCK_KEY, lockToken).catch(() => {});
  }
}
