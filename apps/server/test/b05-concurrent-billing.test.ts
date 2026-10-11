import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectRedis, type Redis } from "../src/core/redis.js";
import { env } from "../src/core/env.js";
import { logger } from "../src/core/logger.js";
import { MockTelegramTransport } from "../src/adapters/telegram/mock-transport.js";
import { encryptSecret, sha256Hex } from "../src/core/crypto.js";
import {
  approveReceipt,
  rejectReceipt,
  submitPaymentReceipt,
} from "../src/bots/shared/payment-service.js";
import { addMonths, transitionSubscription } from "../src/bots/shared/subscription.js";
import {
  getTestPrismaClient,
  createTestRedisClient,
  safeCleanTestDb,
  safeCleanTestRedis,
} from "./helpers/test-env.js";

const prisma = getTestPrismaClient();

let redis: Redis;
let transport: MockTelegramTransport;

describe("B05: Concurrent Billing & Rollback", () => {
  let botId: string;
  let botTokenHash: string;
  const ADMIN_TG_ID = 880055;
  const baseDate = new Date("2026-10-01T10:00:00.000Z");

  beforeAll(async () => {
    await prisma.$connect();
    redis = createTestRedisClient("test-b05");
    await connectRedis(redis);
    transport = new MockTelegramTransport();
  });

  afterAll(async () => {
    if (redis && redis.status !== "end") {
      await redis.quit();
    }
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    transport.clear();
    await safeCleanTestRedis(redis);
    await safeCleanTestDb(prisma);

    const tenant = await prisma.tenant.create({
      data: { clientName: "B05 Tenant", contactPhone: "+998901112233" },
    });

    const botToken = "123456789:B05BillingBotToken";
    botTokenHash = sha256Hex(botToken);
    const bot = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "LEADCATCH",
        botTokenEnc: encryptSecret(botToken, env.TOKEN_ENCRYPTION_KEY),
        botTokenHash,
        webhookSecret: "secret_b05",
        adminInviteCode: "b05_invite",
        subscription: {
          create: {
            status: "TRIAL",
            trialEndsAt: new Date(baseDate.getTime() + 86400000 * 3),
          },
        },
      },
    });
    botId = bot.id;

    // Register admin user
    await prisma.botUser.create({
      data: {
        botId,
        tgId: BigInt(ADMIN_TG_ID),
        firstName: "Billing Admin",
        username: "billing_admin",
        isAdmin: true,
        lang: "RU",
      },
    });
  });

  it("1. should handle concurrent approve/approve calls idempotently: exactly 1 transitions and sends 1 notification", async () => {
    const { receipt } = await submitPaymentReceipt({
      prisma,
      redis,
      botId,
      submittedByTgId: ADMIN_TG_ID,
      kind: "TEXT",
      months: 1,
      amountUzs: 100_000,
      textNote: "Параллельный approve",
      now: baseDate,
    });

    transport.clear();

    // 5 concurrent approve calls
    const results = await Promise.all([
      approveReceipt({ prisma, redis, receiptId: receipt.id, transport, logger }),
      approveReceipt({ prisma, redis, receiptId: receipt.id, transport, logger }),
      approveReceipt({ prisma, redis, receiptId: receipt.id, transport, logger }),
      approveReceipt({ prisma, redis, receiptId: receipt.id, transport, logger }),
      approveReceipt({ prisma, redis, receiptId: receipt.id, transport, logger }),
    ]);

    // All return the approved receipt
    for (const r of results) {
      expect(r?.status).toBe("APPROVED");
    }

    // Exactly 1 Telegram push notification sent across all concurrent calls
    const pushCalls = transport.callsOf("sendMessage");
    expect(pushCalls).toHaveLength(1);

    const dbReceipt = await prisma.paymentReceipt.findUnique({ where: { id: receipt.id } });
    expect(dbReceipt?.status).toBe("APPROVED");
  });

  it("2. should handle concurrent reject/reject calls idempotently: exactly 1 applies penalty and sends 1 notification", async () => {
    const { receipt } = await submitPaymentReceipt({
      prisma,
      redis,
      botId,
      submittedByTgId: ADMIN_TG_ID,
      kind: "TEXT",
      months: 1,
      amountUzs: 100_000,
      textNote: "Параллельный reject",
      now: baseDate,
    });

    transport.clear();

    // 5 concurrent reject calls
    const results = await Promise.all([
      rejectReceipt({ prisma, redis, receiptId: receipt.id, reason: "Тест отклонения", transport, logger, now: baseDate }),
      rejectReceipt({ prisma, redis, receiptId: receipt.id, reason: "Тест отклонения", transport, logger, now: baseDate }),
      rejectReceipt({ prisma, redis, receiptId: receipt.id, reason: "Тест отклонения", transport, logger, now: baseDate }),
      rejectReceipt({ prisma, redis, receiptId: receipt.id, reason: "Тест отклонения", transport, logger, now: baseDate }),
      rejectReceipt({ prisma, redis, receiptId: receipt.id, reason: "Тест отклонения", transport, logger, now: baseDate }),
    ]);

    for (const r of results) {
      expect(r?.status).toBe("REJECTED");
    }

    // Failed attempts should only increment ONCE (from 0 to 1)
    const sub = await prisma.subscription.findUnique({ where: { botId } });
    expect(sub?.failedReceiptAttempts).toBe(1);
    expect(sub?.status).toBe("GRACE_PERIOD");

    // Exactly 1 Telegram push notification sent
    const pushCalls = transport.callsOf("sendMessage");
    expect(pushCalls).toHaveLength(1);
  });

  it("3. should handle race condition between concurrent approve and reject: exactly 1 wins terminal state", async () => {
    const { receipt } = await submitPaymentReceipt({
      prisma,
      redis,
      botId,
      submittedByTgId: ADMIN_TG_ID,
      kind: "TEXT",
      months: 1,
      amountUzs: 100_000,
      textNote: "Race approve vs reject",
      now: baseDate,
    });

    transport.clear();

    await Promise.all([
      approveReceipt({ prisma, redis, receiptId: receipt.id, transport, logger }),
      rejectReceipt({ prisma, redis, receiptId: receipt.id, reason: "Race reject", transport, logger, now: baseDate }),
    ]);

    const finalReceipt = await prisma.paymentReceipt.findUnique({ where: { id: receipt.id } });
    expect(["APPROVED", "REJECTED"]).toContain(finalReceipt?.status);

    // Exactly one notification sent matching the winning terminal state
    const pushCalls = transport.callsOf("sendMessage");
    expect(pushCalls).toHaveLength(1);
  });

  it("4. should chain two simultaneous receipt submissions correctly without race condition", async () => {
    await prisma.subscription.update({
      where: { botId },
      data: { status: "ACTIVE", paidUntil: baseDate },
    });

    // Two concurrent submissions: one for 1 month, one for 6 months
    const [sub1, sub2] = await Promise.all([
      submitPaymentReceipt({
        prisma,
        redis,
        botId,
        submittedByTgId: ADMIN_TG_ID,
        kind: "TEXT",
        months: 1,
        amountUzs: 100_000,
        textNote: "Чек 1 concurrent",
        now: baseDate,
      }),
      submitPaymentReceipt({
        prisma,
        redis,
        botId,
        submittedByTgId: ADMIN_TG_ID,
        kind: "TEXT",
        months: 6,
        amountUzs: 500_000,
        textNote: "Чек 2 concurrent",
        now: baseDate,
      }),
    ]);

    expect(sub1.receipt.id).toBeDefined();
    expect(sub2.receipt.id).toBeDefined();

    // Final paidUntil must be baseDate + 7 months regardless of concurrency
    const expected7m = addMonths(baseDate, 7);
    const sub = await prisma.subscription.findUnique({ where: { botId } });
    expect(sub?.paidUntil?.toISOString()).toBe(expected7m.toISOString());
    expect(sub?.status).toBe("ACTIVE");
  });

  it("5. should preserve independent payments when rejected in REVERSE order (reject A then reject B)", async () => {
    await prisma.subscription.update({
      where: { botId },
      data: { status: "ACTIVE", paidUntil: baseDate },
    });

    // Receipt A (+1m)
    const { receipt: rA } = await submitPaymentReceipt({
      prisma,
      redis,
      botId,
      submittedByTgId: ADMIN_TG_ID,
      kind: "TEXT",
      months: 1,
      amountUzs: 100_000,
      textNote: "Чек A (+1m)",
      now: baseDate,
    });

    // Receipt B (+6m)
    const { receipt: rB } = await submitPaymentReceipt({
      prisma,
      redis,
      botId,
      submittedByTgId: ADMIN_TG_ID,
      kind: "TEXT",
      months: 6,
      amountUzs: 500_000,
      textNote: "Чек B (+6m)",
      now: baseDate,
    });

    // Paid until is baseDate + 7 months
    let sub = await prisma.subscription.findUnique({ where: { botId } });
    expect(sub?.paidUntil?.toISOString()).toBe(addMonths(baseDate, 7).toISOString());

    // 1. Reject A FIRST -> subtracting 1 month leaves baseDate + 6 months!
    await rejectReceipt({
      prisma,
      redis,
      receiptId: rA.id,
      reason: "Отклонен чек A",
      now: baseDate,
    });

    sub = await prisma.subscription.findUnique({ where: { botId } });
    const expected6m = addMonths(baseDate, 6);
    expect(sub?.paidUntil?.toISOString()).toBe(expected6m.toISOString());
    expect(sub?.status).toBe("ACTIVE"); // still has 6 months!

    // 2. Reject B SECOND -> subtracting 6 months leaves baseDate
    await rejectReceipt({
      prisma,
      redis,
      receiptId: rB.id,
      reason: "Отклонен чек B",
      now: baseDate,
    });

    sub = await prisma.subscription.findUnique({ where: { botId } });
    expect(sub?.paidUntil?.toISOString()).toBe(baseDate.toISOString());
    expect(sub?.failedReceiptAttempts).toBe(2);
    expect(sub?.status).toBe("BLOCKED"); // 2nd failure
  });

  it("6. should preserve approved payment when another receipt is rejected (approve A, reject B and vice versa)", async () => {
    await prisma.subscription.update({
      where: { botId },
      data: { status: "ACTIVE", paidUntil: baseDate },
    });

    // Receipt A (+1m)
    const { receipt: rA } = await submitPaymentReceipt({
      prisma,
      redis,
      botId,
      submittedByTgId: ADMIN_TG_ID,
      kind: "TEXT",
      months: 1,
      amountUzs: 100_000,
      textNote: "Чек A (+1m)",
      now: baseDate,
    });

    // Receipt B (+6m)
    const { receipt: rB } = await submitPaymentReceipt({
      prisma,
      redis,
      botId,
      submittedByTgId: ADMIN_TG_ID,
      kind: "TEXT",
      months: 6,
      amountUzs: 500_000,
      textNote: "Чек B (+6m)",
      now: baseDate,
    });

    // Reject B (+6m)
    await rejectReceipt({
      prisma,
      redis,
      receiptId: rB.id,
      reason: "Чек B не прошел",
      now: baseDate,
    });

    // Approve A (+1m)
    await approveReceipt({
      prisma,
      redis,
      receiptId: rA.id,
    });

    const sub = await prisma.subscription.findUnique({ where: { botId } });
    const expected1m = addMonths(baseDate, 1);
    expect(sub?.paidUntil?.toISOString()).toBe(expected1m.toISOString());
    expect(sub?.status).toBe("ACTIVE");
    expect(sub?.failedReceiptAttempts).toBe(0); // reset by approval
  });

  it("7. should preserve independent manual extension made between submission and rejection", async () => {
    await prisma.subscription.update({
      where: { botId },
      data: { status: "ACTIVE", paidUntil: baseDate },
    });

    // Receipt A (+1m) submitted
    const { receipt: rA } = await submitPaymentReceipt({
      prisma,
      redis,
      botId,
      submittedByTgId: ADMIN_TG_ID,
      kind: "TEXT",
      months: 1,
      amountUzs: 100_000,
      textNote: "Чек A",
      now: baseDate,
    });

    // Admin manually extends subscription by 3 months between submission and review
    const manualExtendedDate = addMonths(baseDate, 4); // base + 1m (receipt) + 3m (manual)
    await prisma.subscription.update({
      where: { botId },
      data: { paidUntil: manualExtendedDate },
    });

    // Reject Receipt A -> deduct 1m
    await rejectReceipt({
      prisma,
      redis,
      receiptId: rA.id,
      reason: "Фальшивый чек",
      now: baseDate,
    });

    const sub = await prisma.subscription.findUnique({ where: { botId } });
    // Manual extension of +3 months is intact: baseDate + 3 months
    const expected3m = addMonths(baseDate, 3);
    expect(sub?.paidUntil?.toISOString()).toBe(expected3m.toISOString());
    expect(sub?.status).toBe("ACTIVE");
  });

  it("8. should keep subscription ACTIVE if previous active paid period is still valid in the future", async () => {
    // Subscription is paid 6 months into the future
    const futurePaidUntil = addMonths(baseDate, 6);
    await prisma.subscription.update({
      where: { botId },
      data: { status: "ACTIVE", paidUntil: futurePaidUntil },
    });

    // Submit new receipt (+1m)
    const { receipt } = await submitPaymentReceipt({
      prisma,
      redis,
      botId,
      submittedByTgId: ADMIN_TG_ID,
      kind: "TEXT",
      months: 1,
      amountUzs: 100_000,
      textNote: "Чек на продление",
      now: baseDate,
    });

    transport.clear();

    // Reject receipt
    await rejectReceipt({
      prisma,
      redis,
      receiptId: receipt.id,
      reason: "Отказ",
      transport,
      now: baseDate,
    });

    const sub = await prisma.subscription.findUnique({ where: { botId } });
    // Still ACTIVE because futurePaidUntil is in the future!
    expect(sub?.status).toBe("ACTIVE");
    expect(sub?.paidUntil?.toISOString()).toBe(futurePaidUntil.toISOString());
    expect(sub?.failedReceiptAttempts).toBe(1);

    // Push notification sent to admin informs about rejection while retaining active date
    const pushCalls = transport.callsOf("sendMessage");
    expect(pushCalls).toHaveLength(1);
    expect(String(pushCalls[0]?.payload.text)).toContain("Чек отклонён");
  });

  it("9. should correctly enforce 1st failure (GRACE_PERIOD) and 2nd failure (BLOCKED) lifecycle", async () => {
    // Initial state: expired
    await prisma.subscription.update({
      where: { botId },
      data: { status: "EXPIRED", paidUntil: baseDate },
    });

    // 1st fake receipt
    const { receipt: r1 } = await submitPaymentReceipt({
      prisma,
      redis,
      botId,
      submittedByTgId: ADMIN_TG_ID,
      kind: "TEXT",
      months: 1,
      amountUzs: 100_000,
      now: baseDate,
    });

    await rejectReceipt({
      prisma,
      redis,
      receiptId: r1.id,
      reason: "1-я ошибка",
      now: baseDate,
    });

    let sub = await prisma.subscription.findUnique({ where: { botId } });
    expect(sub?.status).toBe("GRACE_PERIOD");
    expect(sub?.failedReceiptAttempts).toBe(1);

    // 2nd fake receipt
    const { receipt: r2 } = await submitPaymentReceipt({
      prisma,
      redis,
      botId,
      submittedByTgId: ADMIN_TG_ID,
      kind: "TEXT",
      months: 1,
      amountUzs: 100_000,
      now: baseDate,
    });

    await rejectReceipt({
      prisma,
      redis,
      receiptId: r2.id,
      reason: "2-я ошибка",
      now: baseDate,
    });

    sub = await prisma.subscription.findUnique({ where: { botId } });
    expect(sub?.status).toBe("BLOCKED");
    expect(sub?.failedReceiptAttempts).toBe(2);
  });

  it("10. should verify pure subscription state machine handles negative month deductions cleanly", () => {
    const ctx = {
      now: baseDate,
      trialEndsAt: baseDate,
      paidUntil: addMonths(baseDate, 7),
      failedReceiptAttempts: 0,
    };

    // Rejection with months deduction
    const res = transitionSubscription(
      "ACTIVE",
      { type: "RECEIPT_REJECTED", prevPaidUntil: baseDate, months: 6 },
      ctx,
    );

    expect(res.nextStatus).toBe("ACTIVE");
    expect(res.nextPaidUntil?.toISOString()).toBe(addMonths(baseDate, 1).toISOString());
    expect(res.nextFailedAttempts).toBe(1);
  });
});
