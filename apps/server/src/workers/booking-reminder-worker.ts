import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { InlineKeyboard } from "grammy";
import type { Redis } from "ioredis";
import { RESOURCE_LABELS } from "@lcqb/contracts";
import { createBotApi, type TelegramTransport } from "../adapters/telegram/transport.js";
import { decryptSecret } from "../core/crypto.js";
import { env } from "../core/env.js";
import type { Logger } from "../core/logger.js";
import { t } from "../bots/shared/i18n.js";
import {
  classifyTelegramError,
  handleBotTelegramError,
} from "../bots/shared/telegram-errors.js";
import {
  REMINDER_ZSET_KEY,
  REMINDER_LEAD_TIME_MS,
  formatTashkentDateTime,
} from "../bots/quickbook/booking-service.js";
import { getQuickBookConfig } from "../bots/quickbook/config-resolver.js";

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

  try {
    const lockRes = await redis.set(LOCK_KEY, lockToken, "EX", lockTtl, "NX");
    acquired = lockRes === "OK";
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Redis error during booking reminder worker lock");
  }

  if (!acquired) {
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
    let redisDueIds: string[] = [];
    try {
      redisDueIds = await redis.zrangebyscore(
        REMINDER_ZSET_KEY,
        0,
        now.getTime(),
        "LIMIT",
        0,
        batchSize,
      );
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        "Redis error querying reminder ZSET; relying on DB query",
      );
    }

    let dbDueIds: string[] = [];
    if (enableDbRecovery) {
      try {
        const oneHourAhead = new Date(now.getTime() + REMINDER_LEAD_TIME_MS);
        const dbDueBookings = await prisma.booking.findMany({
          where: {
            status: "CONFIRMED",
            reminderSent: false,
            slotTime: { lte: oneHourAhead },
            reminderAttempts: { lt: maxAttempts },
            OR: [{ reminderLockedUntil: null }, { reminderLockedUntil: { lte: now } }],
          },
          select: { id: true },
          take: batchSize,
          orderBy: { slotTime: "asc" },
        });
        dbDueIds = dbDueBookings.map((b) => b.id);
      } catch (err) {
        logger.error(
          { err: (err as Error).message },
          "Failed to query database for due reminder bookings",
        );
      }
    }

    const dueBookingIds = Array.from(new Set([...redisDueIds, ...dbDueIds])).slice(0, batchSize);
    if (dueBookingIds.length === 0) {
      return { executed: true, sentCount: 0, skippedCount: 0, failedCount: 0 };
    }

    let sentCount = 0;
    let skippedCount = 0;
    let failedCount = 0;

    for (const bookingId of dueBookingIds) {
      const leaseUntil = new Date(now.getTime() + leaseDurationMs);
      const claimResult = await prisma.booking.updateMany({
        where: {
          id: bookingId,
          status: "CONFIRMED",
          reminderSent: false,
          reminderAttempts: { lt: maxAttempts },
          OR: [{ reminderLockedUntil: null }, { reminderLockedUntil: { lte: now } }],
        },
        data: {
          reminderLockedUntil: leaseUntil,
          reminderAttempts: { increment: 1 },
        },
      });

      if (claimResult.count === 0) {
        const check = await prisma.booking.findUnique({
          where: { id: bookingId },
          select: { status: true, reminderSent: true, reminderAttempts: true },
        });
        if (
          !check ||
          check.status !== "CONFIRMED" ||
          check.reminderSent ||
          check.reminderAttempts >= maxAttempts
        ) {
          await redis.zrem(REMINDER_ZSET_KEY, bookingId).catch(() => {});
        }
        continue;
      }

      const booking = await prisma.booking.findUnique({
        where: { id: bookingId },
        include: { bot: true },
      });

      if (!booking || booking.status !== "CONFIRMED") {
        await redis.zrem(REMINDER_ZSET_KEY, bookingId).catch(() => {});
        skippedCount++;
        continue;
      }

      if (booking.slotTime.getTime() <= now.getTime()) {
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

      if (!booking.customerTgId || booking.source === "MANUAL") {
        await prisma.booking.update({
          where: { id: bookingId },
          data: { reminderSent: true, reminderLockedUntil: null, reminderLastError: null },
        });
        await redis.zrem(REMINDER_ZSET_KEY, bookingId).catch(() => {});
        skippedCount++;
        continue;
      }

      try {
        const token = decryptSecret(booking.bot.botTokenEnc, env.TOKEN_ENCRYPTION_KEY);
        const api = createBotApi(token, booking.bot.id, transport);

        const user = await prisma.botUser.findUnique({
          where: { botId_tgId: { botId: booking.bot.id, tgId: booking.customerTgId } },
        });
        const lang = user?.lang ?? "RU";
        const loc = lang === "UZ" ? "uz" : "ru";
        const config = getQuickBookConfig(
          booking.bot.settings as Record<string, unknown> | null | undefined,
        );
        const service = config.services.find((s) => s.id === booking.serviceId);
        const resource = config.resources.find((r) => r.id === booking.staffId);
        const serviceName = service?.name[loc] || booking.serviceName;
        const resourceName = resource?.name[loc] || booking.staffId;
        const resourceLabel =
          config.resourceLabel?.[loc] || RESOURCE_LABELS[config.resourceType][loc];

        const text = t(lang, "qb_reminder_text", {
          time: formatTashkentDateTime(booking.slotTime),
          service: serviceName,
          label: resourceLabel,
          resource: resourceName,
        });

        const keyboard = new InlineKeyboard()
          .text(t(lang, "qb_btn_confirm"), `book:confirm:${booking.id}`)
          .text(t(lang, "qb_btn_cancel"), `book:cancel:${booking.id}`);

        await api.sendMessage(Number(booking.customerTgId), text, {
          reply_markup: keyboard,
        });

        await prisma.booking.update({
          where: { id: bookingId },
          data: {
            reminderSent: true,
            reminderLockedUntil: null,
            reminderLastError: null,
          },
        });

        await redis.zrem(REMINDER_ZSET_KEY, bookingId).catch(() => {});
        sentCount++;
      } catch (err: unknown) {
        const classified = classifyTelegramError(err);
        await handleBotTelegramError({
          prisma,
          transport,
          logger,
          botId: booking.bot.id,
          recipientTgId: booking.customerTgId,
          classified,
        });

        const errorMsg = (err as Error).message || String(err);
        const currentAttempts = booking.reminderAttempts;

        logger.error(
          { err: errorMsg, bookingId, attempts: currentAttempts, maxAttempts },
          "Failed to send booking reminder message to client",
        );

        if (currentAttempts >= maxAttempts) {
          await prisma.booking.update({
            where: { id: bookingId },
            data: {
              reminderLockedUntil: null,
              reminderLastError: `DEAD_LETTER: ${errorMsg}`,
            },
          });
          await redis.zrem(REMINDER_ZSET_KEY, bookingId).catch(() => {});
        } else {
          const defaultBackoff =
            typeof opts.backoffMs === "function"
              ? opts.backoffMs(currentAttempts)
              : (opts.backoffMs ?? Math.min(300_000, Math.pow(2, currentAttempts - 1) * 5_000));
          const backoffDelay = classified.retryAfterMs ?? defaultBackoff;
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
    if (pgLockAcquired) {
      await prisma.$executeRaw`SELECT pg_advisory_unlock(hashtext('booking-reminder-worker'))`.catch(
        () => {},
      );
    }
    await redis.eval(RELEASE_LOCK_LUA, 1, LOCK_KEY, lockToken).catch(() => {});
  }
}
