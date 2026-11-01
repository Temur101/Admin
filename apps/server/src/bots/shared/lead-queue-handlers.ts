import type { BotUser, PrismaClient } from "@prisma/client";
import { InlineKeyboard, type Bot } from "grammy";
import type { PlatformBotContext } from "../../gateway/types.js";
import { t } from "./i18n.js";
import { can } from "./permissions.js";
import { getBotAdminUser } from "./user-service.js";
import { textChunks } from "./notification-formatter.js";
import { isMaskedStatus } from "./subscription.js";
import { actOnLead } from "./lead-actions.js";
import { leadAssignee, leadText } from "./lead-card.js";
import { buildLeadQueueView, LEAD_FILTERS, type LeadFilter } from "./lead-queue-view.js";

export const LEAD_ID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

async function present(ctx: PlatformBotContext, text: string, keyboard: InlineKeyboard) {
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  if (!chatId) return;
  const chunks = textChunks(text);
  const msgId = ctx.callbackQuery?.message?.message_id;
  for (const [i, chunk] of chunks.entries()) {
    const extra = { reply_markup: i === chunks.length - 1 ? keyboard : { inline_keyboard: [] } };
    if (i === 0 && msgId)
      await ctx.api
        .editMessageText(chatId, msgId, chunk, extra)
        .catch(() => ctx.api.sendMessage(chatId, chunk, extra));
    else await ctx.api.sendMessage(chatId, chunk, extra);
  }
}

export async function showLeadQueue(
  ctx: PlatformBotContext,
  prisma: PrismaClient,
  admin: BotUser,
  filter: LeadFilter = "N",
  page = 0,
) {
  const view = await buildLeadQueueView(
    prisma,
    ctx.botMeta,
    admin.lang ?? ctx.session.lang ?? "RU",
    {
      statusFilter: LEAD_FILTERS[filter],
      page,
      isOwner: can(admin, "TOGGLE_RECEIVES_LEADS"),
      receivesLeads: admin.receivesLeads,
    },
  );
  await present(ctx, view.text, view.keyboard);
}

async function allowed(ctx: PlatformBotContext, prisma: PrismaClient): Promise<BotUser | null> {
  const admin = ctx.from ? await getBotAdminUser(prisma, ctx.botMeta.id, ctx.from.id) : null;
  if (ctx.botMeta.botType === "LEADCATCH" && admin && can(admin, "VIEW_LEADS")) return admin;
  await ctx
    .answerCallbackQuery({ text: t(ctx.session.lang, "lead_queue_denied"), show_alert: true })
    .catch(() => {});
  return null;
}

export function registerLeadQueueHandlers(
  bot: Bot<PlatformBotContext>,
  prisma: PrismaClient,
): void {
  bot.callbackQuery(/^lq:list:([NWDRA]):(\d{1,6})$/, async (ctx) => {
    const admin = await allowed(ctx, prisma);
    if (!admin) return;
    await ctx.answerCallbackQuery().catch(() => {});
    await showLeadQueue(ctx, prisma, admin, ctx.match[1] as LeadFilter, Number(ctx.match[2]));
  });
  bot.callbackQuery(
    new RegExp(`^lq:open:(${LEAD_ID_PATTERN}):([NWDRA]):(\\d{1,6})$`),
    async (ctx) => {
      const admin = await allowed(ctx, prisma);
      if (!admin) return;
      const lead = await prisma.lead.findFirst({
        where: { id: ctx.match[1], botId: ctx.botMeta.id },
      });
      const lang = admin.lang ?? ctx.session.lang ?? "RU";
      if (!lead) {
        await ctx
          .answerCallbackQuery({ text: t(lang, "lead_queue_missing"), show_alert: true })
          .catch(() => {});
        return;
      }
      await ctx.answerCallbackQuery().catch(() => {});
      const filter = ctx.match[2] as LeadFilter;
      const page = Number(ctx.match[3]);
      const masked = isMaskedStatus(ctx.botMeta.subscriptionStatus);
      const keyboard = new InlineKeyboard();
      const tail = `${lead.id}:${filter}:${page}`;
      if (!masked && can(admin, "TAKE_LEAD")) {
        if (lead.status === "NEW") keyboard.text(t(lang, "btn_take_lead"), `lq:take:${tail}`).row();
        else if (
          lead.status === "IN_PROGRESS" &&
          (can(admin, "MANAGE_SETTINGS") || lead.assigneeTgId === BigInt(ctx.from!.id))
        ) {
          keyboard
            .text(t(lang, "btn_lead_done"), `lq:done:${tail}`)
            .text(t(lang, "btn_lead_reject"), `lq:reject:${tail}`)
            .row();
        }
      }
      keyboard.text(t(lang, "lead_queue_back"), `lq:list:${filter}:${page}`);
      await present(ctx, leadText(lead, lang, masked, await leadAssignee(prisma, lead)), keyboard);
    },
  );
  bot.callbackQuery(
    new RegExp(`^lq:(take|done|reject):(${LEAD_ID_PATTERN}):([NWDRA]):(\\d{1,6})$`),
    async (ctx) => {
      const action =
        ctx.match[1] === "take" ? "TAKE" : ctx.match[1] === "done" ? "DONE" : "REJECTED";
      const admin = await actOnLead(ctx, prisma, ctx.match[2]!, action, true);
      if (admin)
        await showLeadQueue(ctx, prisma, admin, ctx.match[3] as LeadFilter, Number(ctx.match[4]));
    },
  );
}
