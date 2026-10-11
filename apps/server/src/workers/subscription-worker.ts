import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { InlineKeyboard } from "grammy";
import type { Redis } from "ioredis";
import { createBotApi, type TelegramTransport } from "../adapters/telegram/transport.js";
import { decryptSecret } from "../core/crypto.js";
import { env } from "../core/env.js";
import type { Logger } from "../core/logger.js";
import { t } from "../bots/shared/i18n.js";

export interface SubscriptionWorkerOptions {
  prisma: PrismaClient;
  redis: Redis;
  transport: TelegramTransport;
  logger: Logger;
  now?: Date;
  lockTtlSec?: number;
}

export interface SubscriptionWorkerResult {
  executed: boolean;
  expiredCount: number;
}

const LOCK_KEY = "lock:worker:subscription";

const RELEASE_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/**
 * Background worker checking for expired trial and paid subscriptions.
 * Runs under a distributed Redis lock (with unique owner token and atomic release)
 * to ensure single-execution semantics without race conditions.
 *
 * Ensures renewal safety:
 * Transitions to EXPIRED conditionally so that an extension/payment approved
 * during the worker's tick is never overwritten back to EXPIRED.
 */
export async function runSubscriptionWorker(
  opts: SubscriptionWorkerOptions,
): Promise<SubscriptionWorkerResult> {
  const { prisma, redis, transport, logger } = opts;
  const now = opts.now ?? new Date();
  const lockTtl = opts.lockTtlSec ?? 60;

  const lockToken = randomUUID();
  let acquired = false;
  let pgLockAcquired = false;

  // 1. Acquire distributed lock (Redis PX/NX with unique owner token)
  try {
    const lockRes = await redis.set(LOCK_KEY, lockToken, "EX", lockTtl, "NX");
    acquired = lockRes === "OK";
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Redis error during subscription worker lock acquisition");
  }

  // Fallback to PG advisory lock if Redis is unreachable
  if (!acquired) {
    const isRedisReady = redis.status === "ready" || redis.status === "connect";
    if (!isRedisReady) {
      try {
        const rows = await prisma.$queryRaw<Array<{ acquired: boolean }>>`
          SELECT pg_try_advisory_lock(hashtext('subscription-worker')) AS acquired
        `;
        if (rows[0]?.acquired) {
          acquired = true;
          pgLockAcquired = true;
        }
      } catch (err) {
        logger.warn({ err: (err as Error).message }, "PG advisory lock failed for subscription worker");
      }
    }
  }

  if (!acquired) {
    logger.debug("Subscription worker lock already held; skipping tick");
    return { executed: false, expiredCount: 0 };
  }

  try {
    // 2. Query candidates for expired trials and active subscriptions
    const expiredSubs = await prisma.subscription.findMany({
      where: {
        OR: [
          { status: "TRIAL", trialEndsAt: { lt: now } },
          { status: "ACTIVE", paidUntil: { lt: now } },
        ],
      },
      include: {
        bot: {
          include: {
            users: { where: { isAdmin: true } },
          },
        },
      },
    });

    let expiredCount = 0;

    for (const sub of expiredSubs) {
      // 3. Conditionally update status in database ONLY if still expired.
      // This protects against race conditions where an admin approved a renewal
      // or receipt while this worker tick was running.
      const updateRes = await prisma.subscription.updateMany({
        where: {
          id: sub.id,
          OR: [
            { status: "TRIAL", trialEndsAt: { lt: now } },
            { status: "ACTIVE", paidUntil: { lt: now } },
          ],
        },
        data: { status: "EXPIRED" },
      });

      if (updateRes.count === 0) {
        logger.info(
          { subId: sub.id, botId: sub.bot.id },
          "Subscription was renewed or extended during worker tick; skipping EXPIRED transition",
        );
        continue;
      }

      // 4. Invalidate Redis cache for bot metadata
      await redis.del(`bot:hash:${sub.bot.botTokenHash}`, `bot:id:${sub.bot.id}`).catch(() => {});

      // 5. Notify bot admins
      if (sub.bot.users.length > 0) {
        try {
          const token = decryptSecret(sub.bot.botTokenEnc, env.TOKEN_ENCRYPTION_KEY);
          const api = createBotApi(token, sub.bot.id, transport);

          for (const admin of sub.bot.users) {
            const lang = admin.lang ?? "RU";
            const text = t(lang, "sub_expired_alert");
            const keyboard = new InlineKeyboard().text(t(lang, "btn_pay"), "admin:pay");

            await api.sendMessage(Number(admin.tgId), text, {
              reply_markup: keyboard,
            });
          }
        } catch (err) {
          logger.error(
            { err: (err as Error).message, botId: sub.bot.id },
            "Failed to send expiration notification to admin",
          );
        }
      }

      expiredCount++;
    }

    return { executed: true, expiredCount };
  } finally {
    // 6. Release locks safely without deleting someone else's lock
    if (pgLockAcquired) {
      await prisma.$executeRaw`SELECT pg_advisory_unlock(hashtext('subscription-worker'))`.catch(() => {});
    }
    await redis.eval(RELEASE_LOCK_LUA, 1, LOCK_KEY, lockToken).catch(() => {});
  }
}
