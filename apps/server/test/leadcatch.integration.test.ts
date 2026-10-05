import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { MockTelegramTransport } from "../src/adapters/telegram/mock-transport.js";
import { encryptSecret, sha256Hex } from "../src/core/crypto.js";
import { env } from "../src/core/env.js";
import { logger } from "../src/core/logger.js";
import { prisma } from "../src/core/prisma.js";
import { connectRedis, createRedisClient } from "../src/core/redis.js";
import { BotPool } from "../src/gateway/bot-pool.js";
import type { ResolvedBot } from "../src/gateway/types.js";

let redis: Redis;

interface SentMessagePayload {
  text?: string;
  reply_markup?: unknown;
}

function getLastMessageTo(transport: MockTelegramTransport, chatId: number): SentMessagePayload | undefined {
  const calls = transport.callsOf("sendMessage").filter((c) => Number(c.payload.chat_id) === chatId);
  if (calls.length === 0) return undefined;
  const last = calls[calls.length - 1]!;
  return {
    text: typeof last.payload.text === "string" ? last.payload.text : undefined,
    reply_markup: last.payload.reply_markup,
  };
}

describe("Stage 4: LeadCatch E2E Integration (Real Postgres + Redis)", () => {
  let transport: MockTelegramTransport;
  let botPool: BotPool;
  let botId: string;
  let resolvedBot: ResolvedBot;

  const BOT_TOKEN = "111222333:LeadCatchTestToken";
  const ADMIN_INVITE_CODE = "lc_adm_code_777";
  const ADMIN_TG_ID = 5550001;
  const CLIENT_TG_ID = 9990001;

  beforeAll(async () => {
    await prisma.$connect();
    redis = createRedisClient({
      url: env.TEST_REDIS_URL || env.REDIS_URL,
      logger,
      name: "test-leadcatch",
    });
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
    await redis.flushdb();

    await prisma.lead.deleteMany();
    await prisma.botUser.deleteMany();
    await prisma.subscription.deleteMany();
    await prisma.bot.deleteMany();
    await prisma.tenant.deleteMany();

    const tenant = await prisma.tenant.create({
      data: { clientName: "LeadCatch Test Tenant", contactPhone: "+998901234567" },
    });

    const botTokenEnc = encryptSecret(BOT_TOKEN, env.TOKEN_ENCRYPTION_KEY);
    const bot = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "LEADCATCH",
        botTokenEnc,
        botTokenHash: sha256Hex(BOT_TOKEN),
        webhookSecret: "secret_leadcatch",
        adminInviteCode: ADMIN_INVITE_CODE,
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

    // Register admin user for this bot
    await prisma.botUser.create({
      data: {
        botId,
        tgId: BigInt(ADMIN_TG_ID),
        firstName: "AdminUser",
        username: "lead_admin",
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
      botUsername: "leadcatch_test_bot",
      adminInviteCode: bot.adminInviteCode,
      settings: {},
      subscriptionStatus: "TRIAL",
      trialEndsAt: bot.subscription!.trialEndsAt.toISOString(),
      paidUntil: null,
    };

    botPool = new BotPool({
      capacity: 10,
      encryptionKey: env.TOKEN_ENCRYPTION_KEY,
      transport,
      redis,
      sessionTtlSec: 3600,
      logger,
      prisma,
    });
  });

  it("1. Happy path: TRIAL status, Telegram contact button -> full unmasked lead delivered to admin", async () => {
    const botInstance = botPool.getOrCreateBot(resolvedBot);

    // Step 1: Client initiates /start
    await botInstance.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CLIENT_TG_ID, type: "private", first_name: "John Client" },
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "John Client", username: "john_client" },
        text: "/start",
      },
    });

    // Language selection is offered
    const langMsg = getLastMessageTo(transport,CLIENT_TG_ID);
    expect(langMsg).toBeDefined();
    expect(langMsg?.text).toContain("выберите язык");

    // Step 2: Client selects Russian language
    await botInstance.handleUpdate({
      update_id: 2,
      callback_query: {
        id: "cb_lang_1",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "John Client", username: "john_client" },
        chat_instance: "inst_1",
        data: "set_lang:RU",
      },
    });

    // Question 1 of DAG quiz is presented
    const q1Msg = getLastMessageTo(transport,CLIENT_TG_ID);
    expect(q1Msg?.text).toContain("Какая услуга вас интересует?");

    // Step 3: Client clicks Option 1 ("Консультация") -> transitions to Q2
    await botInstance.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "cb_opt_1",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "John Client" },
        chat_instance: "inst_1",
        data: "lc:opt:q1_service:opt_consult",
      },
    });

    const q2Msg = getLastMessageTo(transport,CLIENT_TG_ID);
    expect(q2Msg?.text).toContain("Когда вам удобно обсудить детали?");

    // Step 4: Client clicks Option 2 ("В первой половине дня") -> transitions to Q3
    await botInstance.handleUpdate({
      update_id: 4,
      callback_query: {
        id: "cb_opt_2",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "John Client" },
        chat_instance: "inst_1",
        data: "lc:opt:q2_time:opt_morning",
      },
    });

    const q3Msg = getLastMessageTo(transport,CLIENT_TG_ID);
    expect(q3Msg?.text).toContain("Укажите ориентировочный бюджет:");

    // Step 5: Client clicks Option 1 ("Базовый") -> terminal node reached, contact requested
    await botInstance.handleUpdate({
      update_id: 5,
      callback_query: {
        id: "cb_opt_3",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "John Client" },
        chat_instance: "inst_1",
        data: "lc:opt:q3_budget:opt_budget_base",
      },
    });

    const contactPromptMsg = getLastMessageTo(transport,CLIENT_TG_ID);
    expect(contactPromptMsg?.text).toContain("отправьте ваш номер телефона");

    // Step 6: Client sends contact via Telegram native button
    await botInstance.handleUpdate({
      update_id: 6,
      message: {
        message_id: 6,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CLIENT_TG_ID, type: "private", first_name: "John Client" },
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "John Client", username: "john_client" },
        contact: {
          phone_number: "+998 90 123 45 67",
          first_name: "John Client",
        },
      },
    });

    // Client receives polite thank-you message
    const thankYouMsg = getLastMessageTo(transport,CLIENT_TG_ID);
    expect(thankYouMsg?.text).toContain("Спасибо! Ваша заявка успешно принята");

    // Database verification: Lead is saved with full normalized phone
    const leadsInDb = await prisma.lead.findMany({ where: { botId } });
    expect(leadsInDb).toHaveLength(1);
    const lead = leadsInDb[0]!;
    expect(lead.phoneRaw).toBe("+998901234567");
    expect(lead.customerName).toBe("John Client");
    expect(lead.customerUsername).toBe("john_client");
    expect(lead.isMasked).toBe(false);

    // Admin notification verification: unmasked phone and answers delivered to admin
    const adminMsg = getLastMessageTo(transport,ADMIN_TG_ID);
    expect(adminMsg).toBeDefined();
    expect(adminMsg?.text).toContain("🔔 Новая заявка:");
    expect(adminMsg?.text).toContain("+998901234567");
    expect(adminMsg?.text).toContain("John Client");
    expect(adminMsg?.text).toContain("Консультация");
    expect(adminMsg?.text).not.toContain("***");
  });

  it("2. EXPIRED subscription: client inputs phone as text -> admin receives masked contact with payment alert", async () => {
    // Set bot subscription to EXPIRED
    await prisma.subscription.update({
      where: { botId },
      data: { status: "EXPIRED" },
    });
    resolvedBot.subscriptionStatus = "EXPIRED";

    const botInstance = botPool.getOrCreateBot(resolvedBot);

    // Client has already chosen language
    await prisma.botUser.create({
      data: {
        botId,
        tgId: BigInt(CLIENT_TG_ID),
        firstName: "Secret Client",
        username: "secret_client",
        isAdmin: false,
        lang: "RU",
      },
    });

    // Step 1: /start immediately presents Q1
    await botInstance.handleUpdate({
      update_id: 11,
      message: {
        message_id: 11,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CLIENT_TG_ID, type: "private", first_name: "Secret Client" },
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Secret Client", username: "secret_client" },
        text: "/start",
      },
    });

    const q1 = getLastMessageTo(transport,CLIENT_TG_ID);
    expect(q1?.text).toContain("Какая услуга вас интересует?");

    // Step 2: Answer Q1
    await botInstance.handleUpdate({
      update_id: 12,
      callback_query: {
        id: "cb_e1",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Secret Client" },
        chat_instance: "inst_1",
        data: "lc:opt:q1_service:opt_project",
      },
    });

    // Step 3: Answer Q2
    await botInstance.handleUpdate({
      update_id: 13,
      callback_query: {
        id: "cb_e2",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Secret Client" },
        chat_instance: "inst_1",
        data: "lc:opt:q2_time:opt_asap",
      },
    });

    // Step 4: Answer Q3 -> terminal
    await botInstance.handleUpdate({
      update_id: 14,
      callback_query: {
        id: "cb_e3",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Secret Client" },
        chat_instance: "inst_1",
        data: "lc:opt:q3_budget:opt_budget_pro",
      },
    });

    // Step 5: Client types phone number as text ("90 987 65 43")
    await botInstance.handleUpdate({
      update_id: 15,
      message: {
        message_id: 15,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CLIENT_TG_ID, type: "private", first_name: "Secret Client" },
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Secret Client", username: "secret_client" },
        text: "90 987 65 43",
      },
    });

    // Client receives identical friendly thank-you without any errors
    const clientThankYou = getLastMessageTo(transport,CLIENT_TG_ID);
    expect(clientThankYou?.text).toContain("Спасибо! Ваша заявка успешно принята");

    // Database check: Lead is saved with full phone
    const leads = await prisma.lead.findMany({ where: { botId } });
    expect(leads).toHaveLength(1);
    expect(leads[0]!.phoneRaw).toBe("+998909876543");

    // Admin receives MASKED notification with payment button
    const adminMsg = getLastMessageTo(transport,ADMIN_TG_ID);
    expect(adminMsg).toBeDefined();
    expect(adminMsg?.text).toContain("🔔 Новая заявка (СКРЫТА):");
    expect(adminMsg?.text).toContain("+998 90 *** ** 43");
    expect(adminMsg?.text).toContain("***");
    expect(adminMsg?.text).toContain("Оплатите подписку для открытия контактов!");

    // Inline button to pay is attached
    const replyMarkup = adminMsg?.reply_markup as { inline_keyboard: Array<Array<{ text: string }>> };
    expect(replyMarkup?.inline_keyboard?.[0]?.[0]?.text).toContain("Оплатить");
  });

  it("3. Phone validation: invalid text entry triggers polite error prompt", async () => {
    const botInstance = botPool.getOrCreateBot(resolvedBot);

    await prisma.botUser.create({
      data: {
        botId,
        tgId: BigInt(CLIENT_TG_ID),
        firstName: "Test",
        isAdmin: false,
        lang: "RU",
      },
    });

    // Advance directly to contact step
    await botInstance.handleUpdate({
      update_id: 20,
      message: {
        message_id: 20,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CLIENT_TG_ID, type: "private", first_name: "Test" },
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Test" },
        text: "/start",
      },
    });

    await botInstance.handleUpdate({
      update_id: 21,
      callback_query: {
        id: "cb_1",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Test" },
        chat_instance: "inst_1",
        data: "lc:opt:q1_service:opt_consult",
      },
    });

    await botInstance.handleUpdate({
      update_id: 22,
      callback_query: {
        id: "cb_2",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Test" },
        chat_instance: "inst_1",
        data: "lc:opt:q2_time:opt_morning",
      },
    });

    await botInstance.handleUpdate({
      update_id: 23,
      callback_query: {
        id: "cb_3",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Test" },
        chat_instance: "inst_1",
        data: "lc:opt:q3_budget:opt_budget_base",
      },
    });

    // Send invalid text
    await botInstance.handleUpdate({
      update_id: 24,
      message: {
        message_id: 24,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CLIENT_TG_ID, type: "private", first_name: "Test" },
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Test" },
        text: "не скажу номер",
      },
    });

    const errorMsg = getLastMessageTo(transport,CLIENT_TG_ID);
    expect(errorMsg?.text).toContain("укажите корректный номер телефона");

    // No lead created yet
    const leadsCount = await prisma.lead.count({ where: { botId } });
    expect(leadsCount).toBe(0);

    // Now send valid phone
    await botInstance.handleUpdate({
      update_id: 25,
      message: {
        message_id: 25,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CLIENT_TG_ID, type: "private", first_name: "Test" },
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Test" },
        text: "8 90 123 45 67",
      },
    });

    const successMsg = getLastMessageTo(transport,CLIENT_TG_ID);
    expect(successMsg?.text).toContain("Спасибо! Ваша заявка успешно принята");

    const leads = await prisma.lead.findMany({ where: { botId } });
    expect(leads).toHaveLength(1);
    expect(leads[0]!.phoneRaw).toBe("+998901234567");
  });

  it("4. Abandoned dialog: session expiry in Redis restarts quiz fresh from Q1", async () => {
    const botInstance = botPool.getOrCreateBot(resolvedBot);

    await prisma.botUser.create({
      data: {
        botId,
        tgId: BigInt(CLIENT_TG_ID),
        firstName: "Idle User",
        isAdmin: false,
        lang: "RU",
      },
    });

    // Start quiz and answer Q1
    await botInstance.handleUpdate({
      update_id: 30,
      message: {
        message_id: 30,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CLIENT_TG_ID, type: "private", first_name: "Idle User" },
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Idle User" },
        text: "/start",
      },
    });

    await botInstance.handleUpdate({
      update_id: 31,
      callback_query: {
        id: "cb_idle_1",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Idle User" },
        chat_instance: "inst_1",
        data: "lc:opt:q1_service:opt_audit",
      },
    });

    // Verify client is at Q2
    const q2Msg = getLastMessageTo(transport,CLIENT_TG_ID);
    expect(q2Msg?.text).toContain("Когда вам удобно обсудить детали?");

    // Simulate 1 hour session expiration in Redis
    await redis.del(`sess:${botId}:${CLIENT_TG_ID}`);

    // Client returns and types /start
    await botInstance.handleUpdate({
      update_id: 32,
      message: {
        message_id: 32,
        date: Math.floor(Date.now() / 1000) + 3600,
        chat: { id: CLIENT_TG_ID, type: "private", first_name: "Idle User" },
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Idle User" },
        text: "/start",
      },
    });

    // Quiz starts cleanly from Q1
    const restartMsg = getLastMessageTo(transport, CLIENT_TG_ID);
    expect(restartMsg?.text).toContain("Какая услуга вас интересует?");
  });
});
