import { createHash } from "node:crypto";
import type { QuizConfig } from "@lcqb/contracts";
import type { PlatformBotContext } from "../../gateway/types.js";
/** A legacy Redis session gets the same key on retry, including after a process restart. */
export function quizAttemptId(ctx: PlatformBotContext): string {
  const quiz = ctx.session.quiz;
  if (!quiz) throw new Error("Quiz session is required");
  if (quiz.attemptId) return quiz.attemptId;
  const bytes = createHash("sha256")
    .update(JSON.stringify([ctx.botMeta.id, ctx.from?.id, quiz.startedAt]))
    .digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function quizButtonTag(ctx: PlatformBotContext, config: QuizConfig): string {
  return createHash("sha256")
    .update(JSON.stringify([quizAttemptId(ctx), config]))
    .digest("hex")
    .slice(0, 12);
}
