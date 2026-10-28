import { randomUUID } from "node:crypto";
import { handleLeadCatchContact } from "../src/bots/leadcatch/lead-submission.js";
import type { PlatformBotContext } from "../src/gateway/types.js";
import { callbackId } from "../src/bots/shared/callback-id.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { MockTelegramTransport } from "../src/adapters/telegram/mock-transport.js";
import { encryptSecret, sha256Hex } from "../src/core/crypto.js";
import { env } from "../src/core/env.js";
import { logger } from "../src/core/logger.js";
import { connectRedis } from "../src/core/redis.js";
import { BotPool } from "../src/gateway/bot-pool.js";
import type { ResolvedBot } from "../src/gateway/types.js";
import {
  getTestPrismaClient,
  createTestRedisClient,
  safeCleanTestDb,
  safeCleanTestRedis,
} from "./helpers/test-env.js";

const prisma = getTestPrismaClient();

let redis: Redis;

interface SentMessagePayload {
  text?: string;
  reply_markup?: unknown;
}

function getLastMessageTo(
  transport: MockTelegramTransport,
  chatId: number,
): SentMessagePayload | undefined {
  const calls = transport
    .callsOf("sendMessage")
    .filter((c) => Number(c.payload.chat_id) === chatId);
  if (calls.length === 0) return undefined;
  const last = calls[calls.length - 1]!;
  return {
    text: typeof last.payload.text === "string" ? last.payload.text : undefined,
    reply_markup: last.payload.reply_markup,
  };
}

function answerButton(
  transport: MockTelegramTransport,
  chatId: number,
  nodeId: string,
  optionId: string,
): string {
  const markup = getLastMessageTo(transport, chatId)?.reply_markup as
    | { inline_keyboard?: { callback_data?: string }[][] }
    | undefined;
  const suffix = `:${callbackId(nodeId)}:${callbackId(optionId)}`;
  const button = markup?.inline_keyboard
    ?.flat()
    .find((item) => item.callback_data?.endsWith(suffix));
  if (!button?.callback_data) throw new Error(`Answer button not found for ${nodeId}/${optionId}`);
  return button.callback_data;
}

function confirmButton(transport: MockTelegramTransport, chatId: number): string {
  const markup = getLastMessageTo(transport, chatId)?.reply_markup as
    | { inline_keyboard?: { callback_data?: string }[][] }
    | undefined;
  const button = markup?.inline_keyboard
    ?.flat()
    .find((item) => item.callback_data?.startsWith("lc:confirm:"));
  if (!button?.callback_data) throw new Error("Confirm button not found");
  return button.callback_data;
}

