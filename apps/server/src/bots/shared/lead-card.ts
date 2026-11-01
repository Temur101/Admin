import type { Lang, Lead, PrismaClient } from "@prisma/client";
import { InlineKeyboard } from "grammy";
import type { PlatformBotContext } from "../../gateway/types.js";
import { t } from "./i18n.js";
import { formatLeadStatusLabel } from "./lead-status.js";
import { formatLeadNotificationText, textChunks } from "./notification-formatter.js";
import type { LeadNotificationRef } from "./notification.js";
import { isMaskedStatus } from "./subscription.js";

function extractAnswers(raw: unknown): Record<string, string> {
  const answers: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return answers;
  for (const [key, value] of Object.entries(raw)) {
    if (value && typeof value === "object" && "answer" in value) {
      const item = value as { question?: string; answer: unknown };
      answers[item.question || key] = String(item.answer ?? "");
    } else answers[key] = String(value ?? "");
  }
  return answers;
}

export async function leadAssignee(prisma: PrismaClient, lead: Lead): Promise<string> {
  if (!lead.assigneeTgId) return "—";
  const user = await prisma.botUser.findUnique({
    where: { botId_tgId: { botId: lead.botId, tgId: lead.assigneeTgId } },
  });
  if (!user) return lead.assigneeTgId.toString();
  return `${user.firstName || lead.assigneeTgId.toString()}${user.username ? ` (@${user.username})` : ""}`;
}

export function leadText(lead: Lead, lang: Lang, masked: boolean, assignee: string): string {
  const body = formatLeadNotificationText({
    lang,
    masked,
    name: lead.customerName,
    phone: lead.phoneRaw,
    phoneVerified: lead.phoneVerified,
    username: lead.customerUsername,
    answers: extractAnswers(lead.answers),
    statusLine: t(lang, "lead_queue_status", { status: formatLeadStatusLabel(lead.status, lang) }),
    assigneeLine: lead.assigneeTgId ? t(lang, "lead_taken_by", { assignee }) : undefined,
  });
  const date = new Intl.DateTimeFormat(lang === "UZ" ? "uz-UZ" : "ru-RU", {
    timeZone: "Asia/Tashkent",
    dateStyle: "short",
    timeStyle: "short",
  }).format(lead.createdAt);
  return `${t(lang, "lead_queue_card_title")}\n${t(lang, "lead_queue_created", { date })}${body.slice(body.indexOf("\n"))}`;
}

function notificationKeyboard(lead: Lead, lang: Lang): InlineKeyboard | undefined {
  if (lead.status === "NEW")
    return new InlineKeyboard().text(t(lang, "btn_take_lead"), `lead:take:${lead.id}`);
  if (lead.status === "IN_PROGRESS")
    return new InlineKeyboard()
      .text(t(lang, "btn_lead_done"), `lead:status:${lead.id}:DONE`)
      .text(t(lang, "btn_lead_reject"), `lead:status:${lead.id}:REJECTED`);
  return undefined;
}

/** Original alerts remain usable; transient queue messages are never registered as alert refs. */
export async function syncLeadNotifications(
  ctx: PlatformBotContext,
  prisma: PrismaClient,
  lead: Lead,
  includeCurrent: boolean,
): Promise<void> {
  const masked = isMaskedStatus(ctx.botMeta.subscriptionStatus);
  const refs = Array.isArray(lead.notificationRefs)
    ? [...(lead.notificationRefs as unknown as LeadNotificationRef[])]
    : [];
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  const messageId = ctx.callbackQuery?.message?.message_id;
  if (
    includeCurrent &&
    chatId &&
    messageId &&
    !refs.some((r) => r.chatId === chatId && r.messageId === messageId)
  ) {
    refs.push({ chatId, messageId, lang: ctx.session.lang ?? "RU" });
  }
  const assignee = await leadAssignee(prisma, lead);
  for (const ref of refs) {
    const lang = ref.lang ?? "RU";
    const text = textChunks(leadText(lead, lang, masked, assignee)).at(-1)!;
    await ctx.api
      .editMessageText(ref.chatId, ref.messageId, text, {
        reply_markup: masked
          ? { inline_keyboard: [] }
          : (notificationKeyboard(lead, lang) ?? { inline_keyboard: [] }),
      })
      .catch(() => {});
  }
}
