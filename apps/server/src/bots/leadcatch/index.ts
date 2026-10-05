import type { PrismaClient } from "@prisma/client";
import type { Bot } from "grammy";
import type { TelegramTransport } from "../../adapters/telegram/transport.js";
import type { Logger } from "../../core/logger.js";
import type { PlatformBotContext } from "../../gateway/types.js";
import {
  handleLeadCatchContact,
  handleQuizOptionAnswer,
  startLeadCatchQuiz,
} from "./quiz-flow.js";

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

  // 1. /quiz command allows manually restarting the quiz
  bot.command("quiz", async (ctx) => {
    await startLeadCatchQuiz(ctx, prisma);
  });

  // 2. Handle quiz option selection callbacks (lc:opt:<nodeId>:<optionId>)
  bot.callbackQuery(/^lc:opt:([^:]+):([^:]+)$/, async (ctx) => {
    const match = ctx.match;
    const nodeId = Array.isArray(match) ? match[1] : undefined;
    const optionId = Array.isArray(match) ? match[2] : undefined;

    if (!nodeId || !optionId) return;

    await ctx.answerCallbackQuery().catch(() => {});
    await handleQuizOptionAnswer(ctx, prisma, {
      nodeId,
      optionId,
      transport,
      logger,
    });
  });

  // 3. Handle contact received via Telegram native "request_contact" button
  bot.on("message:contact", async (ctx) => {
    const contact = ctx.message.contact;
    if (!contact?.phone_number) return;

    await handleLeadCatchContact(ctx, prisma, {
      rawPhone: contact.phone_number,
      transport,
      logger,
    });
  });

  // 4. Handle freeform text phone entry when user is on the contact step
  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message.text?.trim() ?? "";

    // Ignore commands or admin menu keywords
    if (text.startsWith("/") || text.startsWith("📋") || text.startsWith("💳") || text.startsWith("🌐")) {
      return next();
    }

    // Only process text as phone if user is on the __contact__ step
    if (ctx.session.quiz?.currentNodeId === "__contact__") {
      await handleLeadCatchContact(ctx, prisma, {
        rawPhone: text,
        transport,
        logger,
      });
      return;
    }

    return next();
  });

  // 5. Global error catcher: protects against crashes, customer never sees errors
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
