import type { Lang, PrismaClient } from "@prisma/client";
import { InlineKeyboard, Keyboard } from "grammy";
import type { ResolvedBot } from "../../gateway/types.js";
import { t, type TranslationKey } from "./i18n.js";
import { maskName, maskPhone } from "./masking.js";
import { isMaskedStatus } from "./subscription.js";

export function buildAdminReplyKeyboard(lang: Lang | null | undefined): Keyboard {
  const l = lang ?? "RU";
  return new Keyboard()
    .text(t(l, "admin_menu_leads"))
    .row()
    .text(t(l, "admin_menu_sub"))
    .text(t(l, "admin_menu_lang"))
    .resized();
}

export function buildLanguageInlineKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🇷🇺 Русский", "set_lang:RU")
    .text("🇺🇿 O'zbekcha", "set_lang:UZ");
}

export function buildTariffInlineKeyboard(lang: Lang | null | undefined): InlineKeyboard {
  const l = lang ?? "RU";
  return new InlineKeyboard()
    .text(t(l, "btn_pay_tariff_1m", { amount: "100 000" }), "pay:tariff:1")
    .row()
    .text(t(l, "btn_pay_tariff_6m", { amount: "500 000" }), "pay:tariff:6")
    .row()
    .text(t(l, "btn_pay_tariff_12m", { amount: "1 000 000" }), "pay:tariff:12");
}

export function formatSubscriptionStatusText(
  botMeta: ResolvedBot,
  lang: Lang | null | undefined,
): { text: string; keyboard: InlineKeyboard } {
  const l = lang ?? "RU";
  const status = botMeta.subscriptionStatus;

  let statusKey: TranslationKey;
  let dateStr = "—";

  if (status === "TRIAL") {
    statusKey = "sub_status_trial";
    dateStr = new Date(botMeta.trialEndsAt).toLocaleDateString("ru-RU");
  } else if (status === "ACTIVE") {
    statusKey = "sub_status_active";
    dateStr = botMeta.paidUntil
      ? new Date(botMeta.paidUntil).toLocaleDateString("ru-RU")
      : new Date(botMeta.trialEndsAt).toLocaleDateString("ru-RU");
  } else if (status === "EXPIRED") {
    statusKey = "sub_status_expired";
  } else if (status === "GRACE_PERIOD") {
    statusKey = "sub_status_grace";
  } else {
    statusKey = "sub_status_blocked";
  }

  const statusLabel = t(l, statusKey, { date: dateStr });
  const text = t(l, "sub_info", { status: statusLabel, date: dateStr });

  const keyboard = new InlineKeyboard();
  if (status !== "BLOCKED") {
    keyboard.text(t(l, "btn_pay"), "admin:pay");
  }

  return { text, keyboard };
}

export async function fetchRecentEntriesText(
  prisma: PrismaClient,
  botMeta: ResolvedBot,
  lang: Lang | null | undefined,
): Promise<string> {
  const l = lang ?? "RU";
  const isMasked = isMaskedStatus(botMeta.subscriptionStatus);

  if (botMeta.botType === "LEADCATCH") {
    const leads = await prisma.lead.findMany({
      where: { botId: botMeta.id },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    if (leads.length === 0) {
      return t(l, "recent_entries_empty");
    }

    const items = leads.map((lead, idx) => {
      const date = lead.createdAt.toLocaleDateString("ru-RU");
      const name = isMasked ? maskName(lead.customerName) : lead.customerName || "—";
      const phone = isMasked ? maskPhone(lead.phoneRaw) : lead.phoneRaw;
      return `${idx + 1}. [${date}] ${name} | ${phone}`;
    });

    return `${t(l, "recent_entries_title")}\n\n${items.join("\n")}`;
  }

  const bookings = await prisma.booking.findMany({
    where: { botId: botMeta.id },
    orderBy: { slotTime: "desc" },
    take: 20,
  });

  if (bookings.length === 0) {
    return t(l, "recent_entries_empty");
  }

  const items = bookings.map((b, idx) => {
    const time = b.slotTime.toLocaleDateString("ru-RU");
    const name = isMasked ? maskName(b.customerName) : b.customerName || "—";
    const phone = isMasked ? maskPhone(b.customerPhone) : b.customerPhone;
    return `${idx + 1}. [${time}] ${b.serviceName} (${b.staffId}): ${name} | ${phone}`;
  });

  return `${t(l, "recent_entries_title")}\n\n${items.join("\n")}`;
}
