import type { PrismaClient } from "@prisma/client";
import { InlineKeyboard } from "grammy";
import { createBotApi, type TelegramTransport } from "../../adapters/telegram/transport.js";
import { decryptSecret } from "../../core/crypto.js";
import { env } from "../../core/env.js";
import type { Logger } from "../../core/logger.js";
import { t } from "./i18n.js";
import { maskName, maskPhone } from "./masking.js";
import { isMaskedStatus } from "./subscription.js";
import { getQuickBookConfig } from "../quickbook/config-resolver.js";
import { safeTelegramCall } from "./telegram-errors.js";

export interface LeadNotificationRef {
  chatId: number;
  messageId: number;
  lang: "RU" | "UZ";
}

export interface LeadNotifyPayload {
  kind: "LEAD";
  leadId?: string;
  name?: string | null;
  phone: string;
  phoneVerified?: boolean;
  username?: string | null;
  answers: Record<string, unknown>;
}

export interface BookingNotifyPayload {
  kind: "BOOKING";
  name?: string | null;
  phone: string;
  phoneVerified?: boolean;
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
  phoneVerified?: boolean;
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
  phoneVerified?: boolean;
  service: string;
  staff: string;
  time: string;
  serviceId?: string;
  staffId?: string;
}

export interface BookingRescheduledNotifyPayload {
  kind: "BOOKING_RESCHEDULED";
  name?: string | null;
  phone: string;
  phoneVerified?: boolean;
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
  | BookingCancelledNotifyPayload
  | BookingRescheduledNotifyPayload;

import { textChunks, formatLeadNotificationText } from "./notification-formatter.js";
export { formatLeadNotificationText };

export interface NotifyAdminsOptions {
  prisma: PrismaClient;
  transport: TelegramTransport;
  logger: Logger;
  recipientTgId?: bigint;
}

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

  const eligibleUsers = bot.users.filter((u) => {
    if (opts.recipientTgId != null && u.tgId !== opts.recipientTgId) return false;
    if (u.unreachableAt) return false;
    if (payload.kind === "LEAD" && u.receivesLeads === false) return false;
    return true;
  });

  if (eligibleUsers.length === 0) {
    return 0;
  }

  const subStatus = bot.subscription?.status ?? "TRIAL";
  const masked = isMaskedStatus(subStatus);

  const token = decryptSecret(bot.botTokenEnc, env.TOKEN_ENCRYPTION_KEY);
  const api = createBotApi(token, bot.id, transport);

  let sentCount = 0;
  const leadRefs: LeadNotificationRef[] = [];

  for (const admin of eligibleUsers) {
    const lang = (admin.lang ?? "RU") as "RU" | "UZ";
    let text: string;

    if (payload.kind === "LEAD") {
      text = formatLeadNotificationText({
        lang,
        masked,
        name: payload.name,
        phone: payload.phone,
        phoneVerified: payload.phoneVerified,
        username: payload.username,
        answers: payload.answers,
        statusLine: payload.leadId ? `Статус: ${t(lang, "lead_status_new")}` : undefined,
      });
    } else {
      let serviceDisplay = payload.service;
      let staffDisplay = payload.staff;
      if (bot.settings && (payload.serviceId || payload.staffId)) {
        const config = getQuickBookConfig(
          bot.settings as Record<string, unknown> | null | undefined,
        );
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
            : payload.kind === "BOOKING_RESCHEDULED"
              ? "booking_rescheduled_notification_open"
              : "booking_notification_open";
      const maskedKey =
        payload.kind === "BOOKING_CONFIRMED"
          ? "booking_confirmed_notification_masked"
          : payload.kind === "BOOKING_CANCELLED"
            ? "booking_cancelled_notification_masked"
            : payload.kind === "BOOKING_RESCHEDULED"
              ? "booking_rescheduled_notification_masked"
              : "booking_notification_masked";

      const verifiedSuffix =
        payload.phoneVerified === undefined
          ? ""
          : ` (${t(lang, payload.phoneVerified ? "phone_verified_badge" : "phone_unverified_badge")})`;

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
          phone: `${payload.phone}${verifiedSuffix}`,
          service: serviceDisplay,
          staff: staffDisplay,
          time: payload.time,
        });
      }
    }

    const keyboard = new InlineKeyboard();
    if (payload.kind === "LEAD" && payload.leadId && !masked) {
      keyboard.text(t(lang, "btn_take_lead"), `lead:take:${payload.leadId}`).row();
    }
    if (masked && subStatus !== "BLOCKED" && admin.role !== "STAFF") {
      keyboard.text(t(lang, "btn_pay"), "admin:pay");
    }

    const chunks = textChunks(text);
    let lastMsgId: number | undefined;
    let adminDelivered = true;

    for (let index = 0; index < chunks.length; index++) {
      const callRes = await safeTelegramCall(
        () =>
          api.sendMessage(Number(admin.tgId), chunks[index]!, {
            reply_markup:
              index === chunks.length - 1 && keyboard.inline_keyboard.length > 0
                ? keyboard
                : undefined,
          }),
        {
          prisma,
          botId,
          chatId: admin.tgId,
          logger,
          transport,
        },
      );

      if (!callRes.ok) {
        adminDelivered = false;
        logger.error(
          {
            err: callRes.error.description,
            errorKind: callRes.error.kind,
            botId,
            adminTgId: String(admin.tgId),
          },
          "Failed to send admin notification",
        );
        break;
      }
      lastMsgId = callRes.result.message_id;
    }

    if (adminDelivered) {
      sentCount++;
      if (payload.kind === "LEAD" && payload.leadId && lastMsgId !== undefined) {
        leadRefs.push({
          chatId: Number(admin.tgId),
          messageId: lastMsgId,
          lang,
        });
      }
    }
  }

  if (payload.kind === "LEAD" && payload.leadId && leadRefs.length > 0 && prisma.lead?.update) {
    const previous = await prisma.lead.findUnique({ where: { id: payload.leadId } });
    const oldRefs = Array.isArray(previous?.notificationRefs) ? previous.notificationRefs as unknown as LeadNotificationRef[] : [];
    const mergedRefs = [...oldRefs.filter(r => !leadRefs.some(n => n.chatId === r.chatId)), ...leadRefs];
    await prisma.lead
      .update({
        where: { id: payload.leadId },
        data: { notificationRefs: mergedRefs as unknown as object },
      })
      .catch(() => {});
  }

  return sentCount;
}
