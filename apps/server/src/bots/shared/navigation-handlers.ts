import type { Bot } from "grammy";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import type { Logger } from "../../core/logger.js";
import type { PlatformBotContext } from "../../gateway/types.js";
import { t } from "./i18n.js";
import { upsertBotUser, setUserLanguage, isActualBotAdmin } from "./user-service.js";
import { buildLanguageInlineKeyboard } from "./admin-menu.js";
import { navigationKeyboard } from "./client-menu.js";
import { resetClientFlow } from "./flow-reset.js";

export interface NavigationOptions {
  onClientStart?: (ctx: PlatformBotContext) => Promise<void>;
  redis?: Redis;
  logger?: Logger;
}

export interface NavigationControls {
  showMenu: (ctx: PlatformBotContext) => Promise<void>;
  restartFlow: (ctx: PlatformBotContext) => Promise<void>;
}

const labels = (
  key: "client_menu" | "client_language" | "client_quiz" | "client_book" | "btn_restart",
) => [t("RU", key), t("UZ", key)];

export function registerNavigationHandlers(
  bot: Bot<PlatformBotContext>,
  prisma: PrismaClient,
  opts: NavigationOptions = {},
): NavigationControls {
  const profile = async (ctx: PlatformBotContext, inviteCode?: string | null) => {
    if (!ctx.from) return null;
    const result = await upsertBotUser(prisma, {
      botId: ctx.botMeta.id,
      tgId: ctx.from.id,
      firstName: ctx.from.first_name,
      username: ctx.from.username,
      inviteCode,
    });
    ctx.session.lang = result.user.lang ?? undefined;
    ctx.session.isAdmin = result.user.isAdmin;
    ctx.session.adminRole = result.user.isAdmin ? (result.user.role ?? "OWNER") : null;
    ctx.session.receivesLeads = result.user.receivesLeads ?? true;
    return result;
  };

  const menuText = (ctx: PlatformBotContext) =>
    t(ctx.session.lang, ctx.session.isAdmin ? "admin_menu_title" : "client_menu_title");

  const displayMenu = (ctx: PlatformBotContext, text = menuText(ctx)) =>
    ctx.api.sendMessage(ctx.chat?.id ?? ctx.from!.id, text, {
      reply_markup: navigationKeyboard(ctx),
    });

  const languagePrompt = async (ctx: PlatformBotContext) => {
    await displayMenu(ctx);
    await ctx.api.sendMessage(
      ctx.chat?.id ?? ctx.from!.id,
      ctx.session.lang
        ? t(ctx.session.lang, "choose_language")
        : "Пожалуйста, выберите язык / Iltimos, tilni tanlang:",
      { reply_markup: buildLanguageInlineKeyboard() },
    );
  };

  const enter = async (
    ctx: PlatformBotContext,
    startClient: boolean,
    inviteCode?: string | null,
    asClient = false,
  ) => {
    const result = await profile(ctx, inviteCode);
    if (!result) return;
    if (!(await resetClientFlow(ctx, opts.redis, opts.logger))) return;
    ctx.session.languageNextAction = startClient ? "start" : "menu";
    if (!result.user.lang) {
      await languagePrompt(ctx);
      return;
    }
    ctx.session.languageNextAction = undefined;
    if (ctx.session.isAdmin && !asClient) {
      await displayMenu(
        ctx,
        result.newlyBecameAdmin ? t(ctx.session.lang, "welcome_admin") : menuText(ctx),
      );
      return;
    }
    await displayMenu(ctx, startClient ? t(ctx.session.lang, "welcome_client") : menuText(ctx));
    if (startClient) await opts.onClientStart?.(ctx);
  };

  const showMenu = async (ctx: PlatformBotContext) => {
    await enter(ctx, false);
  };

  const restartFlow = async (ctx: PlatformBotContext) => {
    await enter(ctx, true, null, true);
  };

  const start = async (ctx: PlatformBotContext, param: string) => {
    await enter(ctx, true, param.startsWith("adm_") ? param.slice(4) : null);
  };

  bot.command("start", (ctx) => start(ctx, typeof ctx.match === "string" ? ctx.match.trim() : ""));
  bot.hears(/^\/start(?:\s+(.*))?$/, async (ctx) => {
    await start(ctx, ctx.match[1]?.trim() ?? "");
  });
  bot.command("menu", showMenu);
  bot.hears(/^\/menu$/, showMenu);
  bot.command("restart", restartFlow);
  bot.hears(/^\/restart$/, restartFlow);
  bot.hears(labels("client_menu"), showMenu);
  bot.hears([...labels("client_quiz"), ...labels("client_book"), ...labels("btn_restart")], (ctx) =>
    enter(ctx, true),
  );
  bot.command(["quiz", "book"], async (ctx) => {
    const command = ctx.message?.text?.split(/[ @]/)[0];
    const correct =
      (command === "/quiz" && ctx.botMeta.botType === "LEADCATCH") ||
      (command === "/book" && ctx.botMeta.botType === "QUICKBOOK");
    await enter(ctx, correct, null, correct);
  });

  const chooseLanguage = async (ctx: PlatformBotContext) => {
    if (!(await profile(ctx)) || !(await resetClientFlow(ctx, opts.redis, opts.logger))) return;
    ctx.session.languageNextAction = "menu";
    await languagePrompt(ctx);
  };

  bot.hears(
    [...labels("client_language"), t("RU", "admin_menu_lang"), t("UZ", "admin_menu_lang")],
    chooseLanguage,
  );

  bot.callbackQuery("admin:lang", async (ctx) => {
    if (!ctx.from || !(await isActualBotAdmin(prisma, ctx.botMeta.id, ctx.from.id))) {
      await ctx
        .answerCallbackQuery({ text: "Доступ запрещен / Ruxsat yo'q", show_alert: true })
        .catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});
    await chooseLanguage(ctx);
  });

  bot.callbackQuery(/^set_lang:(RU|UZ)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const pendingAction = ctx.session.languageNextAction;
    const result = await profile(ctx);
    if (!result || !(await resetClientFlow(ctx, opts.redis, opts.logger))) return;
    const action = pendingAction ?? (result.user.lang ? "menu" : "start");
    try {
      const user = await setUserLanguage(
        prisma,
        ctx.botMeta.id,
        ctx.from!.id,
        ctx.match[1] as "RU" | "UZ",
      );
      ctx.session.lang = user.lang ?? "RU";
      ctx.session.isAdmin = user.isAdmin;
      ctx.session.adminRole = user.isAdmin ? (user.role ?? "OWNER") : null;
    } catch (error) {
      opts.logger?.warn(
        { err: error instanceof Error ? error.message : String(error) },
        "Could not save bot language",
      );
      await displayMenu(ctx, t(ctx.session.lang, "client_language_failed"));
      return;
    }
    ctx.session.languageNextAction = undefined;
    await displayMenu(ctx, t(ctx.session.lang, "language_selected"));
    if (action === "start" && !ctx.session.isAdmin) await opts.onClientStart?.(ctx);
  });

  return { showMenu, restartFlow };
}

export function registerNavigationFallback(
  bot: Bot<PlatformBotContext>,
  controls: NavigationControls,
): void {
  const handleUnexpected = async (ctx: PlatformBotContext) => {
    if (ctx.session.payment) {
      await ctx.reply(t(ctx.session.lang, "receipt_invalid_file_type"), {
        reply_markup: navigationKeyboard(ctx),
      });
      return;
    }
    if (ctx.session.quiz || ctx.session.quickbook) {
      await ctx.reply(t(ctx.session.lang, "client_use_buttons"), {
        reply_markup: navigationKeyboard(ctx),
      });
      return;
    }
    await controls.showMenu(ctx);
  };

  bot.on("message:text", handleUnexpected);
  bot.on("message", handleUnexpected);
}
