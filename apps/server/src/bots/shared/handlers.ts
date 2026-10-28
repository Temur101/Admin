import {
  registerNavigationHandlers,
  type NavigationOptions,
  type NavigationControls,
} from "./navigation-handlers.js";
import type { Lang, PrismaClient } from "@prisma/client";
import type { Bot } from "grammy";
import type { TelegramTransport } from "../../adapters/telegram/transport.js";
import type { PlatformBotContext } from "../../gateway/types.js";
import { buildAdminEntriesView, formatSubscriptionStatusText } from "./admin-menu.js";
import { t } from "./i18n.js";
import { registerLeadAssignmentHandlers } from "./lead-assignment.js";
import { can } from "./permissions.js";
import { registerReceiptHandlers } from "./receipt-handlers.js";
import { getBotAdminUser } from "./user-service.js";

type SendMessageOptions = Parameters<PlatformBotContext["api"]["sendMessage"]>[2];

async function sendReply(
  ctx: PlatformBotContext,
  text: string,
  extra?: SendMessageOptions,
): Promise<void> {
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  if (!chatId) return;
  await ctx.api.sendMessage(chatId, text, extra);
}

export interface SharedBotHandlersOptions extends NavigationOptions {
  transport?: TelegramTransport;
  uploadDir?: string;
}

export function registerSharedBotHandlers(
  bot: Bot<PlatformBotContext>,
  prisma: PrismaClient,
  opts?: SharedBotHandlersOptions,
): NavigationControls {
  const navigation = registerNavigationHandlers(bot, prisma, opts);

  bot.callbackQuery("admin:leads", async (ctx) => {
    if (!ctx.from) return;
    const admin = await getBotAdminUser(prisma, ctx.botMeta.id, ctx.from.id);
    if (!admin || !can(admin, "VIEW_LEADS")) {
      await ctx
        .answerCallbackQuery({ text: "Доступ запрещен / Ruxsat yo'q", show_alert: true })
        .catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});
    const lang = admin.lang ?? (ctx.session.lang as Lang) ?? "RU";
    const view = await buildAdminEntriesView(prisma, ctx.botMeta, lang, {
      isOwner: can(admin, "TOGGLE_RECEIVES_LEADS"),
      receivesLeads: admin.receivesLeads,
    });
    await sendReply(ctx, view.text, view.keyboard ? { reply_markup: view.keyboard } : undefined);
  });

  bot.callbackQuery("admin:sub", async (ctx) => {
    if (!ctx.from) return;
    const admin = await getBotAdminUser(prisma, ctx.botMeta.id, ctx.from.id);
    if (!admin || !can(admin, "MANAGE_SUBSCRIPTION")) {
      await ctx
        .answerCallbackQuery({
          text: admin ? t(ctx.session.lang, "owner_only_action") : "Доступ запрещен / Ruxsat yo'q",
          show_alert: true,
        })
        .catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});
    const lang = admin.lang ?? (ctx.session.lang as Lang) ?? "RU";
    const { text, keyboard } = formatSubscriptionStatusText(ctx.botMeta, lang);
    await sendReply(ctx, text, { reply_markup: keyboard });
  });

  bot.hears([t("RU", "admin_menu_leads"), t("UZ", "admin_menu_leads")], async (ctx) => {
    if (!ctx.from) return;
    const admin = await getBotAdminUser(prisma, ctx.botMeta.id, ctx.from.id);
    if (!admin || !can(admin, "VIEW_LEADS")) return;

    ctx.session.payment = undefined;
    const lang = admin.lang ?? "RU";
    const view = await buildAdminEntriesView(prisma, ctx.botMeta, lang, {
      isOwner: can(admin, "TOGGLE_RECEIVES_LEADS"),
      receivesLeads: admin.receivesLeads,
    });
    await sendReply(ctx, view.text, view.keyboard ? { reply_markup: view.keyboard } : undefined);
  });

  bot.hears([t("RU", "admin_menu_sub"), t("UZ", "admin_menu_sub")], async (ctx) => {
    if (!ctx.from) return;
    const admin = await getBotAdminUser(prisma, ctx.botMeta.id, ctx.from.id);
    if (!admin) return;
    const lang = admin.lang ?? "RU";
    if (!can(admin, "MANAGE_SUBSCRIPTION")) {
      await sendReply(ctx, t(lang, "owner_only_action"));
      return;
    }

    ctx.session.payment = undefined;
    const { text, keyboard } = formatSubscriptionStatusText(ctx.botMeta, lang);
    await sendReply(ctx, text, { reply_markup: keyboard });
  });

  registerLeadAssignmentHandlers(bot, prisma);

  registerReceiptHandlers(bot, prisma, {
    redis: opts?.redis,
    transport: opts?.transport,
    uploadDir: opts?.uploadDir,
    logger: opts?.logger,
  });
  return navigation;
}
