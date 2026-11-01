import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectRedis, type Redis } from "../src/core/redis.js";
import { env } from "../src/core/env.js";
import { logger } from "../src/core/logger.js";
import { MockTelegramTransport } from "../src/adapters/telegram/mock-transport.js";
import { encryptSecret, sha256Hex } from "../src/core/crypto.js";
import { BotPool } from "../src/gateway/bot-pool.js";
import type { ResolvedBot } from "../src/gateway/types.js";
import {
  approveReceipt,
  rejectReceipt,
  submitPaymentReceipt,
} from "../src/bots/shared/payment-service.js";
import { addMonths } from "../src/bots/shared/subscription.js";
import { validateImageBuffer } from "../src/bots/shared/receipt-storage.js";
import { t } from "../src/bots/shared/i18n.js";
import {
  getTestPrismaClient,
  createTestRedisClient,
  safeCleanTestDb,
  safeCleanTestRedis,
} from "./helpers/test-env.js";

const prisma = getTestPrismaClient();

let redis: Redis;
let transport: MockTelegramTransport;
let botPool: BotPool;

const BOT_TOKEN = "123456789:PaymentTestBotToken";
const ADMIN_TG_ID = 888001;

describe("Stage 6: Payment and Receipts Integration Tests", () => {
  let botId: string;
  let resolvedBot: ResolvedBot;

  beforeAll(async () => {
    await prisma.$connect();
    redis = createTestRedisClient("test-payment");
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
      data: { clientName: "Payment Tenant", contactPhone: "+998901234567" },
    });

    const botTokenEnc = encryptSecret(BOT_TOKEN, env.TOKEN_ENCRYPTION_KEY);
    const bot = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "LEADCATCH",
        botTokenEnc,
        botTokenHash: sha256Hex(BOT_TOKEN),
        webhookSecret: "secret_payment_123",
        subscription: {
          create: {
            status: "TRIAL",
            trialEndsAt: new Date(Date.now() + 86400000 * 3),
          },
        },
      },
      include: { subscription: true },
    });
    botId = bot.id;

    // Register admin user with RU language
    await prisma.botUser.create({
      data: {
        botId,
        tgId: BigInt(ADMIN_TG_ID),
        firstName: "Test Admin",
        username: "test_admin",
        isAdmin: true,
        lang: "RU",
      },
    });

    resolvedBot = {
      id: bot.id,
      tenantId: bot.tenantId,
      botType: bot.botType,
      botTokenEnc: bot.botTokenEnc,
      botTokenHash: bot.botTokenHash,
      webhookSecret: bot.webhookSecret,
      botUsername: "payment_test_bot",
      settings: {},
      subscriptionStatus: "TRIAL",
      trialEndsAt: bot.subscription?.trialEndsAt.toISOString() ?? new Date().toISOString(),
      paidUntil: null,
    };

    botPool = new BotPool({
      capacity: 50,
      encryptionKey: env.TOKEN_ENCRYPTION_KEY,
      transport,
      redis,
      sessionTtlSec: 3600,
      logger,
      prisma,
    });
  });

  describe("File Validation & Magic Bytes Security", () => {
    it("should reject .exe file disguised as .png", () => {
      // Windows executable PE header: MZ (4D 5A ...)
      const exeBuffer = Buffer.from([
        0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00,
        0x00,
      ]);

      const result = validateImageBuffer(exeBuffer);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("invalid_magic_bytes");
    });

    it("should reject PDF file with pdf_unsupported error", () => {
      // PDF header: %PDF (25 50 44 46)
      const pdfBuffer = Buffer.from([
        0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xd0, 0xd4, 0xc5, 0xd8, 0x0a,
        0x34,
      ]);

      const result = validateImageBuffer(pdfBuffer);
      expect(result.valid).toBe(false);
      expect(result.error).toBe("pdf_unsupported");
    });

    it("should successfully validate genuine PNG, JPEG, and WEBP buffers", () => {
      // PNG
      const pngBuffer = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52,
      ]);
      expect(validateImageBuffer(pngBuffer)).toEqual({
        valid: true,
        ext: "png",
        mime: "image/png",
      });

      // JPEG
      const jpegBuffer = Buffer.from([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
      ]);
      expect(validateImageBuffer(jpegBuffer)).toEqual({
        valid: true,
        ext: "jpg",
        mime: "image/jpeg",
      });

      // WEBP
      const webpBuffer = Buffer.from([
        0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      ]);
      expect(validateImageBuffer(webpBuffer)).toEqual({
        valid: true,
        ext: "webp",
        mime: "image/webp",
      });
    });
  });

  describe("Bot Payment Flow (Dialog & Inputs)", () => {
    it("should reject file > 5 MB before processing", async () => {
      const bot = botPool.getOrCreateBot(resolvedBot);

      // 1. Admin selects tariff: 1 month
      await bot.handleUpdate({
        update_id: 2001,
        callback_query: {
          id: "cb_pay_1",
          from: { id: ADMIN_TG_ID, is_bot: false, first_name: "Admin" },
          chat_instance: "ci_pay",
          data: "pay:tariff:1",
        },
      });

      transport.clear();

      // 2. Admin sends photo with file_size = 6 MB (6 * 1024 * 1024)
      await bot.handleUpdate({
        update_id: 2002,
        message: {
          message_id: 10,
          date: 1700000000,
          chat: { id: ADMIN_TG_ID, type: "private", first_name: "Admin" },
          from: { id: ADMIN_TG_ID, is_bot: false, first_name: "Admin" },
          photo: [
            {
              file_id: "large_file_id",
              file_unique_id: "large_uniq",
              width: 1000,
              height: 1000,
              file_size: 6 * 1024 * 1024,
            },
          ],
        },
      });

      const calls = transport.callsOf("sendMessage");
      expect(calls).toHaveLength(1);
      expect(String(calls[0]?.payload.text)).toContain("Размер фото превышает 5 МБ");
    });

    it("should reject .exe file sent as document with invalid format message", async () => {
      const bot = botPool.getOrCreateBot(resolvedBot);

      // Select tariff
      await bot.handleUpdate({
        update_id: 2010,
        callback_query: {
          id: "cb_pay_1",
          from: { id: ADMIN_TG_ID, is_bot: false, first_name: "Admin" },
          chat_instance: "ci_pay",
          data: "pay:tariff:1",
        },
      });

      // Mock transport returning exe buffer for downloadFile
      const exeBuffer = Buffer.from([
        0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff, 0x00,
        0x00,
      ]);
      transport.setMockFile("photos/doc_fake_png.png", exeBuffer);
      transport.clear();

      await bot.handleUpdate({
        update_id: 2011,
        message: {
          message_id: 11,
          date: 1700000000,
          chat: { id: ADMIN_TG_ID, type: "private", first_name: "Admin" },
          from: { id: ADMIN_TG_ID, is_bot: false, first_name: "Admin" },
          document: {
            file_id: "doc_fake_png",
            file_unique_id: "doc_fake_uniq",
            file_name: "fake_receipt.png",
            mime_type: "image/png",
            file_size: 1024,
          },
        },
      });

      const calls = transport.callsOf("sendMessage");
      expect(calls).toHaveLength(1);
      expect(String(calls[0]?.payload.text)).toContain("Неподдерживаемый формат");
    });

    it("should reject text receipt < 10 characters and accept valid text receipt", async () => {
      const bot = botPool.getOrCreateBot(resolvedBot);

      // 1. Select tariff: 6 months
      await bot.handleUpdate({
        update_id: 2020,
        callback_query: {
          id: "cb_pay_6",
          from: { id: ADMIN_TG_ID, is_bot: false, first_name: "Admin" },
          chat_instance: "ci_pay",
          data: "pay:tariff:6",
        },
      });

      transport.clear();

      // 2. Send short text (< 10 chars)
      await bot.handleUpdate({
        update_id: 2021,
        message: {
          message_id: 12,
          date: 1700000000,
          chat: { id: ADMIN_TG_ID, type: "private", first_name: "Admin" },
          from: { id: ADMIN_TG_ID, is_bot: false, first_name: "Admin" },
          text: "оплатил",
        },
      });

      let calls = transport.callsOf("sendMessage");
      expect(calls).toHaveLength(1);
      expect(String(calls[0]?.payload.text)).toContain("Слишком короткое описание перевода");

      transport.clear();

      // 3. Send valid text receipt (>= 10 chars)
      await bot.handleUpdate({
        update_id: 2022,
        message: {
          message_id: 13,
          date: 1700000000,
          chat: { id: ADMIN_TG_ID, type: "private", first_name: "Admin" },
          from: { id: ADMIN_TG_ID, is_bot: false, first_name: "Admin" },
          text: "Перевел 500 000 сум в 14:35 через Payme с карты *1234",
        },
      });

      calls = transport.callsOf("sendMessage");
      expect(calls).toHaveLength(1);
      expect(String(calls[0]?.payload.text)).toContain("Чек принят на проверку");

      // Verify DB record
      const receipts = await prisma.paymentReceipt.findMany({ where: { botId } });
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.kind).toBe("TEXT");
      expect(receipts[0]?.status).toBe("PENDING");
      expect(receipts[0]?.months).toBe(6);
      expect(receipts[0]?.amount).toBe(500_000);
      expect(receipts[0]?.textNote).toBe("Перевел 500 000 сум в 14:35 через Payme с карты *1234");

      // Sending a receipt does not grant access.
      const sub = await prisma.subscription.findUnique({ where: { botId } });
      expect(sub?.status).toBe("TRIAL");
      expect(sub?.paidUntil).toBeNull();
    });

    it("should accept a photo receipt without activating the subscription", async () => {
      const bot = botPool.getOrCreateBot(resolvedBot);

      // Select tariff 1 month
      await bot.handleUpdate({
        update_id: 2030,
        callback_query: {
          id: "cb_pay_1",
          from: { id: ADMIN_TG_ID, is_bot: false, first_name: "Admin" },
          chat_instance: "ci_pay",
          data: "pay:tariff:1",
        },
      });

      transport.clear();

      // Send valid photo
      await bot.handleUpdate({
        update_id: 2031,
        message: {
          message_id: 14,
          date: 1700000000,
          chat: { id: ADMIN_TG_ID, type: "private", first_name: "Admin" },
          from: { id: ADMIN_TG_ID, is_bot: false, first_name: "Admin" },
          photo: [
            {
              file_id: "valid_photo_1",
              file_unique_id: "uniq_1",
              width: 800,
              height: 600,
              file_size: 2048,
            },
          ],
        },
      });

      const calls = transport.callsOf("sendMessage");
      expect(calls).toHaveLength(1);
      expect(String(calls[0]?.payload.text)).toContain("Чек принят на проверку");

      const receipt = await prisma.paymentReceipt.findFirst({ where: { botId } });
      expect(receipt).not.toBeNull();
      expect(receipt?.kind).toBe("PHOTO");
      expect(receipt?.imagePath).not.toBeNull();
    });
  });

  describe("Advance Renewal Logic", () => {
    it("should extend from future paidUntil date (+10 days + 1 month)", async () => {
      const now = new Date("2026-10-10T12:00:00.000Z");
      const futurePaidUntil = new Date("2026-10-20T12:00:00.000Z"); // +10 days

      await prisma.subscription.update({
        where: { botId },
        data: {
          status: "ACTIVE",
          paidUntil: futurePaidUntil,
        },
      });

      const result = await submitPaymentReceipt({
        prisma,
        redis,
        botId,
        submittedByTgId: ADMIN_TG_ID,
        kind: "TEXT",
        months: 1,
        amountUzs: 100_000,
        textNote: "Оплата заранее на 1 месяц",
        now,
      });

      // Should be extended from futurePaidUntil (2026-10-20), resulting in 2026-11-20
      const expectedDate = addMonths(futurePaidUntil, 1);
      expect(result.newPaidUntil?.toISOString()).toBe(futurePaidUntil.toISOString());
      await approveReceipt({ prisma, redis, receiptId: result.receipt.id, now });

      const sub = await prisma.subscription.findUnique({ where: { botId } });
      expect(sub?.paidUntil?.toISOString()).toBe(expectedDate.toISOString());
    });
  });

  describe("Subscription Lifecycle Scenario: 6m -> reject -> GRACE -> 6m -> reject -> BLOCKED", () => {
    it("should follow the complete transition path with RU and UZ text checks", async () => {
      const baseTime = new Date("2026-10-01T10:00:00.000Z");

      // 1. Initial expired state before payment
      await prisma.subscription.update({
        where: { botId },
        data: {
          status: "EXPIRED",
          paidUntil: new Date("2026-09-30T10:00:00.000Z"),
          failedReceiptAttempts: 0,
        },
      });

      // 2. Submit payment for 6 months
      const { receipt: receipt1, newPaidUntil: paidUntil1 } = await submitPaymentReceipt({
        prisma,
        redis,
        botId,
        submittedByTgId: ADMIN_TG_ID,
        kind: "TEXT",
        months: 6,
        amountUzs: 500_000,
        textNote: "Оплата за 6 месяцев",
        now: baseTime,
      });

      expect(paidUntil1?.toISOString()).toBe("2026-09-30T10:00:00.000Z");

      let sub = await prisma.subscription.findUnique({ where: { botId } });
      expect(sub?.status).toBe("EXPIRED");

      // 3. Reject receipt 1 -> rollback to EXPIRED, attempt = 1 -> GRACE_PERIOD
      transport.clear();
      const reject1 = await rejectReceipt({
        prisma,
        redis,
        receiptId: receipt1.id,
        reason: "Чек не читается",
        transport,
        now: baseTime,
      });

      expect(reject1?.status).toBe("REJECTED");
      sub = await prisma.subscription.findUnique({ where: { botId } });
      expect(sub?.status).toBe("GRACE_PERIOD");
      expect(sub?.failedReceiptAttempts).toBe(1);

      // Check Russian notification
      let pushCalls = transport.callsOf("sendMessage");
      expect(pushCalls).toHaveLength(1);
      expect(String(pushCalls[0]?.payload.text)).toContain(
        "У вас осталась 1 попытка для отправки оплаты",
      );

      // 4. Submit second payment attempt
      const { receipt: receipt2 } = await submitPaymentReceipt({
        prisma,
        redis,
        botId,
        submittedByTgId: ADMIN_TG_ID,
        kind: "TEXT",
        months: 6,
        amountUzs: 500_000,
        textNote: "Повторная оплата 6 месяцев",
        now: baseTime,
      });

      sub = await prisma.subscription.findUnique({ where: { botId } });
      expect(sub?.status).toBe("GRACE_PERIOD");

      // Switch admin to UZ language to test Uzbek push notification
      await prisma.botUser.update({
        where: { botId_tgId: { botId, tgId: BigInt(ADMIN_TG_ID) } },
        data: { lang: "UZ" },
      });

      // 5. Reject receipt 2 -> attempt = 2 -> BLOCKED!
      transport.clear();
      const reject2 = await rejectReceipt({
        prisma,
        redis,
        receiptId: receipt2.id,
        reason: "Фальшивый чек",
        transport,
        now: baseTime,
      });

      expect(reject2?.status).toBe("REJECTED");
      sub = await prisma.subscription.findUnique({ where: { botId } });
      expect(sub?.status).toBe("BLOCKED");
      expect(sub?.failedReceiptAttempts).toBe(2);

      // Check Uzbek notification for BLOCKED
      pushCalls = transport.callsOf("sendMessage");
      expect(pushCalls).toHaveLength(1);
      expect(String(pushCalls[0]?.payload.text)).toContain("Bot bloklandi");
      expect(String(pushCalls[0]?.payload.text)).toContain(env.SUPPORT_CONTACT);

      // 6. When BLOCKED: bot rejects payment callback immediately
      resolvedBot.subscriptionStatus = "BLOCKED";
      const bot = botPool.getOrCreateBot(resolvedBot);
      transport.clear();

      await bot.handleUpdate({
        update_id: 3001,
        callback_query: {
          id: "cb_blocked_pay",
          from: { id: ADMIN_TG_ID, is_bot: false, first_name: "Admin" },
          chat_instance: "ci_blocked",
          data: "admin:pay",
        },
      });

      pushCalls = transport.callsOf("sendMessage");
      expect(pushCalls).toHaveLength(1);
      expect(String(pushCalls[0]?.payload.text)).toContain(
        t("UZ", "sub_blocked_alert", { support: env.SUPPORT_CONTACT }),
      );
    });
  });

  describe("Concurrency & Multiple Sequential Receipts", () => {
    it("should handle parallel approve calls idempotently (applied once)", async () => {
      const { receipt } = await submitPaymentReceipt({
        prisma,
        redis,
        botId,
        submittedByTgId: ADMIN_TG_ID,
        kind: "TEXT",
        months: 1,
        amountUzs: 100_000,
        textNote: "Параллельный тест",
      });

      // 5 concurrent approve calls
      const results = await Promise.all([
        approveReceipt({ prisma, redis, receiptId: receipt.id, transport }),
        approveReceipt({ prisma, redis, receiptId: receipt.id, transport }),
        approveReceipt({ prisma, redis, receiptId: receipt.id, transport }),
        approveReceipt({ prisma, redis, receiptId: receipt.id, transport }),
        approveReceipt({ prisma, redis, receiptId: receipt.id, transport }),
      ]);

      const approvedCount = results.filter((r) => r?.status === "APPROVED").length;
      expect(approvedCount).toBe(5);

      const dbReceipt = await prisma.paymentReceipt.findUnique({ where: { id: receipt.id } });
      expect(dbReceipt?.status).toBe("APPROVED");

      const sub = await prisma.subscription.findUnique({ where: { botId } });
      expect(sub?.failedReceiptAttempts).toBe(0);
    });

    it("should prevent duplicate pending receipts and roll back sequential receipts correctly", async () => {
      const initialDate = new Date("2026-10-01T10:00:00.000Z");
      await prisma.subscription.update({
        where: { botId },
        data: {
          status: "ACTIVE",
          paidUntil: initialDate,
        },
      });

      // Receipt 1: +1 month
      const { receipt: r1 } = await submitPaymentReceipt({
        prisma,
        redis,
        botId,
        submittedByTgId: ADMIN_TG_ID,
        kind: "TEXT",
        months: 1,
        amountUzs: 100_000,
        textNote: "Чек 1 на 1 месяц",
        now: initialDate,
      });

      // Clarification 2: Receipt 2 cannot be submitted while Receipt 1 is PENDING
      await expect(
        submitPaymentReceipt({
          prisma,
          redis,
          botId,
          submittedByTgId: ADMIN_TG_ID,
          kind: "TEXT",
          months: 6,
          amountUzs: 500_000,
          textNote: "Чек 2 на 6 месяцев (пока чек 1 в ожидании)",
          now: initialDate,
        }),
      ).rejects.toThrow("PENDING_RECEIPT_EXISTS");

      // Approve Receipt 1
      await approveReceipt({
        prisma,
        redis,
        receiptId: r1.id,
        now: initialDate,
      });

      let sub = await prisma.subscription.findUnique({ where: { botId } });
      const expected1m = addMonths(initialDate, 1);
      expect(sub?.paidUntil?.toISOString()).toBe(expected1m.toISOString());
      expect(sub?.status).toBe("ACTIVE");

      // Now Receipt 2 can be submitted (+6 months)
      const { receipt: r2 } = await submitPaymentReceipt({
        prisma,
        redis,
        botId,
        submittedByTgId: ADMIN_TG_ID,
        kind: "TEXT",
        months: 6,
        amountUzs: 500_000,
        textNote: "Чек 2 на 6 месяцев",
        now: initialDate,
      });

      sub = await prisma.subscription.findUnique({ where: { botId } });
      // The second receipt is still pending: preserve only the approved first month.
      const expected7m = expected1m;
      expect(sub?.paidUntil?.toISOString()).toBe(expected7m.toISOString());

      // Reject Receipt 2 -> should roll back to after Receipt 1 (+1 month)
      await rejectReceipt({
        prisma,
        redis,
        receiptId: r2.id,
        reason: "Отклонен чек 2",
        now: initialDate,
      });

      sub = await prisma.subscription.findUnique({ where: { botId } });
      expect(sub?.paidUntil?.toISOString()).toBe(expected1m.toISOString());
      expect(sub?.status).toBe("ACTIVE");
    });
  });
});
