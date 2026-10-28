import type { Lang, Lead, LeadStatus, PrismaClient } from "@prisma/client";
import { InlineKeyboard, type Bot } from "grammy";
import type { PlatformBotContext } from "../../gateway/types.js";
import { buildAdminEntriesView, formatLeadStatusLabel } from "./admin-menu.js";
import { t } from "./i18n.js";
import { formatLeadNotificationText, type LeadNotificationRef } from "./notification.js";
import { can } from "./permissions.js";
import { isMaskedStatus } from "./subscription.js";
import { getBotAdminUser } from "./user-service.js";

function extractPlainAnswers(rawAnswers: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (!rawAnswers || typeof rawAnswers !== "object") return result;
  for (const [k, v] of Object.entries(rawAnswers as Record<string, unknown>)) {
    if (v && typeof v === "object" && "answer" in v) {
      const obj = v as { question?: string; answer?: unknown };
      result[obj.question || k] = String(obj.answer ?? "");
    } else {
      result[k] = String(v ?? "");
    }
  }
  return result;
}

function buildLeadActionKeyboard(lead: Lead, lang: Lang): InlineKeyboard | undefined {
  if (lead.status === "NEW") {
    return new InlineKeyboard().text(t(lang, "btn_take_lead"), `lead:take:${lead.id}`);
  }
  if (lead.status === "IN_PROGRESS") {
    return new InlineKeyboard()
      .text(t(lang, "btn_lead_done"), `lead:status:${lead.id}:DONE`)
      .text(t(lang, "btn_lead_reject"), `lead:status:${lead.id}:REJECTED`);
  }
  return undefined;
}

async function resolveAssigneeDisplay(
  prisma: PrismaClient,
  botId: string,
  assigneeTgId: bigint | null,
): Promise<string> {
  if (!assigneeTgId) return "—";
  const user = await prisma.botUser?.findUnique({
    where: { botId_tgId: { botId, tgId: assigneeTgId } },
  });
  if (!user) return assigneeTgId.toString();
  const base = user.firstName || assigneeTgId.toString();
  return user.username ? `${base} (@${user.username})` : base;
}

async function syncLeadNotificationMessages(
  ctx: PlatformBotContext,
  lead: Lead,
  assigneeDisplay: string,
): Promise<void> {
  const masked = isMaskedStatus(ctx.botMeta.subscriptionStatus);
  const answers = extractPlainAnswers(lead.answers);
  const rawRefs = Array.isArray(lead.notificationRefs)
    ? (lead.notificationRefs as unknown as LeadNotificationRef[])
    : [];

  const currentChatId = ctx.chat?.id ?? ctx.from?.id;
  const currentMsgId = ctx.callbackQuery?.message?.message_id;
  const allRefs = [...rawRefs];
  if (
    currentChatId &&
    currentMsgId &&
    !allRefs.some((r) => r.chatId === currentChatId && r.messageId === currentMsgId)
  ) {
    allRefs.push({
      chatId: currentChatId,
      messageId: currentMsgId,
      lang: (ctx.session.lang as "RU" | "UZ") ?? "RU",
    });
  }

  for (const ref of allRefs) {
    const lang = ref.lang ?? "RU";
    const statusLabel = formatLeadStatusLabel(lead.status, lang);
    const text = formatLeadNotificationText({
      lang,
      masked,
      name: lead.customerName,
      phone: lead.phoneRaw,
      phoneVerified: lead.phoneVerified,
      username: lead.customerUsername,
      answers,
      statusLine: `Статус: ${statusLabel}`,
      assigneeLine: lead.assigneeTgId
        ? t(lang, "lead_taken_by", { assignee: assigneeDisplay })
        : undefined,
    });
    const kb = buildLeadActionKeyboard(lead, lang);

    await ctx.api
      .editMessageText(ref.chatId, ref.messageId, text, {
        reply_markup: kb,
      })
      .catch(() => {});
  }
}

