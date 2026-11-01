import { navigationKeyboard } from "../shared/client-menu.js";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { PlatformBotContext } from "../../gateway/types.js";
import type { TelegramTransport } from "../../adapters/telegram/transport.js";
import type { Logger } from "../../core/logger.js";
import { t } from "../shared/i18n.js";
import {
  enqueueAdminNotifications,
  dispatchQueuedNotifications,
} from "../shared/notification-outbox.js";
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

  const sender = ctx.from;
  const normalizedPhone = phone.normalized;
  const id = quizAttemptId(ctx);
  let lead;
  try {
    lead = await prisma.$transaction(async (tx) => {
      const savedLead = await tx.lead.upsert({
        where: { id },
        update: { id },
        create: {
          id,
          botId: ctx.botMeta.id,
          customerTgId: BigInt(sender.id),
          customerName: sender.first_name ?? null,
          customerUsername: sender.username ?? null,
          phoneRaw: normalizedPhone,
          phoneVerified,
          answers: quiz.answers as unknown as Prisma.InputJsonValue,
          isMasked: false,
        },
      });
      if (savedLead.botId !== ctx.botMeta.id || savedLead.customerTgId !== BigInt(ctx.from!.id))
        throw new Error("Lead attempt ownership mismatch");
      const answers: Record<string, string> = {};
      for (const [key, value] of Object.entries(
        savedLead.answers as unknown as typeof quiz.answers,
      ))
        answers[value.question || key] = value.answer;
      await enqueueAdminNotifications(tx, ctx.botMeta.id, `lead:${savedLead.id}`, {
        kind: "LEAD",
        leadId: savedLead.id,
        name: savedLead.customerName,
        phone: savedLead.phoneRaw,
        phoneVerified: savedLead.phoneVerified,
        username: savedLead.customerUsername,
        answers,
      });
      return savedLead;
    });
  } catch (err) {
    opts.logger.error(
      { err: err instanceof Error ? err.message : String(err), botId: ctx.botMeta.id },
      "Failed to save lead to database",
    );
    await reply(t(lang, "quiz_save_failed"));
    return false;
  }

  await dispatchQueuedNotifications({
    prisma,
    transport: opts.transport,
    logger: opts.logger,
    eventKey: `lead:${lead.id}`,
  });

  await reply(t(lang, "quiz_thank_you"), { reply_markup: navigationKeyboard(ctx) });
  if (ctx.session.quiz === quiz) ctx.session.quiz = undefined;
  return true;
}
