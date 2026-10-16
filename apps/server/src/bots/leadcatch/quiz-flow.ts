import type { Lang, Prisma, PrismaClient } from "@prisma/client";
import { InlineKeyboard, Keyboard } from "grammy";
import type { QuizConfig, QuizNode } from "@lcqb/contracts";
import { QuizConfigSchema, createEmptyQuizConfig } from "@lcqb/contracts";
import type { TelegramTransport } from "../../adapters/telegram/transport.js";
import type { Logger } from "../../core/logger.js";
import type { PlatformBotContext } from "../../gateway/types.js";
import { t } from "../shared/i18n.js";
import { notifyAdmins } from "../shared/notification.js";
import { validateQuizDag } from "./dag-validator.js";
import { DEFAULT_LEADCATCH_QUIZ } from "./default-quiz.js";
import { parseAndNormalizePhone } from "./phone.js";

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

export function getBotQuizConfig(settings: Record<string, unknown> | undefined): QuizConfig {
  if (!settings || typeof settings !== "object") {
    return DEFAULT_LEADCATCH_QUIZ;
  }
  const raw = "quiz" in settings ? settings.quiz : settings;
  if (
    raw &&
    typeof raw === "object" &&
    "nodes" in raw &&
    Array.isArray(raw.nodes) &&
    raw.nodes.length === 0
  )
    return createEmptyQuizConfig();
  const parsed = QuizConfigSchema.safeParse(raw);
  if (parsed.success && validateQuizDag(parsed.data).valid) {
    return parsed.data;
  }
  return DEFAULT_LEADCATCH_QUIZ;
}

export async function sendQuizNode(
  ctx: PlatformBotContext,
  node: QuizNode,
  lang: Lang,
): Promise<void> {
  const title = lang === "UZ" ? node.title.uz : node.title.ru;
  const keyboard = new InlineKeyboard();

  for (const opt of node.options) {
    const text = lang === "UZ" ? opt.text.uz : opt.text.ru;
    keyboard.text(text, `lc:opt:${node.id}:${opt.id}`).row();
  }

  await sendReply(ctx, title, {
    reply_markup: keyboard,
  });
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
    currentNodeId: startNode.id,
    stepCount: 1,
    answers: {},
    startedAt: Date.now(),
  };

  await sendQuizNode(ctx, startNode, lang);
}

export interface QuizOptionAnswerOptions {
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
  const { nodeId, optionId } = opts;

  // If session expired or was not started, restart quiz
  if (!ctx.session.quiz) {
    await startLeadCatchQuiz(ctx, prisma);
    return;
  }

  const currentNode = config.nodes.find((n) => n.id === nodeId);
  if (!currentNode) {
    await startLeadCatchQuiz(ctx, prisma);
    return;
  }

  const selectedOption = currentNode.options.find((o) => o.id === optionId);
  if (!selectedOption) {
    return;
  }

  // Record answer
  const qTitle = lang === "UZ" ? currentNode.title.uz : currentNode.title.ru;
  const optText = lang === "UZ" ? selectedOption.text.uz : selectedOption.text.ru;

  ctx.session.quiz.answers[currentNode.id] = {
    question: qTitle,
    answer: optText,
    optionId: selectedOption.id,
  };

  // Check if there is a next question
  if (selectedOption.nextNodeId) {
    const nextNode = config.nodes.find((n) => n.id === selectedOption.nextNodeId);
    if (nextNode) {
      ctx.session.quiz.currentNodeId = nextNode.id;
      ctx.session.quiz.stepCount += 1;
      await sendQuizNode(ctx, nextNode, lang);
      return;
    }
  }

  // Terminal node reached -> transition to CONTACT step
  ctx.session.quiz.currentNodeId = "__contact__";

  const keyboard = new Keyboard()
    .requestContact(t(lang, "quiz_btn_share_phone"))
    .resized()
    .oneTime();

  await sendReply(ctx, t(lang, "quiz_prompt_phone"), {
    reply_markup: keyboard,
  });
}

export interface LeadCatchContactOptions {
  rawPhone: string;
  transport: TelegramTransport;
  logger: Logger;
}

export async function handleLeadCatchContact(
  ctx: PlatformBotContext,
  prisma: PrismaClient,
  opts: LeadCatchContactOptions,
): Promise<boolean> {
  const lang = (ctx.session.lang as Lang) ?? "RU";
  const { rawPhone, transport, logger } = opts;

  const phoneRes = parseAndNormalizePhone(rawPhone);
  if (!phoneRes.isValid || !phoneRes.normalized) {
    await sendReply(ctx, t(lang, "quiz_invalid_phone"));
    return false;
  }

  const normalizedPhone = phoneRes.normalized;
  const answersRecord = ctx.session.quiz?.answers ?? {};

  // 1. Persist lead in PostgreSQL (idempotent against retry of same attempt)
  try {
    const startedAt = ctx.session.quiz?.startedAt;
    const existing = await prisma.lead.findFirst({
      where: {
        botId: ctx.botMeta.id,
        customerTgId: BigInt(ctx.from?.id ?? 0),
        phoneRaw: normalizedPhone,
        ...(startedAt ? { createdAt: { gte: new Date(startedAt - 10000) } } : {}),
      },
    });

    if (!existing) {
      await prisma.lead.create({
        data: {
          botId: ctx.botMeta.id,
          customerTgId: BigInt(ctx.from?.id ?? 0),
          customerName: ctx.from?.first_name ?? null,
          customerUsername: ctx.from?.username ?? null,
          phoneRaw: normalizedPhone,
          answers: answersRecord as unknown as Prisma.InputJsonValue,
          isMasked: false,
        },
      });
    }
  } catch (err) {
    logger.error(
      { err: (err as Error).message, botId: ctx.botMeta.id },
      "Failed to save lead to database",
    );
  }

  // 2. Format answers for admin notification
  const answersSummary: Record<string, string> = {};
  for (const [key, val] of Object.entries(answersRecord)) {
    answersSummary[val.question || key] = val.answer;
  }

  // 3. Notify bot administrators (with automatic contact masking if subscription is inactive)
  try {
    await notifyAdmins(
      ctx.botMeta.id,
      {
        kind: "LEAD",
        name: ctx.from?.first_name ?? null,
        phone: normalizedPhone,
        username: ctx.from?.username ?? null,
        answers: answersSummary,
      },
      {
        prisma,
        transport,
        logger,
      },
    );
  } catch (err) {
    logger.error(
      { err: (err as Error).message, botId: ctx.botMeta.id },
      "Failed to dispatch admin lead notification",
    );
  }

  // 4. Clear quiz session state
  ctx.session.quiz = undefined;

  // 5. Send polite thank-you message to customer and remove phone request keyboard
  await sendReply(ctx, t(lang, "quiz_thank_you"), {
    reply_markup: { remove_keyboard: true },
  });

  return true;
}