export function registerLeadAssignmentHandlers(
  bot: Bot<PlatformBotContext>,
  prisma: PrismaClient,
): void {
  bot.callbackQuery(/^admin:leads:(ALL|NEW|IN_PROGRESS|DONE|REJECTED)$/, async (ctx) => {
    if (!ctx.from) return;
    const admin = await getBotAdminUser(prisma, ctx.botMeta.id, ctx.from.id);
    if (!can(admin, "VIEW_LEADS")) {
      await ctx
        .answerCallbackQuery({ text: "Доступ запрещен / Ruxsat yo'q", show_alert: true })
        .catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});
    const filterArg = ctx.match[1] as "ALL" | LeadStatus;
    const lang = admin?.lang ?? (ctx.session.lang as Lang) ?? "RU";
    const view = await buildAdminEntriesView(prisma, ctx.botMeta, lang, {
      statusFilter: filterArg === "ALL" ? undefined : filterArg,
      isOwner: can(admin, "TOGGLE_RECEIVES_LEADS"),
      receivesLeads: admin?.receivesLeads ?? true,
    });
    const chatId = ctx.chat?.id ?? ctx.from.id;
    const msgId = ctx.callbackQuery.message?.message_id;
    if (msgId) {
      await ctx.api
        .editMessageText(chatId, msgId, view.text, { reply_markup: view.keyboard })
        .catch(async () => {
          await ctx.api.sendMessage(chatId, view.text, { reply_markup: view.keyboard });
        });
    } else {
      await ctx.api.sendMessage(chatId, view.text, { reply_markup: view.keyboard });
    }
  });

  bot.callbackQuery("admin:toggle_leads", async (ctx) => {
    if (!ctx.from) return;
    const admin = await getBotAdminUser(prisma, ctx.botMeta.id, ctx.from.id);
    if (!admin || !can(admin, "TOGGLE_RECEIVES_LEADS")) {
      await ctx
        .answerCallbackQuery({ text: t(ctx.session.lang, "owner_only_action"), show_alert: true })
        .catch(() => {});
      return;
    }
    const nextReceives = !admin.receivesLeads;
    await prisma.botUser.update({
      where: { botId_tgId: { botId: ctx.botMeta.id, tgId: BigInt(ctx.from.id) } },
      data: { receivesLeads: nextReceives },
    });
    ctx.session.receivesLeads = nextReceives;
    const lang = admin.lang ?? (ctx.session.lang as Lang) ?? "RU";
    await ctx
      .answerCallbackQuery({
        text: t(lang, nextReceives ? "receives_leads_enabled" : "receives_leads_disabled"),
      })
      .catch(() => {});

    const view = await buildAdminEntriesView(prisma, ctx.botMeta, lang, {
      isOwner: true,
      receivesLeads: nextReceives,
    });
    const chatId = ctx.chat?.id ?? ctx.from.id;
    const msgId = ctx.callbackQuery.message?.message_id;
    if (msgId) {
      await ctx.api
        .editMessageText(chatId, msgId, view.text, { reply_markup: view.keyboard })
        .catch(() => {});
    }
  });

  bot.callbackQuery(/^lead:take:(.+)$/, async (ctx) => {
    if (!ctx.from) return;
    const leadId = ctx.match[1];
    if (!leadId) return;

    const admin = await getBotAdminUser(prisma, ctx.botMeta.id, ctx.from.id);
    if (!admin || !can(admin, "TAKE_LEAD")) {
      await ctx
        .answerCallbackQuery({ text: "Доступ запрещен / Ruxsat yo'q", show_alert: true })
        .catch(() => {});
      return;
    }

    const lang = admin.lang ?? (ctx.session.lang as Lang) ?? "RU";
    const now = new Date();
    const claimed = await prisma.lead.updateMany({
      where: {
        id: leadId,
        botId: ctx.botMeta.id,
        status: "NEW",
        assigneeTgId: null,
      },
      data: {
        status: "IN_PROGRESS",
        assigneeTgId: BigInt(ctx.from.id),
        assignedAt: now,
        statusChangedAt: now,
      },
    });

    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead || lead.botId !== ctx.botMeta.id) {
      await ctx.answerCallbackQuery({ text: "Заявка не найдена", show_alert: true }).catch(() => {});
      return;
    }

    const assigneeDisplay = await resolveAssigneeDisplay(prisma, ctx.botMeta.id, lead.assigneeTgId);

    if (claimed.count === 0) {
      await ctx
        .answerCallbackQuery({
          text: t(lang, "lead_already_taken", { assignee: assigneeDisplay }),
          show_alert: true,
        })
        .catch(() => {});
      await syncLeadNotificationMessages(ctx, lead, assigneeDisplay);
      return;
    }

    await ctx
      .answerCallbackQuery({
        text: t(lang, "lead_status_in_progress"),
      })
      .catch(() => {});
    await syncLeadNotificationMessages(ctx, lead, assigneeDisplay);
  });

  bot.callbackQuery(/^lead:status:([^:]+):(DONE|REJECTED)$/, async (ctx) => {
    if (!ctx.from) return;
    const leadId = ctx.match[1];
    const targetStatus = ctx.match[2] as "DONE" | "REJECTED";
    if (!leadId || !targetStatus) return;

    const admin = await getBotAdminUser(prisma, ctx.botMeta.id, ctx.from.id);
    if (!admin || !can(admin, "TAKE_LEAD")) {
      await ctx
        .answerCallbackQuery({ text: "Доступ запрещен / Ruxsat yo'q", show_alert: true })
        .catch(() => {});
      return;
    }

    const lang = admin.lang ?? (ctx.session.lang as Lang) ?? "RU";
    const lead = await prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead || lead.botId !== ctx.botMeta.id) {
      await ctx.answerCallbackQuery({ text: "Заявка не найдена", show_alert: true }).catch(() => {});
      return;
    }

    const isAssignee = lead.assigneeTgId === BigInt(ctx.from.id);
    const isOwner = can(admin, "MANAGE_SETTINGS");
    if (!isAssignee && !isOwner) {
      await ctx
        .answerCallbackQuery({
          text: t(lang, "lead_only_assignee_or_owner"),
          show_alert: true,
        })
        .catch(() => {});
      return;
    }

    const now = new Date();
    const updated = await prisma.lead.update({
      where: { id: leadId },
      data: {
        status: targetStatus,
        assigneeTgId: lead.assigneeTgId ?? BigInt(ctx.from.id),
        assignedAt: lead.assignedAt ?? now,
        statusChangedAt: now,
      },
    });

    const assigneeDisplay = await resolveAssigneeDisplay(
      prisma,
      ctx.botMeta.id,
      updated.assigneeTgId,
    );
    await ctx
      .answerCallbackQuery({
        text: formatLeadStatusLabel(targetStatus, lang),
      })
      .catch(() => {});
    await syncLeadNotificationMessages(ctx, updated, assigneeDisplay);
  });
}
