import type { Lang, PrismaClient } from "@prisma/client";
import type { Bot } from "grammy";
import type { Redis } from "ioredis";
import type { TelegramTransport } from "../../adapters/telegram/transport.js";
import { decryptSecret } from "../../core/crypto.js";
import { env } from "../../core/env.js";
import type { PlatformBotContext } from "../../gateway/types.js";
import { buildTariffInlineKeyboard, resolveTariffPrices } from "./admin-menu.js";
import { t } from "./i18n.js";
import { submitPaymentReceipt } from "./payment-service.js";
import { saveReceiptImage, validateImageBuffer } from "./receipt-storage.js";
import { notifyPlatformOwner } from "../../core/platform-notifier.js";
import type { Logger } from "../../core/logger.js";
import { can } from "./permissions.js";
import { getBotAdminUser } from "./user-service.js";

export interface ReceiptHandlersOptions {
  redis?: Redis;
  transport?: TelegramTransport;
  uploadDir?: string;
  logger?: Logger;
}

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

function pendingReceiptText(lang: Lang): string {
  return lang === "UZ"
    ? "Sizning oldingi chekingiz tekshirilmoqda. Iltimos, administrator qarorini kuting."
    : "Ваш предыдущий чек уже находится на проверке. Пожалуйста, дождитесь решения администратора.";
}

async function processFileReceipt(
  ctx: PlatformBotContext,
  fileId: string,
  fileSize: number | undefined,
  prisma: PrismaClient,
  opts?: ReceiptHandlersOptions,
): Promise<void> {
  if (!ctx.session.payment || !ctx.from) return;

  const user = await getBotAdminUser(prisma, ctx.botMeta.id, ctx.from.id);
  if (!user || !can(user, "PAY_SUBSCRIPTION")) return;
  const lang = user.lang ?? (ctx.session.lang as Lang) ?? "RU";
  ctx.session.isAdmin = true;
  ctx.session.adminRole = user.role;
  ctx.session.lang = lang;

  if (fileSize && fileSize > 5 * 1024 * 1024) {
    await sendReply(ctx, t(lang, "receipt_photo_too_large"));
    return;
  }

  if (!opts?.transport || !opts?.redis) return;

  try {
    const file = await ctx.api.getFile(fileId);
    if (file.file_size && file.file_size > 5 * 1024 * 1024) {
      await sendReply(ctx, t(lang, "receipt_photo_too_large"));
      return;
    }
    if (!file.file_path) {
      await sendReply(ctx, t(lang, "receipt_invalid_file_type"));
      return;
    }

    const token = decryptSecret(ctx.botMeta.botTokenEnc, env.TOKEN_ENCRYPTION_KEY);
    const buffer = await opts.transport.downloadFile(token, file.file_path);

    const validation = validateImageBuffer(buffer);
    if (!validation.valid || !validation.ext) {
      await sendReply(ctx, t(lang, "receipt_invalid_file_type"));
      return;
    }

    const uploadDir = opts.uploadDir ?? env.UPLOAD_DIR;
    const savedPath = await saveReceiptImage(buffer, uploadDir, validation.ext);

    const res = await submitPaymentReceipt({
      prisma,
      redis: opts.redis,
      botId: ctx.botMeta.id,
      submittedByTgId: ctx.from.id,
      kind: "PHOTO",
      months: ctx.session.payment.months,
      amountUzs: ctx.session.payment.amountUzs,
      imagePath: savedPath,
      textNote:
        ctx.message && "caption" in ctx.message ? ctx.message.caption?.trim() || null : null,
      telegramFileId: fileId,
    });

    ctx.botMeta.subscriptionStatus = res.newStatus;
    ctx.botMeta.paidUntil = res.newPaidUntil?.toISOString() ?? null;
    ctx.session.payment = undefined;

    await sendReply(
      ctx,
      t(lang, "receipt_submitted_success"),
    );

    notifyPlatformOwner(
      {
        type: "NEW_RECEIPT",
        botName: ctx.botMeta.botUsername ? `@${ctx.botMeta.botUsername}` : ctx.botMeta.id,
        clientName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || "Admin",
        phone: user.username ? `@${user.username}` : String(ctx.from.id),
        tariffMonths: res.receipt.months,
        amountUzs: res.receipt.amount,
        receiptId: res.receipt.id,
      },
      { prisma, transport: opts?.transport, logger: opts?.logger },
    ).catch(() => {});
  } catch (err) {
    await sendReply(
      ctx,
      (err as Error)?.message === "PENDING_RECEIPT_EXISTS"
        ? pendingReceiptText(lang)
        : t(lang, "receipt_invalid_file_type"),
    );
  }
}

