import {
  registerNavigationHandlers,
  type NavigationOptions,
  type NavigationControls,
} from "./navigation-handlers.js";
import type { Lang, PrismaClient } from "@prisma/client";
import type { Bot } from "grammy";
import type { TelegramTransport } from "../../adapters/telegram/transport.js";
import type { PlatformBotContext } from "../../gateway/types.js";
import { fetchRecentEntriesText, formatSubscriptionStatusText } from "./admin-menu.js";
import { t } from "./i18n.js";
import { registerReceiptHandlers } from "./receipt-handlers.js";
import { isActualBotAdmin } from "./user-service.js";

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

  // 3. Admin menu callbacks
  bot.callbackQuery("admin:leads", async (ctx) => {
    if (!ctx.from) return;
    const isAdmin = await isActualBotAdmin(prisma, ctx.botMeta.id, ctx.from.id);
    if (!isAdmin) {
      await ctx
        .answerCallbackQuery({ text: "Доступ запрещен / Ruxsat yo'q", show_alert: true })
        .catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});
    const lang = (ctx.session.lang as Lang) ?? "RU";
    const text = await fetchRecentEntriesText(prisma, ctx.botMeta, lang);
    await sendReply(ctx, text);
  });

  bot.callbackQuery("admin:sub", async (ctx) => {
    if (!ctx.from) return;
    const isAdmin = await isActualBotAdmin(prisma, ctx.botMeta.id, ctx.from.id);
    if (!isAdmin) {
      await ctx
        .answerCallbackQuery({ text: "Доступ запрещен / Ruxsat yo'q", show_alert: true })
        .catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});
    const lang = (ctx.session.lang as Lang) ?? "RU";
    const { text, keyboard } = formatSubscriptionStatusText(ctx.botMeta, lang);
    await sendReply(ctx, text, { reply_markup: keyboard });
  });

  // 4. Admin Reply Keyboard text handlers (handles Russian and Uzbek button text)
  bot.hears([t("RU", "admin_menu_leads"), t("UZ", "admin_menu_leads")], async (ctx) => {
    if (!ctx.from) return;
    const user = await prisma.botUser.findUnique({
      where: {
        botId_tgId: {
          botId: ctx.botMeta.id,
          tgId: BigInt(ctx.from.id),
        },
      },
    });
    if (!user?.isAdmin) return;

    ctx.session.payment = undefined;
    const lang = user.lang ?? "RU";
    const text = await fetchRecentEntriesText(prisma, ctx.botMeta, lang);
    await sendReply(ctx, text);
  });

  bot.hears([t("RU", "admin_menu_sub"), t("UZ", "admin_menu_sub")], async (ctx) => {
    if (!ctx.from) return;
    const user = await prisma.botUser.findUnique({
      where: {
        botId_tgId: {
          botId: ctx.botMeta.id,
          tgId: BigInt(ctx.from.id),
        },
      },
    });
    if (!user?.isAdmin) return;

    ctx.session.payment = undefined;
    const lang = user.lang ?? "RU";
    const { text, keyboard } = formatSubscriptionStatusText(ctx.botMeta, lang);
    await sendReply(ctx, text, { reply_markup: keyboard });
  });

  // 5. Payment & receipts handlers (delegated to receipt-handlers module)
  registerReceiptHandlers(bot, prisma, {
    redis: opts?.redis,
    transport: opts?.transport,
    uploadDir: opts?.uploadDir,
    logger: opts?.logger,
  });
  return navigation;
}
