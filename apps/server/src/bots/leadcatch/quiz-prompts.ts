import { InlineKeyboard } from "grammy";
import {
  QuizConfigSchema,
  createEmptyQuizConfig,
  QUIZ_FREE_TEXT_MAX_LENGTH,
  type QuizConfig,
  type QuizNode,
} from "@lcqb/contracts";
import type { Lang } from "@prisma/client";
import type { PlatformBotContext } from "../../gateway/types.js";
import { contactKeyboard } from "../shared/client-menu.js";
import { callbackId } from "../shared/callback-id.js";
import { t } from "../shared/i18n.js";
import { quizButtonTag } from "./quiz-session.js";
import { validateQuizDag } from "./dag-validator.js";
import { DEFAULT_LEADCATCH_QUIZ } from "./default-quiz.js";
export function getBotQuizConfig(settings: Record<string, unknown> | undefined): QuizConfig {
  if (!settings || typeof settings !== "object") return DEFAULT_LEADCATCH_QUIZ;
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
  if (parsed.success && validateQuizDag(parsed.data).valid) return parsed.data;
  return DEFAULT_LEADCATCH_QUIZ;
}
export async function sendQuizNode(
  ctx: PlatformBotContext,
  node: QuizNode,
  lang: Lang,
): Promise<void> {
  const keyboard = new InlineKeyboard();
  const tag = quizButtonTag(ctx, getBotQuizConfig(ctx.botMeta.settings));
  for (const opt of node.options)
    keyboard
      .text(
        lang === "UZ" ? opt.text.uz : opt.text.ru,
        `lc:ans:${tag}:${callbackId(node.id)}:${callbackId(opt.id)}`,
      )
      .row();
  await ctx.api.sendMessage(
    ctx.chat?.id ?? ctx.from!.id,
    lang === "UZ" ? node.title.uz : node.title.ru,
    { reply_markup: keyboard },
  );
}
export async function sendQuizContactPrompt(ctx: PlatformBotContext, lang: Lang): Promise<void> {
  await ctx.api.sendMessage(ctx.chat?.id ?? ctx.from!.id, t(lang, "quiz_prompt_phone"), {
    reply_markup: contactKeyboard(ctx),
  });
}
export async function sendCustomAnswerPrompt(ctx: PlatformBotContext): Promise<void> {
  const pending = ctx.session.quiz!.pendingText!;
  await ctx.api.sendMessage(
    ctx.chat?.id ?? ctx.from!.id,
    t(ctx.session.lang, "quiz_text_prompt", { max: QUIZ_FREE_TEXT_MAX_LENGTH }),
    {
      reply_markup: new InlineKeyboard().text(
        t(ctx.session.lang, "quiz_text_back"),
        `lc:back:${pending.buttonTag}:${callbackId(pending.nodeId)}`,
      ),
    },
  );
}
export async function resumeQuizStep(ctx: PlatformBotContext, config: QuizConfig): Promise<void> {
  const quiz = ctx.session.quiz;
  if (!quiz) return;
  if (quiz.currentNodeId === "__contact__")
    await sendQuizContactPrompt(ctx, ctx.session.lang ?? "RU");
  else if (quiz.pendingText) await sendCustomAnswerPrompt(ctx);
  else {
    const node = config.nodes.find((item) => item.id === quiz.currentNodeId);
    if (node) await sendQuizNode(ctx, node, ctx.session.lang ?? "RU");
  }
}
