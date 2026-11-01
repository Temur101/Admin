import type { LeadStatus, PrismaClient } from "@prisma/client";
import type { Bot } from "grammy";
import type { PlatformBotContext } from "../../gateway/types.js";
import { t } from "./i18n.js";
import { can } from "./permissions.js";
import { getBotAdminUser } from "./user-service.js";
import { actOnLead } from "./lead-actions.js";
import {
  LEAD_ID_PATTERN,
  registerLeadQueueHandlers,
  showLeadQueue,
} from "./lead-queue-handlers.js";
import { leadFilterCode } from "./lead-queue-view.js";

/** Keep old notification buttons and filters working alongside the queue. */
export function registerLeadAssignmentHandlers(
  bot: Bot<PlatformBotContext>,
  prisma: PrismaClient,
): void {
  registerLeadQueueHandlers(bot, prisma);
  bot.callbackQuery(/^admin:leads:(ALL|NEW|IN_PROGRESS|DONE|REJECTED)$/, async (ctx) => {
    const admin = ctx.from ? await getBotAdminUser(prisma, ctx.botMeta.id, ctx.from.id) : null;
    if (!admin || !can(admin, "VIEW_LEADS") || ctx.botMeta.botType !== "LEADCATCH") {
      await ctx
        .answerCallbackQuery({ text: t(ctx.session.lang, "lead_queue_denied"), show_alert: true })
        .catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});
    await showLeadQueue(ctx, prisma, admin, leadFilterCode(ctx.match[1] as LeadStatus | "ALL"));
  });
  bot.callbackQuery("admin:toggle_leads", async (ctx) => {
    const admin = ctx.from ? await getBotAdminUser(prisma, ctx.botMeta.id, ctx.from.id) : null;
    if (!admin || !can(admin, "TOGGLE_RECEIVES_LEADS") || ctx.botMeta.botType !== "LEADCATCH") {
      await ctx
        .answerCallbackQuery({ text: t(ctx.session.lang, "owner_only_action"), show_alert: true })
        .catch(() => {});
      return;
    }
    const updated = await prisma.botUser.update({
      where: { botId_tgId: { botId: ctx.botMeta.id, tgId: admin.tgId } },
      data: { receivesLeads: !admin.receivesLeads },
    });
    ctx.session.receivesLeads = updated.receivesLeads;
    await ctx
      .answerCallbackQuery({
        text: t(
          admin.lang,
          updated.receivesLeads ? "receives_leads_enabled" : "receives_leads_disabled",
        ),
      })
      .catch(() => {});
    await showLeadQueue(ctx, prisma, updated);
  });
  bot.callbackQuery(new RegExp(`^lead:take:(${LEAD_ID_PATTERN})$`), async (ctx) => {
    await actOnLead(ctx, prisma, ctx.match[1]!, "TAKE");
  });
  bot.callbackQuery(
    new RegExp(`^lead:status:(${LEAD_ID_PATTERN}):(DONE|REJECTED)$`),
    async (ctx) => {
      await actOnLead(ctx, prisma, ctx.match[1]!, ctx.match[2] as "DONE" | "REJECTED");
    },
  );
}
