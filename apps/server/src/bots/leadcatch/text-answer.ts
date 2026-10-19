import { QuizFreeTextAnswerSchema, QUIZ_FREE_TEXT_MAX_LENGTH } from "@lcqb/contracts";
import type { PlatformBotContext } from "../../gateway/types.js";
import { resolveCallbackId } from "../shared/callback-id.js";
import { navigationKeyboard } from "../shared/client-menu.js";
import { t } from "../shared/i18n.js";
import { completeQuizAnswer } from "./quiz-flow.js";
import { getBotQuizConfig, resumeQuizStep, sendQuizNode } from "./quiz-prompts.js";
import { quizButtonTag } from "./quiz-session.js";
export async function handleQuizTextAnswer(
  ctx: PlatformBotContext,
  text: string,
): Promise<boolean> {
  const quiz = ctx.session.quiz;
  const pending = quiz?.pendingText;
  if (!quiz || !pending) return false;
  const config = getBotQuizConfig(ctx.botMeta.settings);
  const node = config.nodes.find((item) => item.id === pending.nodeId);
  const option = node?.options.find((item) => item.id === pending.optionId);
  if (
    !node ||
    option?.inputType !== "TEXT" ||
    quiz.currentNodeId !== node.id ||
    quiz.answers[node.id] ||
    pending.buttonTag !== quizButtonTag(ctx, config)
  ) {
    delete quiz.pendingText;
    await ctx.reply(t(ctx.session.lang, "quiz_stale_answer"));
    await resumeQuizStep(ctx, config);
    return true;
  }
  const result = QuizFreeTextAnswerSchema.safeParse(text);
  if (!result.success) {
    await ctx.reply(t(ctx.session.lang, "quiz_text_invalid", { max: QUIZ_FREE_TEXT_MAX_LENGTH }));
    return true;
  }
  await completeQuizAnswer(ctx, node, option, result.data);
  return true;
}
export async function returnToQuizOptions(
  ctx: PlatformBotContext,
  tag: string,
  nodeToken: string,
): Promise<void> {
  const quiz = ctx.session.quiz;
  const config = getBotQuizConfig(ctx.botMeta.settings);
  const nodeId = resolveCallbackId(config.nodes, nodeToken);
  const node = config.nodes.find((item) => item.id === nodeId);
  if (
    !quiz ||
    !node ||
    tag !== quizButtonTag(ctx, config) ||
    node.id !== quiz.currentNodeId ||
    quiz.answers[node.id]
  ) {
    await ctx.reply(
      t(ctx.session.lang, "quiz_stale_answer"),
      !quiz ? { reply_markup: navigationKeyboard(ctx) } : undefined,
    );
    return;
  }
  // Clear the pending input after a successful send, so retrying a failed return still works.
  await sendQuizNode(ctx, node, ctx.session.lang ?? "RU");
  delete quiz.pendingText;
}