describe("Stage 4: LeadCatch E2E Integration (Real Postgres + Redis)", () => {
  let transport: MockTelegramTransport;
  let botPool: BotPool;
  let botId: string;
  let resolvedBot: ResolvedBot;

  const BOT_TOKEN = "111222333:LeadCatchTestToken";
  const ADMIN_TG_ID = 5550001;
  const CLIENT_TG_ID = 9990001;

  beforeAll(async () => {
    await prisma.$connect();
    redis = createTestRedisClient("test-leadcatch");
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

  it("1. Happy path: TRIAL status, Telegram contact button -> summary -> full unmasked lead delivered to admin", async () => {
    const botInstance = botPool.getOrCreateBot(resolvedBot);

    await botInstance.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CLIENT_TG_ID, type: "private", first_name: "John Client" },
        from: {
          id: CLIENT_TG_ID,
          is_bot: false,
          first_name: "John Client",
          username: "john_client",
        },
        text: "/start",
      },
    });

    const langMsg = getLastMessageTo(transport, CLIENT_TG_ID);
    expect(langMsg).toBeDefined();
    expect(langMsg?.text).toContain("выберите язык");

    await botInstance.handleUpdate({
      update_id: 2,
      callback_query: {
        id: "cb_lang_1",
        from: {
          id: CLIENT_TG_ID,
          is_bot: false,
          first_name: "John Client",
          username: "john_client",
        },
        chat_instance: "inst_1",
        data: "set_lang:RU",
      },
    });

    const q1Msg = getLastMessageTo(transport, CLIENT_TG_ID);
    expect(q1Msg?.text).toContain("Какая услуга вас интересует?");

    await botInstance.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "cb_opt_1",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "John Client" },
        chat_instance: "inst_1",
        data: answerButton(transport, CLIENT_TG_ID, "q1_service", "opt_consult"),
      },
    });

    const q2Msg = getLastMessageTo(transport, CLIENT_TG_ID);
    expect(q2Msg?.text).toContain("Когда вам удобно обсудить детали?");

    await botInstance.handleUpdate({
      update_id: 4,
      callback_query: {
        id: "cb_opt_2",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "John Client" },
        chat_instance: "inst_1",
        data: answerButton(transport, CLIENT_TG_ID, "q2_time", "opt_morning"),
      },
    });

    const q3Msg = getLastMessageTo(transport, CLIENT_TG_ID);
    expect(q3Msg?.text).toContain("Укажите ориентировочный бюджет:");

    await botInstance.handleUpdate({
      update_id: 5,
      callback_query: {
        id: "cb_opt_3",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "John Client" },
        chat_instance: "inst_1",
        data: answerButton(transport, CLIENT_TG_ID, "q3_budget", "opt_budget_base"),
      },
    });

    const contactPromptMsg = getLastMessageTo(transport, CLIENT_TG_ID);
    expect(contactPromptMsg?.text).toContain("отправьте ваш номер телефона");

    // Step 6: Client sends own contact via Telegram native button
    await botInstance.handleUpdate({
      update_id: 6,
      message: {
        message_id: 6,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CLIENT_TG_ID, type: "private", first_name: "John Client" },
        from: {
          id: CLIENT_TG_ID,
          is_bot: false,
          first_name: "John Client",
          username: "john_client",
        },
        contact: {
          phone_number: "+998 90 123 45 67",
          first_name: "John Client",
          user_id: CLIENT_TG_ID,
        },
      },
    });

    // Summary screen is shown before saving
    const summaryMsg = getLastMessageTo(transport, CLIENT_TG_ID);
    expect(summaryMsg?.text).toContain("Проверьте данные вашей заявки");
    expect(await prisma.lead.count({ where: { botId } })).toBe(0);

    // Step 7: Client confirms on summary screen
    await botInstance.handleUpdate({
      update_id: 7,
      callback_query: {
        id: "cb_confirm_1",
        from: {
          id: CLIENT_TG_ID,
          is_bot: false,
          first_name: "John Client",
          username: "john_client",
        },
        chat_instance: "inst_1",
        data: confirmButton(transport, CLIENT_TG_ID),
      },
    });

    const thankYouMsg = getLastMessageTo(transport, CLIENT_TG_ID);
    expect(thankYouMsg?.text).toContain("Спасибо! Ваша заявка успешно принята");

    const leadsInDb = await prisma.lead.findMany({ where: { botId } });
    expect(leadsInDb).toHaveLength(1);
    const lead = leadsInDb[0]!;
    expect(lead.phoneRaw).toBe("+998901234567");
    expect(lead.phoneVerified).toBe(true);
    expect(lead.customerName).toBe("John Client");
    expect(lead.customerUsername).toBe("john_client");
    expect(lead.isMasked).toBe(false);

    const adminMsg = getLastMessageTo(transport, ADMIN_TG_ID);
    expect(adminMsg).toBeDefined();
    expect(adminMsg?.text).toContain("🔔 Новая заявка:");
    expect(adminMsg?.text).toContain("+998901234567");
    expect(adminMsg?.text).toContain("John Client");
    expect(adminMsg?.text).toContain("Консультация");
    expect(adminMsg?.text).not.toContain("***");
  });

  it("2. EXPIRED subscription: client inputs phone as text -> summary -> admin receives masked contact with payment alert", async () => {
    await prisma.subscription.update({
      where: { botId },
      data: { status: "EXPIRED" },
    });
    resolvedBot.subscriptionStatus = "EXPIRED";

    const botInstance = botPool.getOrCreateBot(resolvedBot);

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

    await botInstance.handleUpdate({
      update_id: 11,
      message: {
        message_id: 11,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CLIENT_TG_ID, type: "private", first_name: "Secret Client" },
        from: {
          id: CLIENT_TG_ID,
          is_bot: false,
          first_name: "Secret Client",
          username: "secret_client",
        },
        text: "/start",
      },
    });

    const q1 = getLastMessageTo(transport, CLIENT_TG_ID);
    expect(q1?.text).toContain("Какая услуга вас интересует?");

    await botInstance.handleUpdate({
      update_id: 12,
      callback_query: {
        id: "cb_e1",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Secret Client" },
        chat_instance: "inst_1",
        data: answerButton(transport, CLIENT_TG_ID, "q1_service", "opt_project"),
      },
    });

    await botInstance.handleUpdate({
      update_id: 13,
      callback_query: {
        id: "cb_e2",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Secret Client" },
        chat_instance: "inst_1",
        data: answerButton(transport, CLIENT_TG_ID, "q2_time", "opt_asap"),
      },
    });

    await botInstance.handleUpdate({
      update_id: 14,
      callback_query: {
        id: "cb_e3",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Secret Client" },
        chat_instance: "inst_1",
        data: answerButton(transport, CLIENT_TG_ID, "q3_budget", "opt_budget_pro"),
      },
    });

    await botInstance.handleUpdate({
      update_id: 15,
      message: {
        message_id: 15,
        date: Math.floor(Date.now() / 1000),
        chat: { id: CLIENT_TG_ID, type: "private", first_name: "Secret Client" },
        from: {
          id: CLIENT_TG_ID,
          is_bot: false,
          first_name: "Secret Client",
          username: "secret_client",
        },
        text: "90 987 65 43",
      },
    });

    // Confirm summary
    await botInstance.handleUpdate({
      update_id: 16,
      callback_query: {
        id: "cb_confirm_2",
        from: {
          id: CLIENT_TG_ID,
          is_bot: false,
          first_name: "Secret Client",
          username: "secret_client",
        },
        chat_instance: "inst_1",
        data: confirmButton(transport, CLIENT_TG_ID),
      },
    });

    const clientThankYou = getLastMessageTo(transport, CLIENT_TG_ID);
    expect(clientThankYou?.text).toContain("Спасибо! Ваша заявка успешно принята");

    const leads = await prisma.lead.findMany({ where: { botId } });
    expect(leads).toHaveLength(1);
    expect(leads[0]!.phoneRaw).toBe("+998909876543");
    expect(leads[0]!.phoneVerified).toBe(false);

    const adminMsg = getLastMessageTo(transport, ADMIN_TG_ID);
    expect(adminMsg).toBeDefined();
    expect(adminMsg?.text).toContain("🔔 Новая заявка (СКРЫТА):");
    expect(adminMsg?.text).toContain("+998 90 *** ** 43");
    expect(adminMsg?.text).toContain("***");
    expect(adminMsg?.text).toContain("Оплатите подписку для открытия контактов!");

    const replyMarkup = adminMsg?.reply_markup as {
      inline_keyboard: Array<Array<{ text: string }>>;
    };
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
        data: answerButton(transport, CLIENT_TG_ID, "q1_service", "opt_consult"),
      },
    });

    await botInstance.handleUpdate({
      update_id: 22,
      callback_query: {
        id: "cb_2",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Test" },
        chat_instance: "inst_1",
        data: answerButton(transport, CLIENT_TG_ID, "q2_time", "opt_morning"),
      },
    });

    await botInstance.handleUpdate({
      update_id: 23,
      callback_query: {
        id: "cb_3",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Test" },
        chat_instance: "inst_1",
        data: answerButton(transport, CLIENT_TG_ID, "q3_budget", "opt_budget_base"),
      },
    });

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

    const errorMsg = getLastMessageTo(transport, CLIENT_TG_ID);
    expect(errorMsg?.text).toContain("укажите корректный номер телефона");

    const leadsCount = await prisma.lead.count({ where: { botId } });
    expect(leadsCount).toBe(0);

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

    await botInstance.handleUpdate({
      update_id: 26,
      callback_query: {
        id: "cb_confirm_3",
        from: { id: CLIENT_TG_ID, is_bot: false, first_name: "Test" },
        chat_instance: "inst_1",
        data: confirmButton(transport, CLIENT_TG_ID),
      },
    });

    const successMsg = getLastMessageTo(transport, CLIENT_TG_ID);
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
        data: answerButton(transport, CLIENT_TG_ID, "q1_service", "opt_audit"),
      },
    });

    const q2Msg = getLastMessageTo(transport, CLIENT_TG_ID);
    expect(q2Msg?.text).toContain("Когда вам удобно обсудить детали?");

    await redis.del(`sess:${botId}:${CLIENT_TG_ID}`);

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

    const restartMsg = getLastMessageTo(transport, CLIENT_TG_ID);
    expect(restartMsg?.text).toContain("Какая услуга вас интересует?");
  });

  it("повторные и параллельные отправки создают одну заявку на прохождение в PostgreSQL", async () => {
    const attemptId = randomUUID();
    const api = botPool.getOrCreateBot(resolvedBot).api;
    const contextFor = (id: string) =>
      ({
        api,
        botMeta: resolvedBot,
        from: { id: CLIENT_TG_ID, first_name: "Repeat client" },
        chat: { id: CLIENT_TG_ID },
        session: {
          lang: "RU",
          quiz: {
            attemptId: id,
            currentNodeId: "__contact__",
            stepCount: 3,
            startedAt: Date.now(),
            answers: { q1: { question: "Запрос", answer: "Консультация" } },
          },
        },
      }) as unknown as PlatformBotContext;
    const options = { rawPhone: "+998901234567", transport, logger };
    const first = contextFor(attemptId),
      retry = contextFor(attemptId);
    expect(
      await Promise.all([
        handleLeadCatchContact(first, prisma, options),
        handleLeadCatchContact(retry, prisma, options),
      ]),
    ).toEqual([true, true]);
    let leads = await prisma.lead.findMany({ where: { botId } });
    expect(leads).toHaveLength(1);
    expect(leads[0]!.id).toBe(attemptId);
    await handleLeadCatchContact(contextFor(attemptId), prisma, options);
    expect(await prisma.lead.count({ where: { botId } })).toBe(1);
    await handleLeadCatchContact(contextFor(randomUUID()), prisma, options);
    leads = await prisma.lead.findMany({ where: { botId } });
    expect(leads).toHaveLength(2);
  });
});
