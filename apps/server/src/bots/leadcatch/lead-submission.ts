import { navigationKeyboard } from "../shared/client-menu.js";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { PlatformBotContext } from "../../gateway/types.js";
import type { TelegramTransport } from "../../adapters/telegram/transport.js";
import type { Logger } from "../../core/logger.js";
import { t } from "../shared/i18n.js";
import { notifyAdmins } from "../shared/notification.js";
import { parseAndNormalizePhone } from "./phone.js";
import { quizAttemptId } from "./quiz-session.js";
import { sendQuizSummaryPrompt } from "./quiz-prompts.js";

export interface LeadCatchContactOptions {
  rawPhone?: string;
  phoneVerified?: boolean;
  transport: TelegramTransport;
  logger: Logger;
}

export async function handleQuizPhoneInput(
  ctx: PlatformBotContext,
  opts: { rawPhone: string; phoneVerified: boolean },
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

  quiz.phone = phone.normalized;
  quiz.phoneVerified = opts.phoneVerified;
  quiz.currentNodeId = "__summary__";
  await sendQuizSummaryPrompt(ctx, lang);
  return true;
}

export async function handleLeadCatchContact(
  ctx: PlatformBotContext,
  prisma: PrismaClient,
  opts: LeadCatchContactOptions,
): Promise<boolean> {
  const quiz = ctx.session.quiz;
  if (
    !ctx.from ||
    !quiz ||
    (quiz.currentNodeId !== "__contact__" && quiz.currentNodeId !== "__summary__")
  ) {
    return false;
  }
  const lang = ctx.session.lang ?? "RU";
  const rawPhoneInput = opts.rawPhone ?? quiz.phone ?? "";
  const phoneVerified = opts.phoneVerified ?? quiz.phoneVerified ?? false;
  const phone = parseAndNormalizePhone(rawPhoneInput);
  const reply = (text: string, extra?: Parameters<PlatformBotContext["reply"]>[1]) =>
    ctx.api.sendMessage(ctx.chat?.id ?? ctx.from!.id, text, extra);

  if (!phone.isValid || !phone.normalized) {
    await reply(t(lang, "quiz_invalid_phone"));
    return false;
  }

  const id = quizAttemptId(ctx);
  let lead;
  try {
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
        phoneVerified,
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
    const saved = lead.answers as unknown as typeof quiz.answers;
    for (const [key, value] of Object.entries(saved)) {
      answers[value.question || key] = value.answer;
    }
    try {
      const sentCount = await notifyAdmins(
        ctx.botMeta.id,
        {
          kind: "LEAD",
          leadId: lead.id,
          name: lead.customerName,
          phone: lead.phoneRaw,
          phoneVerified: lead.phoneVerified ?? phoneVerified,
          username: lead.customerUsername,
          answers,
        },
        { prisma, transport: opts.transport, logger: opts.logger },
      );
      if (sentCount > 0) {
        quiz.notifiedLeadId = lead.id;
      }
    } catch (err) {
      opts.logger.error(
        { err: err instanceof Error ? err.message : String(err), botId: ctx.botMeta.id },
        "Failed to dispatch admin lead notification",
      );
    }
  }

  await reply(t(lang, "quiz_thank_you"), { reply_markup: navigationKeyboard(ctx) });
  if (ctx.session.quiz === quiz) ctx.session.quiz = undefined;
  return true;
}
