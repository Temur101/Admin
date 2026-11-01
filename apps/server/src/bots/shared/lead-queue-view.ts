import type { Lang, LeadStatus, PrismaClient } from "@prisma/client";
import { InlineKeyboard } from "grammy";
import type { ResolvedBot } from "../../gateway/types.js";
import { t } from "./i18n.js";
import { formatLeadStatusLabel } from "./lead-status.js";
import { maskName, maskPhone } from "./masking.js";
import { isMaskedStatus } from "./subscription.js";

export const LEAD_FILTERS = {
  N: "NEW",
  W: "IN_PROGRESS",
  D: "DONE",
  R: "REJECTED",
  A: "ALL",
} as const;
export type LeadFilter = keyof typeof LEAD_FILTERS;
export interface LeadQueueOptions {
  statusFilter?: LeadStatus | "ALL";
  page?: number;
  isOwner?: boolean;
  receivesLeads?: boolean;
}
const PAGE_SIZE = 5;
const line = (value: unknown, limit = 80) =>
  Array.from(String(value ?? "—").replace(/[\r\n\t]/g, " "))
    .slice(0, limit)
    .join("");

export function leadFilterCode(status: LeadStatus | "ALL"): LeadFilter {
  return (
    (Object.keys(LEAD_FILTERS) as LeadFilter[]).find((code) => LEAD_FILTERS[code] === status) ?? "N"
  );
}

export async function buildLeadQueueView(
  prisma: PrismaClient,
  bot: ResolvedBot,
  lang: Lang,
  opts: LeadQueueOptions = {},
) {
  const status = opts.statusFilter ?? "NEW";
  const filter = leadFilterCode(status);
  const { leads, counts, page, pages, total, users } = await prisma.$transaction(
    async (tx) => {
      const groups = await tx.lead.groupBy({
        by: ["status"],
        where: { botId: bot.id },
        _count: { _all: true },
      });
      const counts: Record<LeadStatus, number> = { NEW: 0, IN_PROGRESS: 0, DONE: 0, REJECTED: 0 };
      for (const group of groups) counts[group.status] = group._count._all;
      const total =
        status === "ALL" ? Object.values(counts).reduce((a, b) => a + b, 0) : counts[status];
      const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      const requested = Number.isSafeInteger(opts.page) && opts.page! >= 0 ? opts.page! : 0;
      const page = Math.min(requested, pages - 1);
      const leads = await tx.lead.findMany({
        where: { botId: bot.id, ...(status !== "ALL" ? { status } : {}) },
        orderBy:
          status === "NEW" || status === "IN_PROGRESS"
            ? [{ createdAt: "asc" }, { id: "asc" }]
            : [{ createdAt: "desc" }, { id: "desc" }],
        take: PAGE_SIZE,
        skip: page * PAGE_SIZE,
      });
      const ids = Array.from(
        new Set(leads.flatMap((lead) => (lead.assigneeTgId ? [lead.assigneeTgId] : []))),
      );
      const users = ids.length
        ? await tx.botUser.findMany({
            where: { botId: bot.id, tgId: { in: ids } },
            select: { tgId: true, firstName: true, username: true },
          })
        : [];
      return { leads, counts, page, pages, total, users };
    },
    { isolationLevel: "RepeatableRead" },
  );
  const masked = isMaskedStatus(bot.subscriptionStatus);
  const heading =
    status === "ALL" ? t(lang, "lead_queue_all") : formatLeadStatusLabel(status, lang);
  const lines = [
    t(lang, "lead_queue_title", { status: heading }),
    t(lang, "lead_queue_page", { count: total, page: page + 1, pages }),
    "",
  ];
  const keyboard = new InlineKeyboard();
  for (const [i, lead] of leads.entries()) {
    const number = page * PAGE_SIZE + i + 1;
    const name = line(masked ? maskName(lead.customerName) : lead.customerName);
    const phone = masked ? maskPhone(lead.phoneRaw) : line(lead.phoneRaw, 50);
    const date = new Intl.DateTimeFormat(lang === "UZ" ? "uz-UZ" : "ru-RU", {
      timeZone: "Asia/Tashkent",
      dateStyle: "short",
      timeStyle: "short",
    }).format(lead.createdAt);
    lines.push(
      `${number}. ${name} | ${phone}`,
      formatLeadStatusLabel(lead.status, lang),
      t(lang, "lead_queue_created", { date }),
    );
    if (lead.assigneeTgId) {
      const user = users.find((u) => u.tgId === lead.assigneeTgId);
      lines.push(
        t(lang, "lead_taken_by", {
          assignee: line(user?.firstName || user?.username || lead.assigneeTgId.toString()),
        }),
      );
    }
    keyboard
      .text(
        t(lang, "lead_queue_open", { number, name: line(name, 24) }),
        `lq:open:${lead.id}:${filter}:${page}`,
      )
      .row();
  }
  if (!leads.length) lines.push(t(lang, "lead_queue_empty"));
  const labels: Record<LeadFilter, string> = {
    N: t(lang, "lead_queue_new"),
    W: t(lang, "lead_queue_work"),
    D: t(lang, "lead_queue_done"),
    R: t(lang, "lead_queue_rejected"),
    A: t(lang, "lead_queue_all"),
  };
  for (const [i, code] of (Object.keys(LEAD_FILTERS) as LeadFilter[]).entries()) {
    const count =
      code === "A"
        ? Object.values(counts).reduce((a, b) => a + b, 0)
        : counts[LEAD_FILTERS[code] as LeadStatus];
    keyboard.text(`${labels[code]} (${count})`, `lq:list:${code}:0`);
    if (i % 2 === 1 || code === "A") keyboard.row();
  }
  if (page > 0) keyboard.text(t(lang, "lead_queue_previous"), `lq:list:${filter}:${page - 1}`);
  keyboard.text(t(lang, "lead_queue_refresh"), `lq:list:${filter}:${page}`);
  if (page + 1 < pages) keyboard.text(t(lang, "lead_queue_next"), `lq:list:${filter}:${page + 1}`);
  if (opts.isOwner)
    keyboard
      .row()
      .text(
        t(lang, opts.receivesLeads !== false ? "btn_toggle_leads_on" : "btn_toggle_leads_off"),
        "admin:toggle_leads",
      );
  return { text: lines.join("\n"), keyboard };
}
