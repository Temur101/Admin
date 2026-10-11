import type { BotUser, PaymentReceipt, SubStatus } from "@prisma/client";
import type { Redis } from "ioredis";
import { createBotApi, type TelegramTransport } from "../../adapters/telegram/transport.js";
import { decryptSecret } from "../../core/crypto.js";
import { env } from "../../core/env.js";
import type { Logger } from "../../core/logger.js";
import { t } from "./i18n.js";

export function formatTashkentDateTime(date: Date): string {
  // Format as DD.MM.YYYY HH:mm in Tashkent time (UTC+5)
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

  let shouldSend = true;
  if (redis) {
    const notifKey = `notif:receipt:${receipt.id}:APPROVED`;
    const lockRes = await redis.set(notifKey, "1", "EX", 86400, "NX");
    shouldSend = lockRes === "OK";
  }

  if (shouldSend) {
    try {
      const token = decryptSecret(receipt.bot.botTokenEnc, env.TOKEN_ENCRYPTION_KEY);
      const api = createBotApi(token, receipt.bot.id, transport);

      for (const admin of receipt.bot.users) {
        const lang = admin.lang ?? "RU";
        const text = t(lang, "receipt_approved_push");
        await api.sendMessage(Number(admin.tgId), text).catch(() => {});
      }
    } catch (err) {
      logger?.error({ err: (err as Error).message }, "Failed to send approve notification");
    }
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

  let shouldSend = true;
  if (redis) {
    const notifKey = `notif:receipt:${receipt.id}:REJECTED`;
    const lockRes = await redis.set(notifKey, "1", "EX", 86400, "NX");
    shouldSend = lockRes === "OK";
  }

  if (shouldSend) {
    try {
      const token = decryptSecret(receipt.bot.botTokenEnc, env.TOKEN_ENCRYPTION_KEY);
      const api = createBotApi(token, receipt.bot.id, transport);

      for (const admin of receipt.bot.users) {
        const lang = admin.lang ?? "RU";
        let text: string;

        if (newStatus === "GRACE_PERIOD") {
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

        await api.sendMessage(Number(admin.tgId), text).catch(() => {});
      }
    } catch (err) {
      logger?.error({ err: (err as Error).message }, "Failed to send reject notification");
    }
  }
}
