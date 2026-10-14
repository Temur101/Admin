import type { Lang, PrismaClient } from "@prisma/client";
import { InlineKeyboard, Keyboard } from "grammy";
import type { ResolvedBot } from "../../gateway/types.js";
import { t, type TranslationKey } from "./i18n.js";
import { maskName, maskPhone } from "./masking.js";
import { isMaskedStatus } from "./subscription.js";

export function buildAdminReplyKeyboard(
  lang: Lang | null | undefined,
  botType?: "LEADCATCH" | "QUICKBOOK",
): Keyboard {
  const l = lang ?? "RU";
  const kb = new Keyboard();
  if (botType === "QUICKBOOK") {
    kb.text(l === "UZ" ? "📅 Buyurtmalar" : "📅 Записи")
      .text(l === "UZ" ? "➕ Mijozni yozish" : "➕ Записать клиента")
      .row();
  } else {
    kb.text(t(l, "admin_menu_leads")).row();
  }
  return kb
    .text(t(l, "admin_menu_sub"))
    .text(t(l, "admin_menu_lang"))
    .resized();
}

export function buildLanguageInlineKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🇷🇺 Русский", "set_lang:RU")
    .text("🇺🇿 O'zbekcha", "set_lang:UZ");
}

import { env } from "../../core/env.js";

export interface PlatformTariffs {
  tariff1m: number;
  tariff6m: number;
  tariff12m: number;
}

export function resolveTariffPrices(settings?: { tariffs?: unknown } | null): PlatformTariffs {
  const rawTariffs = settings?.tariffs;
  if (Array.isArray(rawTariffs)) {
    const t1 = rawTariffs.find(
      (t) => t && typeof t === "object" && (t as { months?: number }).months === 1,
    ) as { amountUzs?: number } | undefined;
    const t6 = rawTariffs.find(
      (t) => t && typeof t === "object" && (t as { months?: number }).months === 6,
    ) as { amountUzs?: number } | undefined;
    const t12 = rawTariffs.find(
      (t) => t && typeof t === "object" && (t as { months?: number }).months === 12,
    ) as { amountUzs?: number } | undefined;

    return {
      tariff1m: typeof t1?.amountUzs === "number" ? t1.amountUzs : env.TARIFF_1M_UZS,
      tariff6m: typeof t6?.amountUzs === "number" ? t6.amountUzs : env.TARIFF_6M_UZS,
      tariff12m: typeof t12?.amountUzs === "number" ? t12.amountUzs : env.TARIFF_12M_UZS,
    };
  }

  const custom = rawTariffs as Record<string, unknown> | undefined;
  const t1 =
    typeof custom?.["1m"] === "number"
      ? custom["1m"]
      : typeof custom?.tariff1m === "number"
        ? custom.tariff1m
        : env.TARIFF_1M_UZS;
  const t6 =
    typeof custom?.["6m"] === "number"
      ? custom["6m"]
      : typeof custom?.tariff6m === "number"
        ? custom.tariff6m
        : env.TARIFF_6M_UZS;
  const t12 =
    typeof custom?.["12m"] === "number"
      ? custom["12m"]
      : typeof custom?.tariff12m === "number"
        ? custom.tariff12m
        : env.TARIFF_12M_UZS;

  return {
    tariff1m: t1,
    tariff6m: t6,
    tariff12m: t12,
  };
}

export function buildTariffInlineKeyboard(
  lang: Lang | null | undefined,
  tariffs?: PlatformTariffs,
): InlineKeyboard {
  const l = lang ?? "RU";
  const resolved = tariffs ?? resolveTariffPrices(null);
  const fmt = (n: number) => n.toLocaleString("ru-RU").replace(/\u00A0/g, " ");

  return new InlineKeyboard()
    .text(t(l, "btn_pay_tariff_1m", { amount: fmt(resolved.tariff1m) }), "pay:tariff:1")
    .row()
    .text(t(l, "btn_pay_tariff_6m", { amount: fmt(resolved.tariff6m) }), "pay:tariff:6")
    .row()
    .text(t(l, "btn_pay_tariff_12m", { amount: fmt(resolved.tariff12m) }), "pay:tariff:12");
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
