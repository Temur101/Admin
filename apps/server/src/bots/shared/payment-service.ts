import type { PaymentReceipt, PrismaClient, ReceiptKind, SubStatus } from "@prisma/client";
import type { Redis } from "ioredis";
import { createBotApi, type TelegramTransport } from "../../adapters/telegram/transport.js";
import { decryptSecret } from "../../core/crypto.js";
import { env } from "../../core/env.js";
import type { Logger } from "../../core/logger.js";
import { t } from "./i18n.js";
import { addMonths } from "./subscription.js";

export function formatTashkentDateTime(date: Date): string {
  // Format as DD.MM.YYYY HH:mm in Tashkent time (UTC+5)
  const d = new Date(date.getTime() + 5 * 3600 * 1000);
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const year = d.getUTCFullYear();
  const hours = String(d.getUTCHours()).padStart(2, "0");
  const mins = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day}.${month}.${year} ${hours}:${mins}`;
}

export interface SubmitPaymentReceiptParams {
  prisma: PrismaClient;
  redis: Redis;
  botId: string;
  submittedByTgId: number | bigint;
  kind: ReceiptKind;
  months: number;
  amountUzs: number;
  imagePath?: string | null;
  telegramFileId?: string | null;
  textNote?: string | null;
  now?: Date;
}

export interface ApproveReceiptParams {
  prisma: PrismaClient;
  redis: Redis;
  receiptId: string;
  transport?: TelegramTransport;
  logger?: Logger;
}

export interface RejectReceiptParams {
  prisma: PrismaClient;
  redis: Redis;
  receiptId: string;
  reason: string;
  transport?: TelegramTransport;
  logger?: Logger;
  now?: Date;
}

/**
 * Submits a payment receipt (photo or text) and optimistically activates subscription.
 */
export async function submitPaymentReceipt(
  params: SubmitPaymentReceiptParams,
): Promise<{ receipt: PaymentReceipt; newPaidUntil: Date; newStatus: SubStatus }> {
  const {
    prisma,
    redis,
    botId,
    submittedByTgId,
    kind,
    months,
    amountUzs,
    imagePath,
    telegramFileId,
    textNote,
  } = params;
  const now = params.now ?? new Date();

  return prisma.$transaction(async (tx) => {
    const bot = await tx.bot.findUnique({
      where: { id: botId },
      include: { subscription: true },
    });

    if (!bot || !bot.subscription) {
      throw new Error("Bot or subscription not found");
    }

    if (bot.subscription.status === "BLOCKED") {
      throw new Error("SUBSCRIPTION_BLOCKED");
    }

    const currentSub = bot.subscription;
    const prevPaidUntil = currentSub.paidUntil;
    const prevStatus = currentSub.status;

    // If paidUntil is already in the future, extend from that future date; otherwise extend from now
    const baseDate = prevPaidUntil && prevPaidUntil.getTime() > now.getTime() ? prevPaidUntil : now;
    const newPaidUntil = addMonths(baseDate, months);
    const newStatus: SubStatus = "ACTIVE";

    // 1. Update subscription optimistically
    await tx.subscription.update({
      where: { id: currentSub.id },
      data: {
        status: newStatus,
        paidUntil: newPaidUntil,
      },
    });

    // 2. Create receipt record
    const receipt = await tx.paymentReceipt.create({
      data: {
        botId,
        submittedByTgId: BigInt(submittedByTgId),
        kind,
        imagePath: imagePath ?? null,
        telegramFileId: telegramFileId ?? null,
        textNote: textNote ?? null,
        months,
        amount: amountUzs,
        prevPaidUntil,
        prevStatus,
        grantedUntil: newPaidUntil,
        status: "PENDING",
      },
    });

    return { receipt, newPaidUntil, newStatus, botTokenHash: bot.botTokenHash, botId: bot.id };
  });

  // 3. Invalidate Redis cache AFTER transaction commit
  await redis.del(`bot:hash:${result.botTokenHash}`, `bot:id:${result.botId}`).catch(() => {});

  return { receipt: result.receipt, newPaidUntil: result.newPaidUntil, newStatus: result.newStatus };
}

/**
 * Approves a pending receipt. Resets failed attempts to 0. Idempotent.
 */
export async function approveReceipt(
  params: ApproveReceiptParams,
): Promise<PaymentReceipt | null> {
  const { prisma, redis, receiptId, transport, logger } = params;

  const result = await prisma.$transaction(async (tx) => {
    const receipt = await tx.paymentReceipt.findUnique({
      where: { id: receiptId },
      include: {
        bot: {
          include: {
            subscription: true,
            users: { where: { isAdmin: true } },
          },
        },
      },
    });

    if (!receipt || receipt.status !== "PENDING") {
      return receipt;
    }

    // 1. Mark receipt as APPROVED
    const updatedReceipt = await tx.paymentReceipt.update({
      where: { id: receiptId },
      data: {
        status: "APPROVED",
        reviewedAt: new Date(),
      },
      include: {
        bot: {
          include: {
            subscription: true,
            users: { where: { isAdmin: true } },
          },
        },
      },
    });

    // 2. Reset failed attempts
    if (receipt.bot.subscription) {
      await tx.subscription.update({
        where: { id: receipt.bot.subscription.id },
        data: { failedReceiptAttempts: 0 },
      });
    }

    return updatedReceipt;
  });

  if (!result || result.status !== "APPROVED") {
    return result;
  }

  // 3. Invalidate Redis cache AFTER transaction commit
  await redis.del(`bot:hash:${result.bot.botTokenHash}`, `bot:id:${result.bot.id}`).catch(() => {});

  // 4. Send Telegram push notification to admins if transport provided
  if (transport && result.bot.users.length > 0) {
    try {
      const token = decryptSecret(result.bot.botTokenEnc, env.TOKEN_ENCRYPTION_KEY);
      const api = createBotApi(token, result.bot.id, transport);

      for (const admin of result.bot.users) {
        const lang = admin.lang ?? "RU";
        const text = t(lang, "receipt_approved_push");
        await api.sendMessage(Number(admin.tgId), text).catch(() => {});
      }
    } catch (err) {
      logger?.error({ err: (err as Error).message }, "Failed to send approve notification");
    }
  }

  return result;
}

/**
 * Rejects a pending receipt. Rolls back granted subscription time. Idempotent.
 */
export async function rejectReceipt(
  params: RejectReceiptParams,
): Promise<PaymentReceipt | null> {
  const { prisma, redis, receiptId, reason, transport, logger } = params;
  const now = params.now ?? new Date();

  const result = await prisma.$transaction(async (tx) => {
    const receipt = await tx.paymentReceipt.findUnique({
      where: { id: receiptId },
      include: {
        bot: {
          include: {
            subscription: true,
            users: { where: { isAdmin: true } },
          },
        },
      },
    });

    if (!receipt || receipt.status !== "PENDING") {
      return receipt;
    }

    const sub = receipt.bot.subscription;
    const rolledBackPaidUntil = receipt.prevPaidUntil;
    const attempts = (sub?.failedReceiptAttempts ?? 0) + 1;

    let newStatus: SubStatus;
    if (rolledBackPaidUntil && rolledBackPaidUntil.getTime() > now.getTime()) {
      // Previously paid period is still valid in the future
      newStatus = "ACTIVE";
    } else {
      newStatus = attempts === 1 ? "GRACE_PERIOD" : "BLOCKED";
    }

    // 1. Rollback subscription
    if (sub) {
      await tx.subscription.update({
        where: { id: sub.id },
        data: {
          status: newStatus,
          paidUntil: rolledBackPaidUntil,
          failedReceiptAttempts: attempts,
        },
      });
    }

    // 2. Mark receipt as REJECTED
    const updatedReceipt = await tx.paymentReceipt.update({
      where: { id: receiptId },
      data: {
        status: "REJECTED",
        rejectionReason: reason,
        reviewedAt: now,
      },
      include: {
        bot: {
          include: {
            subscription: true,
            users: { where: { isAdmin: true } },
          },
        },
      },
    });

    return { updatedReceipt, newStatus, rolledBackPaidUntil };
  });

  if (!result || !("updatedReceipt" in result) || result.updatedReceipt.status !== "REJECTED") {
    return result as PaymentReceipt | null;
  }

  const { updatedReceipt, newStatus, rolledBackPaidUntil } = result;

  // 3. Invalidate Redis cache AFTER transaction commit
  await redis.del(`bot:hash:${updatedReceipt.bot.botTokenHash}`, `bot:id:${updatedReceipt.bot.id}`).catch(() => {});

  // 4. Send Telegram push notification to admins
  if (transport && updatedReceipt.bot.users.length > 0) {
    try {
      const token = decryptSecret(updatedReceipt.bot.botTokenEnc, env.TOKEN_ENCRYPTION_KEY);
      const api = createBotApi(token, updatedReceipt.bot.id, transport);

      for (const admin of updatedReceipt.bot.users) {
        const lang = admin.lang ?? "RU";
        let text: string;

        if (newStatus === "GRACE_PERIOD") {
          text = t(lang, "receipt_rejected_grace_push", { reason });
        } else if (newStatus === "BLOCKED") {
          text = t(lang, "receipt_rejected_blocked_push", {
            reason,
            support: env.SUPPORT_CONTACT,
          });
        } else {
          text = t(lang, "receipt_rejected_active_push", {
            reason,
            date: rolledBackPaidUntil ? formatTashkentDateTime(rolledBackPaidUntil) : "",
          });
        }

        await api.sendMessage(Number(admin.tgId), text).catch(() => {});
      }
    } catch (err) {
      logger?.error({ err: (err as Error).message }, "Failed to send reject notification");
    }
  }

  return updatedReceipt;
}
