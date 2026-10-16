import { QUICKBOOK_TEST_CONFIG } from "./helpers/quickbook-fixture.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  connectRedis,
  encryptSecret,
  sha256Hex,
  MockTelegramTransport,
  BotPool,
  type Redis,
  type ResolvedBot,
} from "../src/index.js";
import { env } from "../src/core/env.js";
import { logger } from "../src/core/logger.js";
import {
  getTestPrismaClient,
  createTestRedisClient,
  safeCleanTestDb,
  safeCleanTestRedis,
} from "./helpers/test-env.js";

const prisma = getTestPrismaClient();

let redis: Redis;

describe("QuickBook E2E Booking Dialog & Subscription Integration", () => {
  let transport: MockTelegramTransport;
  let botPool: BotPool;
  let botId: string;
  let resolvedBot: ResolvedBot;
  const adminTgId = 111000;
  const clientTgId = 222000;
  const BOT_TOKEN = "123456789:QuickBookIntegrationBotToken";

  beforeAll(async () => {
    await prisma.$connect();
    redis = createTestRedisClient("test-quickbook-e2e");
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
      data: { clientName: "QuickBook Barbershop", contactPhone: "+998901234567" },
    });

    const bot = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "QUICKBOOK",
        settings: QUICKBOOK_TEST_CONFIG,
        botTokenEnc: encryptSecret(BOT_TOKEN, env.TOKEN_ENCRYPTION_KEY),
        botTokenHash: sha256Hex(BOT_TOKEN),
        webhookSecret: "secret_qb_e2e",
        adminInviteCode: "qb_invite_123",
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

    // Create admin user
    await prisma.botUser.create({
      data: {
        botId,
        tgId: BigInt(adminTgId),
        firstName: "Админ Барбершопа",
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
      botUsername: "qb_test_bot",
      adminInviteCode: bot.adminInviteCode,
      settings: QUICKBOOK_TEST_CONFIG,
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

  it("1. Happy path on TRIAL: client books slot -> confirmed in DB -> admin gets open notification", async () => {
    const bot = botPool.getOrCreateBot(resolvedBot);

    // 1. Client starts bot with RU language
    await prisma.botUser.create({
      data: {
        botId,
        tgId: BigInt(clientTgId),
        firstName: "Азиз",
        isAdmin: false,
        lang: "RU",
      },
    });

    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 10,
        date: 1700000000,
        chat: { id: clientTgId, type: "private", first_name: "Азиз" },
        from: { id: clientTgId, is_bot: false, first_name: "Азиз" },
        text: "/start",
      },
    });

    // Client receives services menu
    let calls = transport.callsOf("sendMessage");
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(String(calls[calls.length - 1]?.payload.text)).toContain("Выберите услугу");

    // 2. Client selects service: srv_haircut
    transport.clear();
    await bot.handleUpdate({
      update_id: 2,
      callback_query: {
        id: "cb_srv",
        from: { id: clientTgId, is_bot: false, first_name: "Азиз" },
        message: {
          message_id: 11,
          date: 1700000000,
          chat: { id: clientTgId, type: "private", first_name: "Азиз" },
          text: "Выберите услугу",
        },
        chat_instance: "ci_1",
        data: "qb:srv:srv_haircut",
      },
    });

    // Client receives resource selection
    calls = transport.callsOf("sendMessage");
    expect(String(calls[0]?.payload.text)).toContain("Выберите");

    // 3. Client selects slot date & time
    transport.clear();
    const slotDate1 = new Date();
    slotDate1.setDate(slotDate1.getDate() + 2);
    slotDate1.setHours(12, 0, 0, 0);
    const futureSlotIso = slotDate1.toISOString();
    await bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "cb_slot",
        from: { id: clientTgId, is_bot: false, first_name: "Азиз" },
        message: {
          message_id: 12,
          date: 1700000000,
          chat: { id: clientTgId, type: "private", first_name: "Азиз" },
          text: "Выберите время",
        },
        chat_instance: "ci_2",
        data: `qb:slot:srv_haircut:staff_alisher:${futureSlotIso}`,
      },
    });

    // Client prompted for phone number
    calls = transport.callsOf("sendMessage");
    expect(String(calls[0]?.payload.text)).toContain("номер телефона");

    // 4. Client sends phone number via text
    transport.clear();
    await bot.handleUpdate({
      update_id: 4,
      message: {
        message_id: 13,
        date: 1700000000,
        chat: { id: clientTgId, type: "private", first_name: "Азиз" },
        from: { id: clientTgId, is_bot: false, first_name: "Азиз" },
        text: "+998 90 123 45 67",
      },
    });

    // 5. Client receives confirmation
    calls = transport.callsOf("sendMessage");
    const clientMsg = calls.find((c) => c.payload.chat_id === clientTgId);
    expect(clientMsg).toBeDefined();
    expect(String(clientMsg?.payload.text)).toContain("Вы успешно записаны");

    // 6. Admin receives OPEN notification
    const adminMsg = calls.find((c) => c.payload.chat_id === adminTgId);
    expect(adminMsg).toBeDefined();
    const adminText = String(adminMsg?.payload.text);
    expect(adminText).toContain("Новая запись");
    expect(adminText).toContain("+998901234567");
    expect(adminText).toContain("Азиз");
    expect(adminText).not.toContain("***");

    // 7. Verify booking in PostgreSQL
    const bookingInDb = await prisma.booking.findFirst({
      where: { botId, customerTgId: BigInt(clientTgId) },
    });
    expect(bookingInDb).toBeDefined();
    expect(bookingInDb?.customerPhone).toBe("+998901234567");
    expect(bookingInDb?.status).toBe("CONFIRMED");
  });

  it("2. EXPIRED subscription scenario: client books -> admin receives MASKED notification with payment button", async () => {
    // Set bot subscription to EXPIRED
    await prisma.subscription.update({
      where: { botId },
      data: { status: "EXPIRED" },
    });
    resolvedBot.subscriptionStatus = "EXPIRED";

    const bot = botPool.getOrCreateBot(resolvedBot);

    // Client has language RU
    await prisma.botUser.create({
      data: {
        botId,
        tgId: BigInt(clientTgId),
        firstName: "Сардор",
        isAdmin: false,
        lang: "RU",
      },
    });

    // Select slot directly
    const slotDate2 = new Date();
    slotDate2.setDate(slotDate2.getDate() + 3);
    slotDate2.setHours(12, 0, 0, 0);
    const futureSlotIso = slotDate2.toISOString();
    await bot.handleUpdate({
      update_id: 10,
      callback_query: {
        id: "cb_slot_exp",
        from: { id: clientTgId, is_bot: false, first_name: "Сардор" },
        message: {
          message_id: 20,
          date: 1700000000,
          chat: { id: clientTgId, type: "private", first_name: "Сардор" },
          text: "Время",
        },
        chat_instance: "ci_exp",
        data: `qb:slot:srv_beard:staff_jasur:${futureSlotIso}`,
      },
    });

    // Client sends phone number
    transport.clear();
    await bot.handleUpdate({
      update_id: 11,
      message: {
        message_id: 21,
        date: 1700000000,
        chat: { id: clientTgId, type: "private", first_name: "Сардор" },
        from: { id: clientTgId, is_bot: false, first_name: "Сардор" },
        text: "90 987 65 43",
      },
    });

    // Client receives standard polite confirmation (NOT affected by subscription!)
    const calls = transport.callsOf("sendMessage");
    const clientMsg = calls.find((c) => c.payload.chat_id === clientTgId);
    expect(clientMsg).toBeDefined();
    expect(String(clientMsg?.payload.text)).toContain("Вы успешно записаны");

    // Admin receives MASKED notification
    const adminMsg = calls.find((c) => c.payload.chat_id === adminTgId);
    expect(adminMsg).toBeDefined();
    const adminText = String(adminMsg?.payload.text);
    expect(adminText).toContain("СКРЫТА");
    expect(adminText).toContain("+998 90 *** ** 43");
    expect(adminText).toContain("***");
    expect(adminText).not.toContain("9876543");
    expect(adminText).toContain("Оплатите подписку");

    // Admin message has payment button
    const replyMarkup = adminMsg?.payload.reply_markup as {
      inline_keyboard?: Array<Array<{ text: string }>>;
    };
    expect(replyMarkup.inline_keyboard?.[0]?.[0]?.text).toContain("Оплатить");
  });

  it("3. Client can cancel booking via callback query", async () => {
    const slotTime = new Date(Date.now() + 86400000);
    const booking = await prisma.booking.create({
      data: {
        botId,
        customerTgId: BigInt(clientTgId),
        customerName: "Тест",
        customerPhone: "+998901234567",
        serviceId: "srv_haircut",
        serviceName: "Мужская стрижка",
        staffId: "staff_alisher",
        durationMin: 45,
        slotTime,
        status: "CONFIRMED",
      },
    });

    const bot = botPool.getOrCreateBot(resolvedBot);
    transport.clear();

    await bot.handleUpdate({
      update_id: 50,
      callback_query: {
        id: "cb_cancel",
        from: { id: clientTgId, is_bot: false, first_name: "Тест" },
        message: {
          message_id: 51,
          date: 1700000000,
          chat: { id: clientTgId, type: "private", first_name: "Тест" },
          text: "Напоминание",
        },
        chat_instance: "ci_can",
        data: `book:cancel:${booking.id}`,
      },
    });

    // Check client received cancellation response
    const calls = transport.callsOf("sendMessage");
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.payload.text)).toContain("отменена");

    // Check DB status updated to CANCELLED
    const updated = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(updated?.status).toBe("CANCELLED");
  });
});
