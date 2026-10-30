import { escapeTelegramHtml as html } from "./telegram-text.js";
import type { PrismaClient } from "@prisma/client";
import {
  createBotApi,
  createRealTelegramTransport,
  type TelegramTransport,
} from "../adapters/telegram/transport.js";
import { decryptSecret } from "./crypto.js";
import { env } from "./env.js";
import type { Logger } from "./logger.js";

export type PlatformEvent =
  | {
      type: "NEW_RECEIPT";
      botName: string;
      clientName: string;
      phone: string;
      tariffMonths: number;
      amountUzs: number;
      receiptId: string;
    }
  | {
      type: "BOT_REGISTERED";
      botType: string;
      clientName: string;
      botUsername?: string | null;
      botId: string;
    }
  | {
      type: "BOT_BLOCKED" | "DELIVERY_FAILED";
      botName: string;
      reason: string;
    };

export interface PlatformNotifierOptions {
  prisma: PrismaClient;
  transport?: TelegramTransport;
  logger?: Logger;
}

export async function notifyPlatformOwner(
  event: PlatformEvent,
  opts: PlatformNotifierOptions,
): Promise<boolean> {
  const { prisma, transport, logger } = opts;

  try {
    const settings = await prisma.platformSettings.findUnique({
      where: { id: 1 },
    });

    let token = env.ALERT_BOT_TOKEN;
    if (settings?.alertBotTokenEnc) {
      try {
        token = decryptSecret(settings.alertBotTokenEnc, env.TOKEN_ENCRYPTION_KEY);
      } catch (err) {
        logger?.warn({ err: (err as Error).message }, "Failed to decrypt alert bot token from settings");
      }
    }

    const chatIdStr = settings?.alertChatId ? String(settings.alertChatId) : env.ALERT_CHAT_ID;
    if (!token || !chatIdStr) {
      logger?.debug("Platform Alert Bot token or chatId not configured, skipping alert");
      return false;
    }

    const chatId: number | string = /^-?\d+$/.test(chatIdStr) ? Number(chatIdStr) : chatIdStr;
    const activeTransport = transport ?? createRealTelegramTransport();
    const api = createBotApi(token, "platform-alert-bot", activeTransport);
    const adminOrigin = env.ADMIN_ORIGIN || "http://localhost:5173";

    let message = "";
    if (event.type === "NEW_RECEIPT") {
      const amountFmt = event.amountUzs.toLocaleString("ru-RU").replace(/\u00A0/g, " ");
      message =
        `🔔 <b>Новый чек на проверку!</b>\n\n` +
        `🤖 <b>Бот:</b> ${html(event.botName)}\n` +
        `👤 <b>Клиент:</b> ${html(event.clientName)} (${html(event.phone)})\n` +
        `💳 <b>Тариф:</b> ${event.tariffMonths} мес — ${amountFmt} сум\n\n` +
        `🔗 <a href="${html(adminOrigin)}/receipts">Открыть в веб-админке</a>`;
    } else if (event.type === "BOT_REGISTERED") {
      message =
        `🤖 <b>Создан новый бот!</b>\n\n` +
        `🏷 <b>Тип:</b> ${html(event.botType)}\n` +
        `🏢 <b>Организация:</b> ${html(event.clientName)}\n` +
        (event.botUsername ? `💬 <b>Username:</b> @${html(event.botUsername)}\n\n` : `\n`) +
        `🔗 <a href="${html(adminOrigin)}/bots/${html(event.botId)}">Карточка бота в админке</a>`;
    } else if (event.type === "BOT_BLOCKED" || event.type === "DELIVERY_FAILED") {
      message =
        (event.type === "BOT_BLOCKED" ? `🚫 <b>Бот заблокирован!</b>\n\n` : `⚠️ <b>Ошибка доставки уведомления</b>\n\n`) +
        `🤖 <b>Бот:</b> ${html(event.botName)}\n` +
        `⚠️ <b>Причина:</b> ${html(event.reason)}`;
    }

    await api.sendMessage(chatId, message, { parse_mode: "HTML" });
    return true;
  } catch (err) {
    logger?.error({ err: (err as Error).message }, "Failed to send platform owner alert");
    return false;
  }
}
