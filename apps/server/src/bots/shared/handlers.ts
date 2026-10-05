import type { Lang, PrismaClient } from "@prisma/client";
import type { Bot } from "grammy";
import type { PlatformBotContext } from "../../gateway/types.js";
import {
  buildAdminReplyKeyboard,
  buildLanguageInlineKeyboard,
  buildTariffInlineKeyboard,
  fetchRecentEntriesText,
  formatSubscriptionStatusText,
} from "./admin-menu.js";
import { t } from "./i18n.js";
import { setUserLanguage, upsertBotUser } from "./user-service.js";

async function sendReply(
  ctx: PlatformBotContext,
  text: string,
  extra?: { reply_markup?: unknown },
): Promise<void> {
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  if (!chatId) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await ctx.api.sendMessage(chatId, text, extra as any);
}

export interface SharedBotHandlersOptions {
  onClientStart?: (ctx: PlatformBotContext) => Promise<void>;
}

export function registerSharedBotHandlers(
  bot: Bot<PlatformBotContext>,
  prisma: PrismaClient,
  opts?: SharedBotHandlersOptions,
): void {
  const handleStart = async (ctx: PlatformBotContext, matchParam?: string) => {
    const rawMatch = (matchParam ?? (typeof ctx.match === "string" ? ctx.match : "")).trim();
    const inviteCode = rawMatch.startsWith("adm_") ? rawMatch.slice(4) : null;

    if (!ctx.from) return;

    const { user, newlyBecameAdmin } = await upsertBotUser(prisma, {
      botId: ctx.botMeta.id,
      tgId: ctx.from.id,
      firstName: ctx.from.first_name,
      username: ctx.from.username,
      inviteCode,
      expectedInviteCode: ctx.botMeta.adminInviteCode,
    });

    ctx.session.lang = user.lang ?? undefined;
    ctx.session.isAdmin = user.isAdmin;

    // If user has not chosen language yet -> prompt language selection
    if (!user.lang) {
      await sendReply(ctx, "Пожалуйста, выберите язык / Iltimos, tilni tanlang:", {
        reply_markup: buildLanguageInlineKeyboard(),
      });
      return;
    }

    if (user.isAdmin) {
      const msg = newlyBecameAdmin
        ? t(user.lang, "welcome_admin")
        : t(user.lang, "admin_menu_title");
      await sendReply(ctx, msg, {
        reply_markup: buildAdminReplyKeyboard(user.lang),
      });
      return;
    }

    // Client flow: always greet the client, then trigger bot-specific client flow
    await sendReply(ctx, t(user.lang, "welcome_client"));
    if (opts?.onClientStart) {
      await opts.onClientStart(ctx);
    }
  };

  // 1. /start command: supports both standard Telegram bot_command entity and plain text /start
  bot.command("start", async (ctx) => {
    await handleStart(ctx, typeof ctx.match === "string" ? ctx.match : undefined);
  });

  bot.hears(/^\/start(?:\s+(.*))?$/, async (ctx) => {
    // Avoid double-processing if bot.command already triggered
    if (ctx.hasCommand?.("start")) return;
    const matchText = Array.isArray(ctx.match) ? ctx.match[1] : undefined;
    await handleStart(ctx, matchText);
  });

  // 2. Language selection callback
  bot.callbackQuery(/^set_lang:(RU|UZ)$/, async (ctx) => {
    const lang = (Array.isArray(ctx.match) ? ctx.match[1] : "RU") as Lang;
    if (!ctx.from) return;

    await setUserLanguage(prisma, ctx.botMeta.id, ctx.from.id, lang);
    ctx.session.lang = lang;
    await ctx.answerCallbackQuery();

    await sendReply(ctx, t(lang, "language_selected"));

    // Check if user is admin
    const user = await prisma.botUser.findUnique({
      where: {
        botId_tgId: {
          botId: ctx.botMeta.id,
          tgId: BigInt(ctx.from.id),
        },
      },
    });

    if (user?.isAdmin) {
      await sendReply(ctx, t(lang, "admin_menu_title"), {
        reply_markup: buildAdminReplyKeyboard(lang),
      });
    } else {
      await sendReply(ctx, t(lang, "welcome_client"));
      if (opts?.onClientStart) {
        await opts.onClientStart(ctx);
      }
    }
  });

  // 3. Admin menu callbacks & text button listeners
  bot.callbackQuery("admin:leads", async (ctx) => {
    if (!ctx.from) return;
    await ctx.answerCallbackQuery();
    const lang = (ctx.session.lang as Lang) ?? "RU";
    const text = await fetchRecentEntriesText(prisma, ctx.botMeta, lang);
    await sendReply(ctx, text);
  });

  bot.callbackQuery("admin:sub", async (ctx) => {
    if (!ctx.from) return;
    await ctx.answerCallbackQuery();
    const lang = (ctx.session.lang as Lang) ?? "RU";
    const { text, keyboard } = formatSubscriptionStatusText(ctx.botMeta, lang);
    await sendReply(ctx, text, { reply_markup: keyboard });
  });

  bot.callbackQuery("admin:lang", async (ctx) => {
    if (!ctx.from) return;
    await ctx.answerCallbackQuery();
    const lang = (ctx.session.lang as Lang) ?? "RU";
    await sendReply(ctx, t(lang, "choose_language"), {
      reply_markup: buildLanguageInlineKeyboard(),
    });
  });

  bot.callbackQuery("admin:pay", async (ctx) => {
    if (!ctx.from) return;
    await ctx.answerCallbackQuery();
    const lang = (ctx.session.lang as Lang) ?? "RU";
    await sendReply(ctx, t(lang, "pay_select_tariff"), {
      reply_markup: buildTariffInlineKeyboard(lang),
    });
  });

  bot.callbackQuery(/^pay:tariff:(\d+)$/, async (ctx) => {
    if (!ctx.from) return;
    await ctx.answerCallbackQuery();
    const matchStr = Array.isArray(ctx.match) ? ctx.match[1] : "1";
    const months = Number(matchStr ?? 1);
    const lang = (ctx.session.lang as Lang) ?? "RU";

    const settings = await prisma.platformSettings.findUnique({ where: { id: 1 } });
    const amount =
      months === 1 ? 100_000 : months === 6 ? 500_000 : 1_000_000;
    const details = settings?.paymentDetails || "8600 0000 0000 0000 (Platform)";

    const text = t(lang, "pay_details_prompt", {
      amount: amount.toLocaleString("ru-RU"),
      details,
    });
    await sendReply(ctx, text);
  });

  // 4. Admin Reply Keyboard text handlers (handles Russian and Uzbek button text)
  bot.hears([/📋/], async (ctx) => {
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

    const lang = user.lang ?? "RU";
    const text = await fetchRecentEntriesText(prisma, ctx.botMeta, lang);
    await sendReply(ctx, text);
  });

  bot.hears([/💳/], async (ctx) => {
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

    const lang = user.lang ?? "RU";
    const { text, keyboard } = formatSubscriptionStatusText(ctx.botMeta, lang);
    await sendReply(ctx, text, { reply_markup: keyboard });
  });

  bot.hears([/🌐/], async (ctx) => {
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

    const lang = user.lang ?? "RU";
    await sendReply(ctx, t(lang, "choose_language"), {
      reply_markup: buildLanguageInlineKeyboard(),
    });
  });
}
