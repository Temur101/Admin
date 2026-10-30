import type { BotUser, PaymentReceipt, SubStatus } from "@prisma/client";
import type { Redis } from "ioredis";
import { createBotApi, type TelegramTransport } from "../../adapters/telegram/transport.js";
import { decryptSecret } from "../../core/crypto.js";
import { env } from "../../core/env.js";
import type { Logger } from "../../core/logger.js";
import { t } from "./i18n.js";
import { safeTelegramCall } from "./telegram-errors.js";

export function formatTashkentDateTime(date: Date): string {
  const d = new Date(date.getTime() + 5 * 3600 * 1000);
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const year = d.getUTCFullYear();
  const hours = String(d.getUTCHours()).padStart(2, "0");
  const mins = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day}.${month}.${year} ${hours}:${mins}`;
}

export interface SendReceiptNotificationParams {
  receipt: PaymentReceipt & {
    bot: {
      id: string;
      botTokenEnc: string;
      users: BotUser[];
    };
  };
  redis?: Redis;
  transport?: TelegramTransport;
  logger?: Logger;
}

export async function sendReceiptApprovedNotification(
  params: SendReceiptNotificationParams,
): Promise<void> {
  const { receipt, redis, transport, logger } = params;
  if (!transport || receipt.bot.users.length === 0) return;

  const notifKey = `notif:receipt:${receipt.id}:APPROVED`;
  if (redis) {
    const lockRes = await redis.set(notifKey, "1", "EX", 86400, "NX");
    if (lockRes !== "OK") return;
  }

  let delivered = 0;
  try {
    const token = decryptSecret(receipt.bot.botTokenEnc, env.TOKEN_ENCRYPTION_KEY);
    const api = createBotApi(token, receipt.bot.id, transport);

    for (const admin of receipt.bot.users) {
      if (admin.unreachableAt) continue;
      const lang = admin.lang ?? "RU";
      const text = t(lang, "receipt_approved_push");
      const res = await safeTelegramCall(() => api.sendMessage(Number(admin.tgId), text), {
        transport,
        logger,
        botId: receipt.bot.id,
        chatId: admin.tgId,
      });
      if (res.ok) delivered++;
    }
  } catch (err) {
    logger?.error({ err: (err as Error).message }, "Failed to send approve notification");
  }
  if (delivered === 0 && redis) {
    await redis.del(notifKey).catch(() => {});
  }
}

export async function sendReceiptRejectedNotification(
  params: SendReceiptNotificationParams & {
    reason: string;
    newStatus?: SubStatus;
    rolledBackPaidUntil?: Date | null;
  },
): Promise<void> {
  const { receipt, redis, transport, logger, reason, newStatus, rolledBackPaidUntil } = params;
  if (!transport || receipt.bot.users.length === 0) return;

  const notifKey = `notif:receipt:${receipt.id}:REJECTED`;
  if (redis) {
    const lockRes = await redis.set(notifKey, "1", "EX", 86400, "NX");
    if (lockRes !== "OK") return;
  }

  let delivered = 0;
  try {
    const token = decryptSecret(receipt.bot.botTokenEnc, env.TOKEN_ENCRYPTION_KEY);
    const api = createBotApi(token, receipt.bot.id, transport);

    for (const admin of receipt.bot.users) {
      if (admin.unreachableAt) continue;
      const lang = admin.lang ?? "RU";
      let text: string;

      if (newStatus === "TRIAL") {
        text = t(lang, "receipt_rejected_trial_push", { reason });
      } else if (newStatus === "GRACE_PERIOD") {
        text = t(lang, "receipt_rejected_grace_push", { reason });
      } else if (newStatus === "BLOCKED") {
        text = t(lang, "receipt_rejected_blocked_push", {
          reason,
          support: env.SUPPORT_CONTACT,
        });
      } else {
        text = t(lang, "receipt_rejected_active_push", {
          reason,
          date: rolledBackPaidUntil ? formatTashkentDateTime(rolledBackPaidUntil) : "",
        });
      }

      const res = await safeTelegramCall(() => api.sendMessage(Number(admin.tgId), text), {
        transport,
        logger,
        botId: receipt.bot.id,
        chatId: admin.tgId,
      });
      if (res.ok) delivered++;
    }
  } catch (err) {
    logger?.error({ err: (err as Error).message }, "Failed to send reject notification");
  }
  if (delivered === 0 && redis) {
    await redis.del(notifKey).catch(() => {});
  }
}