export function registerReceiptHandlers(
  bot: Bot<PlatformBotContext>,
  prisma: PrismaClient,
  opts?: ReceiptHandlersOptions,
): void {
  bot.callbackQuery("admin:pay", async (ctx) => {
    if (!ctx.from) return;
    const user = await getBotAdminUser(prisma, ctx.botMeta.id, ctx.from.id);
    if (!user || !can(user, "PAY_SUBSCRIPTION")) {
      await ctx
        .answerCallbackQuery({
          text: user ? t(ctx.session.lang, "owner_only_action") : "Доступ запрещен / Ruxsat yo'q",
          show_alert: true,
        })
        .catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});
    const lang = user.lang ?? (ctx.session.lang as Lang) ?? "RU";
    ctx.session.isAdmin = true;
    ctx.session.adminRole = user.role;
    ctx.session.lang = lang;

    if (ctx.botMeta.subscriptionStatus === "BLOCKED") {
      await sendReply(ctx, t(lang, "sub_blocked_alert", { support: env.SUPPORT_CONTACT }));
      return;
    }

    const settings = await prisma.platformSettings.findUnique({ where: { id: 1 } });
    const tariffs = resolveTariffPrices(settings);

    await sendReply(ctx, t(lang, "pay_select_tariff"), {
      reply_markup: buildTariffInlineKeyboard(lang, tariffs),
    });
  });

  bot.callbackQuery(/^pay:tariff:(\d+)$/, async (ctx) => {
    if (!ctx.from) return;
    const user = await getBotAdminUser(prisma, ctx.botMeta.id, ctx.from.id);
    if (!user || !can(user, "PAY_SUBSCRIPTION")) {
      await ctx
        .answerCallbackQuery({
          text: user ? t(ctx.session.lang, "owner_only_action") : "Доступ запрещен / Ruxsat yo'q",
          show_alert: true,
        })
        .catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});
    const lang = user.lang ?? (ctx.session.lang as Lang) ?? "RU";
    ctx.session.isAdmin = true;
    ctx.session.adminRole = user.role;
    ctx.session.lang = lang;

    if (ctx.botMeta.subscriptionStatus === "BLOCKED") {
      await sendReply(ctx, t(lang, "sub_blocked_alert", { support: env.SUPPORT_CONTACT }));
      return;
    }

    const matchStr = Array.isArray(ctx.match) ? ctx.match[1] : "1";
    const months = Number(matchStr ?? 1);
    const settings = await prisma.platformSettings.findUnique({ where: { id: 1 } });
    const tariffs = resolveTariffPrices(settings);
    if (![1, 6, 12].includes(months)) {
      ctx.session.payment = undefined;
      await sendReply(ctx, t(lang, "pay_select_tariff"), {
        reply_markup: buildTariffInlineKeyboard(lang, tariffs),
      });
      return;
    }

    const amount =
      months === 1 ? tariffs.tariff1m : months === 6 ? tariffs.tariff6m : tariffs.tariff12m;
    const details = settings?.paymentDetails || "8600 0000 0000 0000 (Platform)";

    ctx.session.payment = { months, amountUzs: amount };
    await sendReply(
      ctx,
      t(lang, "pay_details_prompt", { amount: amount.toLocaleString("ru-RU"), details }),
    );
  });

  bot.on("message:photo", async (ctx, next) => {
    if (!ctx.session.payment || !ctx.from) return next();
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    if (!photo) return;
    await processFileReceipt(ctx, photo.file_id, photo.file_size, prisma, opts);
  });

  bot.on("message:document", async (ctx, next) => {
    if (!ctx.session.payment || !ctx.from) return next();
    const doc = ctx.message.document;
    if (!doc) return;
    await processFileReceipt(ctx, doc.file_id, doc.file_size, prisma, opts);
  });

  bot.on("message:text", async (ctx, next) => {
    if (!ctx.session.payment || !ctx.from) return next();

    const user = await getBotAdminUser(prisma, ctx.botMeta.id, ctx.from.id);
    if (!user || !can(user, "PAY_SUBSCRIPTION")) return next();
    const lang = user.lang ?? (ctx.session.lang as Lang) ?? "RU";
    ctx.session.isAdmin = true;
    ctx.session.adminRole = user.role;
    ctx.session.lang = lang;

    const text = (ctx.message.text ?? "").trim();
    if (text.startsWith("/")) {
      ctx.session.payment = undefined;
      return next();
    }
    if (text.length < 10) {
      await sendReply(ctx, t(lang, "receipt_text_too_short"));
      return;
    }
    if (text.length > 1000) {
      await sendReply(ctx, t(lang, "receipt_text_too_long"));
      return;
    }
    if (!opts?.redis) return;

    try {
      const res = await submitPaymentReceipt({
        prisma,
        redis: opts.redis,
        botId: ctx.botMeta.id,
        submittedByTgId: ctx.from.id,
        kind: "TEXT",
        months: ctx.session.payment.months,
        amountUzs: ctx.session.payment.amountUzs,
        textNote: text,
      });

      ctx.botMeta.subscriptionStatus = res.newStatus;
      ctx.botMeta.paidUntil = res.newPaidUntil?.toISOString() ?? null;
      ctx.session.payment = undefined;

      await sendReply(
        ctx,
        t(lang, "receipt_submitted_success"),
      );

      notifyPlatformOwner(
        {
          type: "NEW_RECEIPT",
          botName: ctx.botMeta.botUsername ? `@${ctx.botMeta.botUsername}` : ctx.botMeta.id,
          clientName:
            [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || "Admin",
          phone: user.username ? `@${user.username}` : String(ctx.from.id),
          tariffMonths: res.receipt.months,
          amountUzs: res.receipt.amount,
          receiptId: res.receipt.id,
        },
        { prisma, transport: opts?.transport, logger: opts?.logger },
      ).catch(() => {});
    } catch (err) {
      await sendReply(
        ctx,
        (err as Error)?.message === "PENDING_RECEIPT_EXISTS"
          ? pendingReceiptText(lang)
          : t(lang, "receipt_invalid_file_type"),
      );
    }
  });
}
