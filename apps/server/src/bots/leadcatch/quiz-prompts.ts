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
  const config = getBotQuizConfig(ctx.botMeta.settings);
  const tag = quizButtonTag(ctx, config);
  for (const opt of node.options) {
    keyboard
      .text(
        lang === "UZ" ? opt.text.uz : opt.text.ru,
        `lc:ans:${tag}:${callbackId(node.id)}:${callbackId(opt.id)}`,
      )
      .row();
  }

  const hasHistory =
    (ctx.session.quiz?.path?.length ?? 0) > 0 ||
    Object.keys(ctx.session.quiz?.answers ?? {}).length > 0;
  if (hasHistory) {
    keyboard
      .text(t(lang, "btn_back"), `lc:prev:${tag}:${callbackId(node.id)}`)
      .text(t(lang, "btn_restart"), `lc:restart:${tag}`)
      .row();
  }

  await ctx.api.sendMessage(
    ctx.chat?.id ?? ctx.from!.id,
    lang === "UZ" ? node.title.uz : node.title.ru,
    { reply_markup: keyboard },
  );
}

export async function sendQuizContactPrompt(ctx: PlatformBotContext, lang: Lang): Promise<void> {
  const chatId = ctx.chat?.id ?? ctx.from!.id;
  await ctx.api.sendMessage(chatId, t(lang, "quiz_prompt_phone"), {
    reply_markup: contactKeyboard(ctx),
  });
}

export async function sendQuizSummaryPrompt(ctx: PlatformBotContext, lang: Lang): Promise<void> {
  const quiz = ctx.session.quiz;
  if (!quiz) return;
  const config = getBotQuizConfig(ctx.botMeta.settings);
  const tag = quizButtonTag(ctx, config);

  const orderedIds =
    quiz.path && quiz.path.length > 0 ? quiz.path : Object.keys(quiz.answers);
  const lines = orderedIds
    .map((nodeId) => {
      const entry = quiz.answers[nodeId];
      if (!entry) return null;
      return `• ${entry.question}: ${entry.answer}`;
    })
    .filter((v): v is string => Boolean(v));

  const verifiedLabel = t(
    lang,
    quiz.phoneVerified ? "phone_verified_badge" : "phone_unverified_badge",
  );
  const text = t(lang, "quiz_summary_title", {
    summary: lines.join("\n"),
    phone: quiz.phone ?? "—",
    verified: verifiedLabel,
  });

  const keyboard = new InlineKeyboard()
    .text(t(lang, "btn_confirm_submit"), `lc:confirm:${tag}`)
    .row()
    .text(t(lang, "btn_edit_field"), `lc:edit:${tag}`)
    .text(t(lang, "btn_back"), `lc:prev:${tag}:__summary__`)
    .row()
    .text(t(lang, "btn_restart"), `lc:restart:${tag}`);

  await ctx.api.sendMessage(ctx.chat?.id ?? ctx.from!.id, text, {
    reply_markup: keyboard,
  });
}

export async function sendQuizEditMenu(ctx: PlatformBotContext, lang: Lang): Promise<void> {
  const quiz = ctx.session.quiz;
  if (!quiz) return;
  const config = getBotQuizConfig(ctx.botMeta.settings);
  const tag = quizButtonTag(ctx, config);
  const orderedIds =
    quiz.path && quiz.path.length > 0 ? quiz.path : Object.keys(quiz.answers);

  const keyboard = new InlineKeyboard();
  orderedIds.forEach((nodeId, idx) => {
    const entry = quiz.answers[nodeId];
    const title = entry?.question ?? nodeId;
    const shortTitle = title.length > 32 ? `${title.slice(0, 32)}…` : title;
    keyboard
      .text(`${idx + 1}. ${shortTitle}`, `lc:jump:${tag}:${callbackId(nodeId)}`)
      .row();
  });

  keyboard
    .text(t(lang, "btn_edit_phone"), `lc:jump:${tag}:__contact__`)
    .row()
    .text(t(lang, "btn_back"), `lc:jump:${tag}:__summary__`);

  await ctx.api.sendMessage(ctx.chat?.id ?? ctx.from!.id, t(lang, "quiz_edit_choose_field"), {
    reply_markup: keyboard,
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
  const lang = ctx.session.lang ?? "RU";
  if (quiz.currentNodeId === "__summary__") {
    await sendQuizSummaryPrompt(ctx, lang);
  } else if (quiz.currentNodeId === "__contact__") {
    await sendQuizContactPrompt(ctx, lang);
  } else if (quiz.pendingText) {
    await sendCustomAnswerPrompt(ctx);
  } else {
    const node = config.nodes.find((item) => item.id === quiz.currentNodeId);
    if (node) await sendQuizNode(ctx, node, lang);
  }
}
