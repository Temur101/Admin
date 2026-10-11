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

/**
 * Background worker checking for expired trial and paid subscriptions.
 * Runs under a distributed Redis lock to ensure single-execution semantics
 * across multiple server instances or concurrent trigger calls.
 */
export async function runSubscriptionWorker(
  opts: SubscriptionWorkerOptions,
): Promise<SubscriptionWorkerResult> {
  const { prisma, redis, transport, logger } = opts;
  const now = opts.now ?? new Date();
  const lockTtl = opts.lockTtlSec ?? 60;

  // 1. Acquire distributed lock
  let acquired = false;
  try {
    const lockRes = await redis.set(LOCK_KEY, "1", "EX", lockTtl, "NX");
    acquired = lockRes === "OK";
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Redis error during worker lock acquisition");
    return { executed: false, expiredCount: 0 };
  }

  if (!acquired) {
    logger.debug("Subscription worker lock already held; skipping tick");
    return { executed: false, expiredCount: 0 };
  }

  try {
    // 2. Query expired trials and active subscriptions
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
      // 3. Update status in database
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { status: "EXPIRED" },
      });

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
    // 6. Release lock
    await redis.del(LOCK_KEY).catch(() => {});
  }
}
