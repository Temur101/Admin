import { navigationKeyboard } from "../shared/client-menu.js";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { PlatformBotContext } from "../../gateway/types.js";
import type { TelegramTransport } from "../../adapters/telegram/transport.js";
import type { Logger } from "../../core/logger.js";
import { t } from "../shared/i18n.js";
import { notifyAdmins } from "../shared/notification.js";
import { parseAndNormalizePhone } from "./phone.js";
import { quizAttemptId } from "./quiz-session.js";
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
  const quiz = ctx.session.quiz;
  if (!ctx.from || !quiz || quiz.currentNodeId !== "__contact__") return false;
  const lang = ctx.session.lang ?? "RU";
  const phone = parseAndNormalizePhone(opts.rawPhone);
  const reply = (text: string, extra?: Parameters<PlatformBotContext["reply"]>[1]) =>
    ctx.api.sendMessage(ctx.chat?.id ?? ctx.from!.id, text, extra);
  if (!phone.isValid || !phone.normalized) {
    await reply(t(lang, "quiz_invalid_phone"));
    return false;
  }
  const id = quizAttemptId(ctx);
  let lead;
  try {
    // The existing primary key makes one attempt atomic and idempotent, including concurrent retries.
    // A non-empty no-op update lets PostgreSQL use INSERT ... ON CONFLICT through Prisma upsert.
    lead = await prisma.lead.upsert({
      where: { id },
      update: { id },
      create: {
        id,
        botId: ctx.botMeta.id,
        customerTgId: BigInt(ctx.from.id),
        customerName: ctx.from.first_name ?? null,
        customerUsername: ctx.from.username ?? null,
        phoneRaw: phone.normalized,
        answers: quiz.answers as unknown as Prisma.InputJsonValue,
        isMasked: false,
      },
    });
    if (lead.botId !== ctx.botMeta.id || lead.customerTgId !== BigInt(ctx.from.id))
      throw new Error("Lead attempt ownership mismatch");
  } catch (err) {
    opts.logger.error(
      { err: err instanceof Error ? err.message : String(err), botId: ctx.botMeta.id },
      "Failed to save lead to database",
    );
    await reply(t(lang, "quiz_save_failed"));
    return false;
  }
  if (!quiz.notifiedLeadId) {
    const answers: Record<string, string> = {};
    // Use the persisted payload on retry; a second phone message must not change an accepted lead.
    const saved = lead.answers as unknown as typeof quiz.answers;
    for (const [key, value] of Object.entries(saved)) answers[value.question || key] = value.answer;
    try {
      await notifyAdmins(
        ctx.botMeta.id,
        {
          kind: "LEAD",
          name: lead.customerName,
          phone: lead.phoneRaw,
          username: lead.customerUsername,
          answers,
        },
        { prisma, transport: opts.transport, logger: opts.logger },
      );
      quiz.notifiedLeadId = lead.id;
    } catch (err) {
      opts.logger.error(
        { err: err instanceof Error ? err.message : String(err), botId: ctx.botMeta.id },
        "Failed to dispatch admin lead notification",
      );
    }
  }
  await reply(t(lang, "quiz_thank_you"), { reply_markup: navigationKeyboard(ctx) });
  // Keep the attempt and its answers if sending the confirmation fails; retry reuses the same DB key.
  if (ctx.session.quiz === quiz) ctx.session.quiz = undefined;
  return true;
}
