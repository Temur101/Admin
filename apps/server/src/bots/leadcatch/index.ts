import { handleQuizTextAnswer, returnToQuizOptions } from "./text-answer.js";
import { sendCustomAnswerPrompt, sendQuizEditMenu } from "./quiz-prompts.js";
import type { PrismaClient } from "@prisma/client";
import type { Bot } from "grammy";
import type { TelegramTransport } from "../../adapters/telegram/transport.js";
import type { Logger } from "../../core/logger.js";
import type { PlatformBotContext } from "../../gateway/types.js";
import {
  getBotQuizConfig,
  handleLeadCatchContact,
  handleQuizBack,
  handleQuizJump,
  handleQuizOptionAnswer,
  handleQuizPhoneInput,
  startLeadCatchQuiz,
} from "./quiz-flow.js";
import { quizButtonTag } from "./quiz-session.js";
import { t } from "../shared/i18n.js";

export * from "./dag-validator.js";
export * from "./default-quiz.js";
export * from "./phone.js";
export * from "./quiz-flow.js";

export interface LeadCatchBotOptions {
  prisma: PrismaClient;
  transport: TelegramTransport;
  logger: Logger;
}

export function registerLeadCatchBot(
  bot: Bot<PlatformBotContext>,
  opts: LeadCatchBotOptions,
): void {
  const { prisma, transport, logger } = opts;

  bot.command("quiz", async (ctx) => {
    await startLeadCatchQuiz(ctx, prisma);
  });

  bot.callbackQuery(/^lc:(?:ans:([^:]+):|opt:)([^:]+):([^:]+)$/, async (ctx) => {
    const [, attemptTag, nodeId, optionId] = ctx.match;
    if (!nodeId || !optionId) return;
    await ctx.answerCallbackQuery().catch(() => {});
    await handleQuizOptionAnswer(ctx, prisma, { attemptTag, nodeId, optionId, transport, logger });
  });

  bot.callbackQuery(/^lc:back:([^:]+):([^:]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await returnToQuizOptions(ctx, ctx.match[1]!, ctx.match[2]!);
  });

  bot.callbackQuery(/^lc:prev:([^:]+):([^:]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await handleQuizBack(ctx, ctx.match[1]!);
  });

  bot.callbackQuery(/^lc:restart:([^:]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await startLeadCatchQuiz(ctx, prisma);
  });

  bot.callbackQuery(/^lc:confirm:([^:]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const tag = ctx.match[1]!;
    const quiz = ctx.session.quiz;
    const config = getBotQuizConfig(ctx.botMeta.settings);
    if (!quiz || quiz.currentNodeId !== "__summary__" || tag !== quizButtonTag(ctx, config)) {
      await ctx.api.sendMessage(
        ctx.chat?.id ?? ctx.from!.id,
        t(ctx.session.lang, "quiz_stale_answer"),
      );
      return;
    }
    await handleLeadCatchContact(ctx, prisma, { transport, logger });
  });

  bot.callbackQuery(/^lc:edit:([^:]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const tag = ctx.match[1]!;
    const quiz = ctx.session.quiz;
    const config = getBotQuizConfig(ctx.botMeta.settings);
    if (!quiz || quiz.currentNodeId !== "__summary__" || tag !== quizButtonTag(ctx, config)) {
      await ctx.api.sendMessage(
        ctx.chat?.id ?? ctx.from!.id,
        t(ctx.session.lang, "quiz_stale_answer"),
      );
      return;
    }
    await sendQuizEditMenu(ctx, ctx.session.lang ?? "RU");
  });

  bot.callbackQuery(/^lc:jump:([^:]+):([^:]+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await handleQuizJump(ctx, ctx.match[1]!, ctx.match[2]!);
  });

  bot.hears([t("RU", "btn_back"), t("UZ", "btn_back")], async (ctx, next) => {
    if (ctx.session.quiz) {
      await handleQuizBack(ctx);
      return;
    }
    return next();
  });

  bot.on("message:contact", async (ctx) => {
    if (ctx.session.quiz?.pendingText) {
      await sendCustomAnswerPrompt(ctx);
      return;
    }
    const contact = ctx.message.contact;
    if (!contact?.phone_number) return;

    if (contact.user_id === undefined || contact.user_id !== ctx.from?.id) {
      await ctx.api.sendMessage(
        ctx.chat?.id ?? ctx.from!.id,
        t(ctx.session.lang, "contact_not_own"),
      );
      return;
    }

    await handleQuizPhoneInput(ctx, {
      rawPhone: contact.phone_number,
      phoneVerified: true,
    });
  });

  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message.text?.trim() ?? "";

    if (text.startsWith("/")) return next();
    if (await handleQuizTextAnswer(ctx, ctx.message.text)) return;

    if (
      text.startsWith("/") ||
      text.startsWith("📋") ||
      text.startsWith("💳") ||
      text.startsWith("🌐") ||
      text.startsWith("🏠") ||
      text.startsWith("📝") ||
      text.startsWith("📅") ||
      text.startsWith("🔄") ||
      text.startsWith("⬅️") ||
      text.startsWith("🔔") ||
      text.startsWith("🔕")
    ) {
      return next();
    }

    if (ctx.session.quiz?.currentNodeId === "__contact__") {
      await handleQuizPhoneInput(ctx, {
        rawPhone: text,
        phoneVerified: false,
      });
      return;
    }

    return next();
  });

  bot.on("message", async (ctx, next) => {
    if (ctx.session.quiz?.pendingText) {
      await sendCustomAnswerPrompt(ctx);
    } else if (ctx.session.quiz?.currentNodeId === "__contact__") {
      await ctx.api.sendMessage(
        ctx.chat?.id ?? ctx.from!.id,
        t(ctx.session.lang, "unexpected_input_quiz"),
      );
    } else {
      await next();
    }
  });

  bot.catch((err) => {
    logger.error(
      {
        err: err.error instanceof Error ? err.error.message : String(err.error),
        botId: err.ctx.botMeta?.id,
        updateId: err.ctx.update?.update_id,
      },
      "LeadCatch bot error intercepted in bot.catch",
    );
  });
}
