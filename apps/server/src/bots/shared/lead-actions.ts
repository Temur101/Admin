import type { PrismaClient, BotUser } from "@prisma/client";
import type { PlatformBotContext } from "../../gateway/types.js";
import { can } from "./permissions.js";
import { getBotAdminUser } from "./user-service.js";
import { t } from "./i18n.js";
import { formatLeadStatusLabel } from "./lead-status.js";
import { leadAssignee, syncLeadNotifications } from "./lead-card.js";

export async function actOnLead(
  ctx: PlatformBotContext,
  prisma: PrismaClient,
  id: string,
  action: "TAKE" | "DONE" | "REJECTED",
  fromQueue = false,
): Promise<BotUser | null> {
  if (!ctx.from) return null;
  const admin = await getBotAdminUser(prisma, ctx.botMeta.id, ctx.from.id);
  if (ctx.botMeta.botType !== "LEADCATCH" || !admin || !can(admin, "TAKE_LEAD")) {
    await ctx
      .answerCallbackQuery({ text: t(ctx.session.lang, "lead_queue_denied"), show_alert: true })
      .catch(() => {});
    return null;
  }
  const lang = admin.lang ?? ctx.session.lang ?? "RU";
  const actor = BigInt(ctx.from.id);
  const now = new Date();
  if (action === "TAKE") {
    const claimed = await prisma.lead.updateMany({
      where: { id, botId: ctx.botMeta.id, status: "NEW", assigneeTgId: null },
      data: { status: "IN_PROGRESS", assigneeTgId: actor, assignedAt: now, statusChangedAt: now },
    });
    const lead = await prisma.lead.findFirst({ where: { id, botId: ctx.botMeta.id } });
    if (!lead) {
      await ctx
        .answerCallbackQuery({ text: t(lang, "lead_queue_missing"), show_alert: true })
        .catch(() => {});
      return null;
    }
    await ctx
      .answerCallbackQuery({
        text: claimed.count
          ? t(lang, "lead_status_in_progress")
          : t(lang, "lead_already_taken", { assignee: await leadAssignee(prisma, lead) }),
        ...(claimed.count ? {} : { show_alert: true }),
      })
      .catch(() => {});
    await syncLeadNotifications(ctx, prisma, lead, !fromQueue);
    return admin;
  }
  const lead = await prisma.lead.findFirst({ where: { id, botId: ctx.botMeta.id } });
  if (!lead) {
    await ctx
      .answerCallbackQuery({ text: t(lang, "lead_queue_missing"), show_alert: true })
      .catch(() => {});
    return null;
  }
  const owner = can(admin, "MANAGE_SETTINGS");
  if (!owner && lead.assigneeTgId !== actor) {
    await ctx
      .answerCallbackQuery({ text: t(lang, "lead_only_assignee_or_owner"), show_alert: true })
      .catch(() => {});
    return null;
  }
  const changed = await prisma.lead.updateMany({
    where: { id, botId: ctx.botMeta.id, status: "IN_PROGRESS", assigneeTgId: lead.assigneeTgId },
    data: {
      status: action,
      assigneeTgId: lead.assigneeTgId ?? actor,
      assignedAt: lead.assignedAt ?? now,
      statusChangedAt: now,
    },
  });
  const updated = await prisma.lead.findFirst({ where: { id, botId: ctx.botMeta.id } });
  await ctx
    .answerCallbackQuery({
      text: changed.count ? formatLeadStatusLabel(action, lang) : t(lang, "lead_queue_changed"),
      ...(changed.count ? {} : { show_alert: true }),
    })
    .catch(() => {});
  if (updated) await syncLeadNotifications(ctx, prisma, updated, !fromQueue);
  return admin;
}
