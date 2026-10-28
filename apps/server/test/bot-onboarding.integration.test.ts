import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  connectRedis,
  encryptSecret,
  sha256Hex,
  MockTelegramTransport,
  BotPool,
  notifyAdmins,
  logger,
  type Redis,
  type ResolvedBot,
} from "../src/index.js";
import { env } from "../src/core/env.js";
import {
  getTestPrismaClient,
  createTestRedisClient,
  safeCleanTestDb,
  safeCleanTestRedis,
} from "./helpers/test-env.js";

const prisma = getTestPrismaClient();

let redis: Redis;

describe("Bot Onboarding, Roles, i18n & Admin Menu E2E", () => {
  let transport: MockTelegramTransport;
  let botPool: BotPool;
  let botId: string;
  let resolvedBot: ResolvedBot;

  const BOT_TOKEN = "123456789:OnboardingTestBotToken";
  const ADMIN_INVITE_CODE = "valid_invite_code_123";

  beforeAll(async () => {
    await prisma.$connect();
    redis = createTestRedisClient("test-onboarding");
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
      data: { clientName: "Onboarding Tenant", contactPhone: "+998901234567" },
    });

    const botTokenEnc = encryptSecret(BOT_TOKEN, env.TOKEN_ENCRYPTION_KEY);
    const bot = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "LEADCATCH",
        botTokenEnc,
        botTokenHash: sha256Hex(BOT_TOKEN),
        webhookSecret: "secret_123",
        subscription: {
          create: {
            status: "TRIAL",
            trialEndsAt: new Date(Date.now() + 86400000 * 3),
          },
        },
        invites: {
          create: {
            codeHash: sha256Hex(ADMIN_INVITE_CODE),
            role: "OWNER",
            expiresAt: new Date(Date.now() + 86400000),
          },
        },
      },
      include: { subscription: true },
    });
    botId = bot.id;

    resolvedBot = {
      id: bot.id,
      tenantId: bot.tenantId,
      botType: bot.botType,
      botTokenEnc: bot.botTokenEnc,
      botTokenHash: bot.botTokenHash,
      webhookSecret: bot.webhookSecret,
      botUsername: "onboarding_test_bot",
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

  it("1. should prompt language selection on first /start and set Uzbek language", async () => {
    const bot = botPool.getOrCreateBot(resolvedBot);
    const tgId = 555001;

    await bot.handleUpdate({
      update_id: 1001,
      message: {
        message_id: 1,
        date: 1700000000,
        chat: { id: tgId, type: "private", first_name: "Aziz" },
        from: { id: tgId, is_bot: false, first_name: "Aziz" },
        text: "/start",
      },
    });

    let calls = transport.callsOf("sendMessage");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.payload.reply_markup).toHaveProperty("keyboard");
    expect(String(calls.at(-1)?.payload.text)).toContain("выберите язык / Iltimos, tilni tanlang");

    transport.clear();
    await bot.handleUpdate({
      update_id: 1002,
      callback_query: {
        id: "cb_1",
        from: { id: tgId, is_bot: false, first_name: "Aziz" },
        message: {
          message_id: 2,
          date: 1700000000,
          chat: { id: tgId, type: "private", first_name: "Aziz" },
          text: "lang",
        },
        chat_instance: "ci_1",
        data: "set_lang:UZ",
      },
    });

    const userInDb = await prisma.botUser.findUnique({
      where: { botId_tgId: { botId, tgId: BigInt(tgId) } },
    });
    expect(userInDb?.lang).toBe("UZ");
    expect(userInDb?.isAdmin).toBe(false);

    calls = transport.callsOf("sendMessage");
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const combinedTexts = calls.map((c) => String(c.payload.text)).join(" ");
    expect(combinedTexts).toContain("o'zgartirildi");
    const session = JSON.parse((await redis.get(`sess:${botId}:${tgId}`)) ?? "{}");
    expect(session.quiz?.currentNodeId).toBeDefined();
    expect(calls.at(-1)?.payload.reply_markup).toHaveProperty("inline_keyboard");
  });

  it("2. should promote user to admin on /start adm_<valid_code> and show admin menu", async () => {
    const bot = botPool.getOrCreateBot(resolvedBot);
    const adminTgId = 777002;

    await prisma.botUser.create({
      data: {
        botId,
        tgId: BigInt(adminTgId),
        firstName: "Boss",
        isAdmin: false,
        lang: "RU",
      },
    });

    await bot.handleUpdate({
      update_id: 2001,
      message: {
        message_id: 10,
        date: 1700000000,
        chat: { id: adminTgId, type: "private", first_name: "Boss" },
        from: { id: adminTgId, is_bot: false, first_name: "Boss" },
        text: `/start adm_${ADMIN_INVITE_CODE}`,
      },
    });

    const userInDb = await prisma.botUser.findUnique({
      where: { botId_tgId: { botId, tgId: BigInt(adminTgId) } },
    });
    expect(userInDb?.isAdmin).toBe(true);
    expect(userInDb?.role).toBe("OWNER");

    const calls = transport.callsOf("sendMessage");
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.payload.text)).toContain("назначены администратором");
  });

  it("3. should NOT promote user to admin on outdated or invalid invite code", async () => {
    const bot = botPool.getOrCreateBot(resolvedBot);
    const fakeTgId = 333003;

    await prisma.botUser.create({
      data: {
        botId,
        tgId: BigInt(fakeTgId),
        firstName: "Intruder",
        isAdmin: false,
        lang: "RU",
      },
    });

    await bot.handleUpdate({
      update_id: 3001,
      message: {
        message_id: 20,
        date: 1700000000,
        chat: { id: fakeTgId, type: "private", first_name: "Intruder" },
        from: { id: fakeTgId, is_bot: false, first_name: "Intruder" },
        text: "/start adm_old_invalid_invite_code",
      },
    });

    const userInDb = await prisma.botUser.findUnique({
      where: { botId_tgId: { botId, tgId: BigInt(fakeTgId) } },
    });
    expect(userInDb?.isAdmin).toBe(false);

    const calls = transport.callsOf("sendMessage");
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(String(calls[0]?.payload.text)).toContain("Добро пожаловать");
    expect(String(calls[0]?.payload.text)).not.toContain("администратором");
  });

  it("4. should handle Admin Menu: show subscription, tariffs, and payment details", async () => {
    const bot = botPool.getOrCreateBot(resolvedBot);
    const adminTgId = 777004;

    await prisma.botUser.create({
      data: {
        botId,
        tgId: BigInt(adminTgId),
        firstName: "AdminUser",
        isAdmin: true,
        role: "OWNER",
        lang: "RU",
      },
    });

    await bot.handleUpdate({
      update_id: 4001,
      callback_query: {
        id: "cb_sub",
        from: { id: adminTgId, is_bot: false, first_name: "AdminUser" },
        message: {
          message_id: 10,
          date: 1700000000,
          chat: { id: adminTgId, type: "private", first_name: "AdminUser" },
          text: "sub",
        },
        chat_instance: "ci_2",
        data: "admin:sub",
      },
    });

    let calls = transport.callsOf("sendMessage");
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.payload.text)).toContain("Пробный период");

    transport.clear();
    await bot.handleUpdate({
      update_id: 4002,
      callback_query: {
        id: "cb_pay",
        from: { id: adminTgId, is_bot: false, first_name: "AdminUser" },
        message: {
          message_id: 11,
          date: 1700000000,
          chat: { id: adminTgId, type: "private", first_name: "AdminUser" },
          text: "pay",
        },
        chat_instance: "ci_3",
        data: "admin:pay",
      },
    });

    calls = transport.callsOf("sendMessage");
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.payload.text)).toContain("Выберите период");

    transport.clear();
    await bot.handleUpdate({
      update_id: 4003,
      callback_query: {
        id: "cb_t6",
        from: { id: adminTgId, is_bot: false, first_name: "AdminUser" },
        message: {
          message_id: 12,
          date: 1700000000,
          chat: { id: adminTgId, type: "private", first_name: "AdminUser" },
          text: "tariff",
        },
        chat_instance: "ci_4",
        data: "pay:tariff:6",
      },
    });

    calls = transport.callsOf("sendMessage");
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.payload.text).replace(/\u00a0/g, " ")).toContain("500 000 сум");
  });

  it("5. should mask lead contact data in notifyAdmins when subscription is EXPIRED", async () => {
    const adminTgId = 777005;

    await prisma.botUser.create({
      data: {
        botId,
        tgId: BigInt(adminTgId),
        firstName: "NotifyAdmin",
        isAdmin: true,
        lang: "RU",
      },
    });

    await notifyAdmins(
      botId,
      {
        kind: "LEAD",
        name: "Temur",
        phone: "+998901234567",
        username: "temur_dev",
        answers: { "Желаемый бюджет": "100$" },
      },
      { prisma, transport, logger },
    );

    let calls = transport.callsOf("sendMessage");
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.payload.text)).toContain("+998901234567");
    expect(String(calls[0]?.payload.text)).toContain("Temur");
    expect(String(calls[0]?.payload.text)).not.toContain("СКРЫТА");

    transport.clear();
    await prisma.subscription.update({
      where: { botId },
      data: { status: "EXPIRED" },
    });

    await notifyAdmins(
      botId,
      {
        kind: "LEAD",
        name: "Temur",
        phone: "+998901234567",
        username: "temur_dev",
        answers: { "Желаемый бюджет": "100$" },
      },
      { prisma, transport, logger },
    );

    calls = transport.callsOf("sendMessage");
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.payload.text)).toContain("+998 90 *** ** 67");
    expect(String(calls[0]?.payload.text)).toContain("***");
    expect(String(calls[0]?.payload.text)).toContain("СКРЫТА");
    expect(String(calls[0]?.payload.text)).toContain("Оплатите подписку");
  });
});
