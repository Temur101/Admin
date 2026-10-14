import type { PaymentReceipt, PrismaClient, ReceiptKind, SubStatus } from "@prisma/client";
import type { Redis } from "ioredis";
import type { TelegramTransport } from "../../adapters/telegram/transport.js";
import type { Logger } from "../../core/logger.js";
import { addMonths } from "./subscription.js";

import {
  formatTashkentDateTime,
  sendReceiptApprovedNotification,
  sendReceiptRejectedNotification,
} from "./payment-notifications.js";
import { notifyPlatformOwner } from "../../core/platform-notifier.js";
export { formatTashkentDateTime };

export interface SubmitPaymentReceiptParams {
  prisma: PrismaClient;
  redis?: Redis;
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
  redis?: Redis;
  receiptId: string;
  transport?: TelegramTransport;
  logger?: Logger;
}

export interface RejectReceiptParams {
  prisma: PrismaClient;
  redis?: Redis;
  receiptId: string;
  reason: string;
  transport?: TelegramTransport;
  logger?: Logger;
  now?: Date;
}

/**
 * Submits a payment receipt (photo or text) and optimistically activates subscription.
 * Serialized via PostgreSQL transactional advisory lock per bot subscription.
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

  const result = await prisma.$transaction(
    async (tx) => {
      // Advisory transaction lock serializes subscription modifications for this bot
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sub:${botId}`}));`;

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

      // Enforce single PENDING receipt constraint under advisory lock to prevent stacking / race conditions
      const existingPending = await tx.paymentReceipt.findFirst({
        where: {
          botId,
          status: "PENDING",
        },
      });

      if (existingPending) {
        throw new Error("PENDING_RECEIPT_EXISTS");
      }

      const currentSub = bot.subscription;
      const prevPaidUntil = currentSub.paidUntil;
      const prevStatus = currentSub.status;

      // Base date: if already in future, extend from future; otherwise extend from now
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
    },
    { maxWait: 15000, timeout: 20000 },
  );

  // 3. Invalidate Redis cache AFTER transaction commit
  if (redis) {
    await redis.del(`bot:hash:${result.botTokenHash}`, `bot:id:${result.botId}`).catch(() => {});
  }

  return { receipt: result.receipt, newPaidUntil: result.newPaidUntil, newStatus: result.newStatus };
}

/**
 * Approves a pending receipt. Resets failed attempts to 0.
 * Enforces single terminal state transition and idempotent notifications.
 */
export async function approveReceipt(
  params: ApproveReceiptParams,
): Promise<PaymentReceipt | null> {
  const { prisma, redis, receiptId, transport, logger } = params;

  const result = await prisma.$transaction(
    async (tx) => {
      // 1. Transactional advisory lock on receipt
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receipt:${receiptId}`}));`;

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

      if (!receipt) {
        return null;
      }

      // If already transitioned (terminal state): idempotent no-op
      if (receipt.status !== "PENDING") {
        return { alreadyHandled: true, receipt };
      }

      // Lock subscription to serialize state change
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sub:${receipt.botId}`}));`;

      // 2. Mark receipt as APPROVED
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

      // 3. Reset failed attempts
      if (receipt.bot.subscription) {
        await tx.subscription.update({
          where: { id: receipt.bot.subscription.id },
          data: { failedReceiptAttempts: 0 },
        });
      }

      return { alreadyHandled: false, receipt: updatedReceipt };
    },
    { maxWait: 15000, timeout: 20000 },
  );

  if (!result) return null;
  const receipt = result.receipt;

  if (result.alreadyHandled) {
    return receipt;
  }

  // 4. Invalidate Redis cache AFTER transaction commit
  if (redis) {
    await redis.del(`bot:hash:${receipt.bot.botTokenHash}`, `bot:id:${receipt.bot.id}`).catch(() => {});
  }

  // 5. Send Telegram push notification to admins with idempotency key
  await sendReceiptApprovedNotification({
    receipt,
    redis,
    transport,
    logger,
  });

  return receipt;
}

/**
 * Rejects a pending receipt. Rolls back granted subscription time by deducting receipt.months,
 * preserving independent payments regardless of review order. Idempotent terminal state.
 */
export async function rejectReceipt(
  params: RejectReceiptParams,
): Promise<PaymentReceipt | null> {
  const { prisma, redis, receiptId, reason, transport, logger } = params;
  const now = params.now ?? new Date();

  const result = await prisma.$transaction(
    async (tx) => {
      // 1. Transactional advisory lock on receipt
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`receipt:${receiptId}`}));`;

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

      if (!receipt) {
        return null;
      }

      // If already transitioned (terminal state): idempotent no-op
      if (receipt.status !== "PENDING") {
        return { alreadyHandled: true, receipt };
      }

      // Lock subscription to serialize state change
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sub:${receipt.botId}`}));`;

      const sub = receipt.bot.subscription;
      const attempts = (sub?.failedReceiptAttempts ?? 0) + 1;

      // Rollback paidUntil by deducting this receipt's months from the current subscription
      // Preserves independent payments regardless of the order in which receipts are reviewed
      let rolledBackPaidUntil: Date | null = null;
      if (sub?.paidUntil) {
        rolledBackPaidUntil = addMonths(sub.paidUntil, -receipt.months);
      } else {
        rolledBackPaidUntil = receipt.prevPaidUntil;
      }

      let newStatus: SubStatus;
      if (rolledBackPaidUntil && rolledBackPaidUntil.getTime() > now.getTime()) {
        newStatus = "ACTIVE";
      } else {
        newStatus = attempts === 1 ? "GRACE_PERIOD" : "BLOCKED";
      }

      if (newStatus === "BLOCKED") {
        notifyPlatformOwner(
          {
            type: "BOT_BLOCKED",
            botName: receipt.bot.botUsername ? `@${receipt.bot.botUsername}` : receipt.bot.id,
            reason,
          },
          { prisma, transport, logger },
        ).catch(() => {});
      }

      // 2. Rollback subscription
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

      // 3. Mark receipt as REJECTED
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

      return {
        alreadyHandled: false,
        receipt: updatedReceipt,
        newStatus,
        rolledBackPaidUntil,
      };
    },
    { maxWait: 15000, timeout: 20000 },
  );

  if (!result) return null;
  const receipt = result.receipt;

  if (result.alreadyHandled) {
    return receipt;
  }

  const { newStatus, rolledBackPaidUntil } = result;

  // 4. Invalidate Redis cache AFTER transaction commit
  if (redis) {
    await redis.del(`bot:hash:${receipt.bot.botTokenHash}`, `bot:id:${receipt.bot.id}`).catch(() => {});
  }

  // 5. Send Telegram push notification to admins with idempotency key
  await sendReceiptRejectedNotification({
    receipt,
    redis,
    transport,
    logger,
    reason,
    newStatus,
    rolledBackPaidUntil,
  });

  return receipt;
}
