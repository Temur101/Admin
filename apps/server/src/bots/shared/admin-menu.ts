import type { BotAdminRole, Lang, LeadStatus, PrismaClient } from "@prisma/client";
import { InlineKeyboard, Keyboard } from "grammy";
import type { ResolvedBot } from "../../gateway/types.js";
import { t, type TranslationKey } from "./i18n.js";
import { maskName, maskPhone } from "./masking.js";
import { isMaskedStatus } from "./subscription.js";
import { platformTariffs } from "../../core/platform-tariffs.js";

export function buildAdminReplyKeyboard(
  lang: Lang | null | undefined,
  botType?: "LEADCATCH" | "QUICKBOOK",
  role?: BotAdminRole | null,
): Keyboard {
  const l = lang ?? "RU";
  const kb = new Keyboard();
  if (botType === "QUICKBOOK") {
    kb.text(l === "UZ" ? "📅 Buyurtmalar" : "📅 Записи")
      .text(l === "UZ" ? "➕ Mijozni yozish" : "➕ Записать клиента")
      .row();
    if (role !== "STAFF") {
      kb.text(l === "UZ" ? "🔒 Blokirovkalar" : "🔒 Блокировки")
        .text(l === "UZ" ? "⚙️ Sozlamalar" : "⚙️ Настройки")
        .row();
    }
  } else {
    kb.text(t(l, "admin_menu_leads")).row();
  }
  if (role !== "STAFF") {
    kb.text(t(l, "admin_menu_sub"));
  }
  return kb.text(t(l, "admin_menu_lang")).resized();
}

export function buildLanguageInlineKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("🇷🇺 Русский", "set_lang:RU").text("🇺🇿 O'zbekcha", "set_lang:UZ");
}

export interface PlatformTariffs {
  tariff1m: number;
  tariff6m: number;
  tariff12m: number;
}

export function resolveTariffPrices(settings?: { tariffs?: unknown } | null): PlatformTariffs {
  const [one, six, twelve] = platformTariffs(settings?.tariffs);
  return { tariff1m: one!.amountUzs, tariff6m: six!.amountUzs, tariff12m: twelve!.amountUzs };
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

export function formatLeadStatusLabel(status: LeadStatus | undefined, lang: Lang): string {
  switch (status) {
    case "IN_PROGRESS":
      return t(lang, "lead_status_in_progress");
    case "DONE":
      return t(lang, "lead_status_done");
    case "REJECTED":
      return t(lang, "lead_status_rejected");
    default:
      return t(lang, "lead_status_new");
  }
}

export interface AdminEntriesViewOptions {
  statusFilter?: LeadStatus;
  isOwner?: boolean;
  receivesLeads?: boolean;
}

export async function buildAdminEntriesView(
  prisma: PrismaClient,
  botMeta: ResolvedBot,
  lang: Lang | null | undefined,
  opts?: AdminEntriesViewOptions,
): Promise<{ text: string; keyboard?: InlineKeyboard }> {
  const l = lang ?? "RU";
  const text = await fetchRecentEntriesText(prisma, botMeta, l, opts);

  if (botMeta.botType !== "LEADCATCH") {
    return { text };
  }

  const kb = new InlineKeyboard()
    .text(l === "UZ" ? "Barchasi" : "Все", "admin:leads:ALL")
    .text("🆕", "admin:leads:NEW")
    .text("⏳", "admin:leads:IN_PROGRESS")
    .text("✅", "admin:leads:DONE")
    .text("❌", "admin:leads:REJECTED");

  if (opts?.isOwner) {
    kb.row().text(
      opts.receivesLeads !== false ? t(l, "btn_toggle_leads_on") : t(l, "btn_toggle_leads_off"),
      "admin:toggle_leads",
    );
  }

  return { text, keyboard: kb };
}

export async function fetchRecentEntriesText(
  prisma: PrismaClient,
  botMeta: ResolvedBot,
  lang: Lang | null | undefined,
  opts?: AdminEntriesViewOptions,
): Promise<string> {
  const l = lang ?? "RU";
  const isMasked = isMaskedStatus(botMeta.subscriptionStatus);

  if (botMeta.botType === "LEADCATCH") {
    const leads = await prisma.lead.findMany({
      where: {
        botId: botMeta.id,
        ...(opts?.statusFilter ? { status: opts.statusFilter } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    });

    if (leads.length === 0) {
      return t(l, "recent_entries_empty");
    }

    const assigneeIds = Array.from(
      new Set(leads.map((item) => item.assigneeTgId).filter((v): v is bigint => v != null)),
    );
    const assignees =
      assigneeIds.length > 0 && prisma.botUser?.findMany
        ? await prisma.botUser.findMany({
            where: { botId: botMeta.id, tgId: { in: assigneeIds } },
          })
        : [];
    const assigneeMap = new Map(
      assignees.map((u) => [
        u.tgId.toString(),
        u.firstName || (u.username ? `@${u.username}` : u.tgId.toString()),
      ]),
    );

    const items = leads.map((lead, idx) => {
      const date = lead.createdAt.toLocaleDateString("ru-RU");
      const name = isMasked ? maskName(lead.customerName) : lead.customerName || "—";
      const phone = isMasked ? maskPhone(lead.phoneRaw) : lead.phoneRaw;
      const verified = lead.phoneVerified ? "✓" : "✎";
      const statusStr = formatLeadStatusLabel(lead.status, l);
      const assigneeStr = lead.assigneeTgId
        ? ` | 👤 ${assigneeMap.get(lead.assigneeTgId.toString()) ?? lead.assigneeTgId.toString()}`
        : "";
      return `${idx + 1}. [${date}] ${statusStr} | ${name} | ${phone} (${verified})${assigneeStr}`;
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
    const verified = b.phoneVerified ? "✓" : "✎";
    return `${idx + 1}. [${time}] ${b.serviceName} (${b.staffId}): ${name} | ${phone} (${verified})`;
  });

  return `${t(l, "recent_entries_title")}\n\n${items.join("\n")}`;
}
