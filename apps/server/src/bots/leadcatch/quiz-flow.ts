import { navigationKeyboard } from "../shared/client-menu.js";
import { randomUUID } from "node:crypto";
import { resolveCallbackId } from "../shared/callback-id.js";
import { quizButtonTag } from "./quiz-session.js";
export { handleLeadCatchContact, type LeadCatchContactOptions } from "./lead-submission.js";
import type { Lang, PrismaClient } from "@prisma/client";
import type { QuizNode, QuizOption } from "@lcqb/contracts";
import {
  getBotQuizConfig,
  sendQuizNode,
  sendQuizContactPrompt,
  sendCustomAnswerPrompt,
  resumeQuizStep,
} from "./quiz-prompts.js";
export { getBotQuizConfig, sendQuizNode } from "./quiz-prompts.js";
import type { TelegramTransport } from "../../adapters/telegram/transport.js";
import type { Logger } from "../../core/logger.js";
import type { PlatformBotContext } from "../../gateway/types.js";
import { t } from "../shared/i18n.js";

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

export async function startLeadCatchQuiz(
  ctx: PlatformBotContext,
  _prisma: PrismaClient,
): Promise<void> {
  const lang = (ctx.session.lang as Lang) ?? "RU";
  const config = getBotQuizConfig(ctx.botMeta.settings);
  const startNode = config.nodes.find((n) => n.id === config.startNodeId);

  if (!startNode) {
    delete ctx.session.quiz;
    await sendReply(ctx, t(lang, "bot_not_configured"));
    return;
  }

  // Initialize or reset quiz FSM in session
  ctx.session.quiz = {
    attemptId: randomUUID(),
    currentNodeId: startNode.id,
    stepCount: 1,
    answers: {},
    startedAt: Date.now(),
  };

  await sendQuizNode(ctx, startNode, lang);
}

export interface QuizOptionAnswerOptions {
  attemptTag?: string;
  nodeId: string;
  optionId: string;
  transport: TelegramTransport;
  logger: Logger;
}

export async function handleQuizOptionAnswer(
  ctx: PlatformBotContext,
  prisma: PrismaClient,
  opts: QuizOptionAnswerOptions,
): Promise<void> {
  const lang = (ctx.session.lang as Lang) ?? "RU";
  const config = getBotQuizConfig(ctx.botMeta.settings);
  const quiz = ctx.session.quiz;
  const stale = () => sendReply(ctx, t(lang, "quiz_stale_answer"));
  if (!quiz) {
    await sendReply(ctx, t(lang, "quiz_stale_answer"), { reply_markup: navigationKeyboard(ctx) });
    return;
  }
  if (opts.attemptTag ? opts.attemptTag !== quizButtonTag(ctx, config) : Boolean(quiz.attemptId)) {
    await stale();
    return;
  }
  const nodeId = resolveCallbackId(config.nodes, opts.nodeId);
  const currentNode = config.nodes.find((node) => node.id === nodeId);
  if (!currentNode || quiz.currentNodeId !== currentNode.id || quiz.answers[currentNode.id]) {
    await stale();
    // Redelivery recovers the current step after Telegram failed to send it.
    await resumeQuizStep(ctx, config);
    return;
  }
  const optionId = resolveCallbackId(currentNode.options, opts.optionId);
  const selectedOption = currentNode.options.find((option) => option.id === optionId);
  if (!selectedOption) {
    await stale();
    return;
  }

  if (selectedOption.inputType === "TEXT") {
    quiz.pendingText = {
      nodeId: currentNode.id,
      optionId: selectedOption.id,
      buttonTag: quizButtonTag(ctx, config),
    };
    await sendCustomAnswerPrompt(ctx);
    return;
  }
  await completeQuizAnswer(
    ctx,
    currentNode,
    selectedOption,
    lang === "UZ" ? selectedOption.text.uz : selectedOption.text.ru,
  );
}
export async function completeQuizAnswer(
  ctx: PlatformBotContext,
  node: QuizNode,
  option: QuizOption,
  answer: string,
): Promise<void> {
  const quiz = ctx.session.quiz!;
  const lang = ctx.session.lang ?? "RU";
  const config = getBotQuizConfig(ctx.botMeta.settings);
  quiz.answers[node.id] = {
    question: lang === "UZ" ? node.title.uz : node.title.ru,
    answer,
    optionId: option.id,
  };
  delete quiz.pendingText;
  if (option.nextNodeId) {
    const nextNode = config.nodes.find((item) => item.id === option.nextNodeId);
    if (nextNode) {
      quiz.currentNodeId = nextNode.id;
      quiz.stepCount += 1;
      await sendQuizNode(ctx, nextNode, lang);
      return;
    }
  }
  quiz.currentNodeId = "__contact__";
  await sendQuizContactPrompt(ctx, lang);
}
