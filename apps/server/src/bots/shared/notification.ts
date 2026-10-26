import type { PrismaClient } from "@prisma/client";
import { InlineKeyboard } from "grammy";
import { createBotApi, type TelegramTransport } from "../../adapters/telegram/transport.js";
import { decryptSecret } from "../../core/crypto.js";
import { env } from "../../core/env.js";
import type { Logger } from "../../core/logger.js";
import { t } from "./i18n.js";
import { maskName, maskPhone, maskUsername } from "./masking.js";
import { isMaskedStatus } from "./subscription.js";
import { getQuickBookConfig } from "../quickbook/config-resolver.js";

export interface LeadNotifyPayload {
  kind: "LEAD";
  name?: string | null;
  phone: string;
  username?: string | null;
  answers: Record<string, unknown>;
}

export interface BookingNotifyPayload {
  kind: "BOOKING";
  name?: string | null;
  phone: string;
  service: string;
  staff: string;
  time: string;
  serviceId?: string;
  staffId?: string;
}

export interface BookingConfirmedNotifyPayload {
  kind: "BOOKING_CONFIRMED";
  name?: string | null;
  phone: string;
  service: string;
  staff: string;
  time: string;
  serviceId?: string;
  staffId?: string;
}

export interface BookingCancelledNotifyPayload {
  kind: "BOOKING_CANCELLED";
  name?: string | null;
  phone: string;
  service: string;
  staff: string;
  time: string;
  serviceId?: string;
  staffId?: string;
}

export type AdminNotifyPayload =
  | LeadNotifyPayload
  | BookingNotifyPayload
  | BookingConfirmedNotifyPayload
  | BookingCancelledNotifyPayload;

export interface NotifyAdminsOptions {
  prisma: PrismaClient;
  transport: TelegramTransport;
  logger: Logger;
}

// Telegram limits plain text messages to 4096 characters. Preserve full answers and Unicode.
function textChunks(text: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of text) {
    if (chunk.length + character.length > 4000) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

/**
 * Sends a new lead or booking notification to all registered administrators of the bot.
 * Automatically masks sensitive customer data if the subscription is EXPIRED, GRACE_PERIOD, or BLOCKED.
 */
export async function notifyAdmins(
  botId: string,
  payload: AdminNotifyPayload,
  opts: NotifyAdminsOptions,
): Promise<number> {
  const { prisma, transport, logger } = opts;

  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    include: {
      subscription: true,
      users: { where: { isAdmin: true } },
    },
  });

  if (!bot || bot.users.length === 0) {
    return 0;
  }

  const subStatus = bot.subscription?.status ?? "TRIAL";
  const masked = isMaskedStatus(subStatus);

  const token = decryptSecret(bot.botTokenEnc, env.TOKEN_ENCRYPTION_KEY);
  const api = createBotApi(token, bot.id, transport);

  let sentCount = 0;

  for (const admin of bot.users) {
    const lang = admin.lang ?? "RU";
    let text: string;

    if (payload.kind === "LEAD") {
      const answersStr = Object.entries(payload.answers)
        .map(([q, a]) => `• ${q}: ${String(a)}`)
        .join("\n");

      if (masked) {
        text = t(lang, "lead_notification_masked", {
          name: maskName(payload.name),
          phone: maskPhone(payload.phone),
          username: maskUsername(payload.username),
          answers: answersStr,
        });
      } else {
        text = t(lang, "lead_notification_open", {
          name: payload.name || "—",
          phone: payload.phone,
          username: payload.username ? `@${payload.username}` : "—",
          answers: answersStr,
        });
      }
    } else {
      let serviceDisplay = payload.service;
      let staffDisplay = payload.staff;
      if (bot.settings && (payload.serviceId || payload.staffId)) {
        const config = getQuickBookConfig(bot.settings as Record<string, unknown> | null | undefined);
        const loc = lang === "UZ" ? "uz" : "ru";
        if (payload.serviceId) {
          const srv = config.services.find((s) => s.id === payload.serviceId);
          if (srv?.name[loc]) serviceDisplay = srv.name[loc];
        }
        if (payload.staffId) {
          const res = config.resources.find((r) => r.id === payload.staffId);
          if (res?.name[loc]) staffDisplay = res.name[loc];
        }
      }

      const openKey =
        payload.kind === "BOOKING_CONFIRMED"
          ? "booking_confirmed_notification_open"
          : payload.kind === "BOOKING_CANCELLED"
            ? "booking_cancelled_notification_open"
            : "booking_notification_open";
      const maskedKey =
        payload.kind === "BOOKING_CONFIRMED"
          ? "booking_confirmed_notification_masked"
          : payload.kind === "BOOKING_CANCELLED"
            ? "booking_cancelled_notification_masked"
            : "booking_notification_masked";

      if (masked) {
        text = t(lang, maskedKey, {
          name: maskName(payload.name),
          phone: maskPhone(payload.phone),
          service: serviceDisplay,
          staff: staffDisplay,
          time: payload.time,
        });
      } else {
        text = t(lang, openKey, {
          name: payload.name || "—",
          phone: payload.phone,
          service: serviceDisplay,
          staff: staffDisplay,
          time: payload.time,
        });
      }
    }

    const keyboard = new InlineKeyboard();
    if (masked && subStatus !== "BLOCKED") {
      keyboard.text(t(lang, "btn_pay"), "admin:pay");
    }

    try {
      const chunks = textChunks(text);
      for (let index = 0; index < chunks.length; index++) {
        await api.sendMessage(Number(admin.tgId), chunks[index]!, {
          reply_markup:
            index === chunks.length - 1 && keyboard.inline_keyboard.length > 0
              ? keyboard
              : undefined,
        });
      }
      sentCount++;
    } catch (err) {
      logger.error(
        { err: (err as Error).message, botId, adminTgId: String(admin.tgId) },
        "Failed to send admin notification",
      );
    }
  }

  return sentCount;
}
