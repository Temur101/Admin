import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  connectRedis,
  encryptSecret,
  sha256Hex,
  MockTelegramTransport,
  type Redis,
} from "../src/index.js";
import { env } from "../src/core/env.js";
import { logger } from "../src/core/logger.js";
import { BotPool, extractTelegramBotId, normalizeBotUsername } from "../src/gateway/bot-pool.js";
import { TenantResolver } from "../src/gateway/tenant-resolver.js";
import {
  getTestPrismaClient,
  createTestRedisClient,
  safeCleanTestDb,
  safeCleanTestRedis,
} from "./helpers/test-env.js";

const prisma = getTestPrismaClient();

function getSentMessages(transport: MockTelegramTransport, chatId?: number) {
  return transport
    .callsOf("sendMessage")
    .filter((c) => chatId === undefined || Number(c.payload.chat_id) === chatId)
    .map((c) => ({
      chatId: Number(c.payload.chat_id),
      text: String(c.payload.text ?? ""),
    }));
}

describe("B02: Cache Freshness & Metadata Invalidation", () => {
  let redis: Redis;
  let transport: MockTelegramTransport;
  let tenantResolver: TenantResolver;
  let botPool: BotPool;
  let botId: string;
  let botTokenHash: string;

  const BOT_TOKEN = "987654321:B02TestTelegramToken";
  const INITIAL_INVITE_CODE = "initial_inv_123";
  const USER_A_ID = 7001;
  const USER_B_ID = 7002;

  beforeAll(async () => {
    await prisma.$connect();
    redis = createTestRedisClient("test-b02-cache");
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

    tenantResolver = new TenantResolver({
      prisma,
      redis,
      cacheTtlSec: 600,
      logger,
    });

    botPool = new BotPool({
      capacity: 100,
      encryptionKey: env.TOKEN_ENCRYPTION_KEY,
      transport,
      redis,
      sessionTtlSec: 3600,
      logger,
      prisma,
      tenantResolver,
    });

    tenantResolver.setOnInvalidate((hash, id) => {
      botPool.invalidateMeta(hash, id);
    });

    const tenant = await prisma.tenant.create({
      data: { clientName: "Cache Test Tenant", contactPhone: "+998901112233" },
    });

    botTokenHash = "b02_hash_1234567890123456789012345678901234567890123456789012345";
    const botTokenEnc = encryptSecret(BOT_TOKEN, env.TOKEN_ENCRYPTION_KEY);

    const bot = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "LEADCATCH",
        botTokenEnc,
        botTokenHash,
        webhookSecret: "secret_b02_test",
        botUsername: "@b02_test_bot",
        settings: { welcomeMessage: "Welcome v1" },
        subscription: {
          create: {
            status: "ACTIVE",
            trialEndsAt: new Date(Date.now() + 86400000 * 30),
            paidUntil: new Date(Date.now() + 86400000 * 30),
          },
        },
        invites: {
          create: {
            codeHash: sha256Hex(INITIAL_INVITE_CODE),
            role: "OWNER",
            expiresAt: new Date(Date.now() + 86400000),
          },
        },
      },
      include: { subscription: true },
    });
    botId = bot.id;
  });

  it("1. should parse real Telegram bot ID from token and clean leading @ from username", () => {
    const extractedId = extractTelegramBotId(BOT_TOKEN);
    expect(extractedId).toBe(987654321);

    expect(extractTelegramBotId("invalid-format")).toBeNull();
    expect(extractTelegramBotId("-500:invalid")).toBeNull();

    expect(normalizeBotUsername("@my_bot", "fallback")).toBe("my_bot");
    expect(normalizeBotUsername("my_bot", "fallback")).toBe("my_bot");
    expect(normalizeBotUsername(null, "@fallback_bot")).toBe("fallback_bot");
  });

  it("2. should correctly handle addressed commands like /start@bot_username", async () => {
    const resolved = await tenantResolver.resolve(botTokenHash);
    expect(resolved).not.toBeNull();

    const bot = botPool.getOrCreateBot(resolved!);
    expect(bot.botInfo.id).toBe(987654321);
    expect(bot.botInfo.username).toBe("b02_test_bot");

    const cmdText = "/start@b02_test_bot";
    // Send command addressed directly to this bot
    await botPool.handleUpdate(resolved!, {
      update_id: 101,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: USER_A_ID, type: "private", first_name: "UserA" },
        from: { id: USER_A_ID, is_bot: false, first_name: "UserA" },
        text: `${cmdText} adm_${INITIAL_INVITE_CODE}`,
        entities: [{ type: "bot_command", offset: 0, length: cmdText.length }],
      },
    });

    const userA = await prisma.botUser.findUnique({
      where: { botId_tgId: { botId, tgId: BigInt(USER_A_ID) } },
    });
    expect(userA).not.toBeNull();
    expect(userA?.isAdmin).toBe(true);

    const otherCmd = "/start@completely_other_bot";
    // Send command addressed to ANOTHER bot -> must be ignored by grammY
    await botPool.handleUpdate(resolved!, {
      update_id: 102,
      message: {
        message_id: 2,
        date: Math.floor(Date.now() / 1000),
        chat: { id: USER_B_ID, type: "private", first_name: "UserB" },
        from: { id: USER_B_ID, is_bot: false, first_name: "UserB" },
        text: `${otherCmd} adm_${INITIAL_INVITE_CODE}`,
        entities: [{ type: "bot_command", offset: 0, length: otherCmd.length }],
      },
    });

    const userB = await prisma.botUser.findUnique({
      where: { botId_tgId: { botId, tgId: BigInt(USER_B_ID) } },
    });
    expect(userB).toBeNull();
  });

  it("3. should invalidate single-use invite and accept newly generated invite in the same process", async () => {
    const initialMeta = await tenantResolver.resolve(botTokenHash);
    expect(initialMeta).not.toBeNull();

    // User A registers with initial invite code -> becomes admin
    await botPool.handleUpdate(initialMeta!, {
      update_id: 201,
      message: {
        message_id: 10,
        date: Math.floor(Date.now() / 1000),
        chat: { id: USER_A_ID, type: "private", first_name: "UserA" },
        from: { id: USER_A_ID, is_bot: false, first_name: "UserA" },
        text: `/start adm_${INITIAL_INVITE_CODE}`,
      },
    });

    const userA = await prisma.botUser.findUnique({
      where: { botId_tgId: { botId, tgId: BigInt(USER_A_ID) } },
    });
    expect(userA?.isAdmin).toBe(true);

    // Admin creates a new invite code in PostgreSQL
    const NEW_INVITE_CODE = "regenerated_code_999";
    await prisma.adminInvite.create({
      data: {
        botId,
        codeHash: sha256Hex(NEW_INVITE_CODE),
        role: "STAFF",
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    await tenantResolver.invalidate(botTokenHash, botId);
    const freshMeta = await tenantResolver.resolve(botTokenHash);
    expect(freshMeta).not.toBeNull();

    // User B tries OLD used invite code -> MUST BE REJECTED (user created but isAdmin false)
    await botPool.handleUpdate(freshMeta!, {
      update_id: 202,
      message: {
        message_id: 11,
        date: Math.floor(Date.now() / 1000),
        chat: { id: USER_B_ID, type: "private", first_name: "UserB" },
        from: { id: USER_B_ID, is_bot: false, first_name: "UserB" },
        text: `/start adm_${INITIAL_INVITE_CODE}`,
      },
    });

    let userB = await prisma.botUser.findUnique({
      where: { botId_tgId: { botId, tgId: BigInt(USER_B_ID) } },
    });
    expect(userB).not.toBeNull();
    expect(userB?.isAdmin).toBe(false);

    // User B now uses NEW invite code -> MUST BE ACCEPTED (upgraded to admin)
    await botPool.handleUpdate(freshMeta!, {
      update_id: 203,
      message: {
        message_id: 12,
        date: Math.floor(Date.now() / 1000),
        chat: { id: USER_B_ID, type: "private", first_name: "UserB" },
        from: { id: USER_B_ID, is_bot: false, first_name: "UserB" },
        text: `/start adm_${NEW_INVITE_CODE}`,
      },
    });

    userB = await prisma.botUser.findUnique({
      where: { botId_tgId: { botId, tgId: BigInt(USER_B_ID) } },
    });
    expect(userB?.isAdmin).toBe(true);
    expect(userB?.role).toBe("STAFF");
  });

  it("4. should immediately reflect subscription expiration and mask leads without process restart", async () => {
    await prisma.lead.create({
      data: {
        botId,
        customerTgId: BigInt(USER_A_ID),
        customerName: "Alexandr Petrov",
        phoneRaw: "+998901234567",
        answers: {},
      },
    });

    await prisma.botUser.create({
      data: {
        botId,
        tgId: BigInt(USER_A_ID),
        isAdmin: true,
        lang: "RU",
      },
    });

    const activeMeta = await tenantResolver.resolve(botTokenHash);
    expect(activeMeta?.subscriptionStatus).toBe("ACTIVE");

    await botPool.handleUpdate(activeMeta!, {
      update_id: 301,
      callback_query: {
        id: "cb_301",
        from: { id: USER_A_ID, is_bot: false, first_name: "Admin" },
        chat_instance: "ci_1",
        data: "admin:leads",
      },
    });

    let sentMessages = getSentMessages(transport, USER_A_ID);
    expect(sentMessages.length).toBeGreaterThan(0);
    let leadsText = sentMessages[sentMessages.length - 1]!.text;
    expect(leadsText).toContain("Alexandr Petrov");
    expect(leadsText).toContain("+998901234567");

    await prisma.subscription.update({
      where: { botId },
      data: { status: "EXPIRED" },
    });

    await tenantResolver.invalidate(botTokenHash, botId);

    const expiredMeta = await tenantResolver.resolve(botTokenHash);
    expect(expiredMeta?.subscriptionStatus).toBe("EXPIRED");

    await botPool.handleUpdate(expiredMeta!, {
      update_id: 302,
      callback_query: {
        id: "cb_302",
        from: { id: USER_A_ID, is_bot: false, first_name: "Admin" },
        chat_instance: "ci_2",
        data: "admin:leads",
      },
    });

    sentMessages = getSentMessages(transport, USER_A_ID);
    leadsText = sentMessages[sentMessages.length - 1]!.text;
    expect(leadsText).not.toContain("Alexandr Petrov");
    expect(leadsText).not.toContain("+998901234567");
    expect(leadsText).toContain("***");
    expect(leadsText).toContain("+998 90 *** ** 67");

    await prisma.subscription.update({
      where: { botId },
      data: { status: "ACTIVE" },
    });
    await tenantResolver.invalidate(botTokenHash, botId);

    const renewedMeta = await tenantResolver.resolve(botTokenHash);
    expect(renewedMeta?.subscriptionStatus).toBe("ACTIVE");

    await botPool.handleUpdate(renewedMeta!, {
      update_id: 303,
      callback_query: {
        id: "cb_303",
        from: { id: USER_A_ID, is_bot: false, first_name: "Admin" },
        chat_instance: "ci_3",
        data: "admin:leads",
      },
    });

    sentMessages = getSentMessages(transport, USER_A_ID);
    leadsText = sentMessages[sentMessages.length - 1]!.text;
    expect(leadsText).toContain("Alexandr Petrov");
    expect(leadsText).toContain("+998901234567");
  });

  it("5. should update bot settings and apply new quiz scenario dynamically in the same process", async () => {
    const initialMeta = await tenantResolver.resolve(botTokenHash);
    expect(initialMeta).not.toBeNull();

    await prisma.botUser.create({
      data: {
        botId,
        tgId: BigInt(USER_A_ID),
        isAdmin: false,
        lang: "RU",
      },
    });

    await botPool.handleUpdate(initialMeta!, {
      update_id: 401,
      message: {
        message_id: 50,
        date: Math.floor(Date.now() / 1000),
        chat: { id: USER_A_ID, type: "private", first_name: "UserA" },
        from: { id: USER_A_ID, is_bot: false, first_name: "QuizUser" },
        text: "/start",
      },
    });

    let sent = getSentMessages(transport, USER_A_ID);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[sent.length - 1]!.text).toContain("услуга вас интересует");

    const customQuiz = {
      startNodeId: "q_custom_1",
      nodes: [
        {
          id: "q_custom_1",
          title: {
            ru: "Какой тип ремонта вам требуется?",
            uz: "Sizga qanday ta'mirlash kerak?",
          },
          options: [
            {
              id: "opt_1",
              text: { ru: "Сантехника", uz: "Santexnika" },
              nextNodeId: "q_custom_2",
            },
          ],
        },
        {
          id: "q_custom_2",
          title: {
            ru: "Когда приступить к работе?",
            uz: "Qachon boshlash kerak?",
          },
          options: [
            {
              id: "opt_2",
              text: { ru: "Срочно", uz: "Tezda" },
              nextNodeId: "q_custom_3",
            },
          ],
        },
        {
          id: "q_custom_3",
          title: {
            ru: "Укажите ваш район:",
            uz: "Tumaningizni ko'rsating:",
          },
          options: [
            {
              id: "opt_3",
              text: { ru: "Центр", uz: "Markaz" },
            },
          ],
        },
      ],
    };

    await prisma.bot.update({
      where: { id: botId },
      data: {
        settings: { quiz: customQuiz },
      },
    });

    await tenantResolver.invalidate(botTokenHash, botId);

    const updatedMeta = await tenantResolver.resolve(botTokenHash);
    expect(updatedMeta?.settings).toBeDefined();

    await redis.del(`sess:${botId}:${USER_B_ID}`);
    await prisma.botUser.create({
      data: {
        botId,
        tgId: BigInt(USER_B_ID),
        isAdmin: false,
        lang: "RU",
      },
    });

    await botPool.handleUpdate(updatedMeta!, {
      update_id: 402,
      message: {
        message_id: 51,
        date: Math.floor(Date.now() / 1000),
        chat: { id: USER_B_ID, type: "private", first_name: "UserB" },
        from: { id: USER_B_ID, is_bot: false, first_name: "QuizUser2" },
        text: "/start",
      },
    });

    sent = getSentMessages(transport, USER_B_ID);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[sent.length - 1]!.text).toContain("Какой тип ремонта вам требуется?");
  });

  it("6. should isolate concurrent updates using AsyncLocalStorage without race condition or state cross-talk", async () => {
    const meta = await tenantResolver.resolve(botTokenHash);
    expect(meta).not.toBeNull();

    const userIds = Array.from({ length: 10 }, (_, i) => 8000 + i);

    for (const uid of userIds) {
      await prisma.botUser.create({
        data: {
          botId,
          tgId: BigInt(uid),
          lang: "RU",
          isAdmin: false,
        },
      });
    }

    const promises = userIds.map((uid, idx) =>
      botPool.handleUpdate(meta!, {
        update_id: 500 + idx,
        message: {
          message_id: 100 + idx,
          date: Math.floor(Date.now() / 1000),
          chat: { id: uid, type: "private", first_name: `User_${uid}` },
          from: { id: uid, is_bot: false, first_name: `Concurrent_${uid}` },
          text: "/start",
        },
      }),
    );

    await Promise.all(promises);

    for (const uid of userIds) {
      const messages = getSentMessages(transport, uid);
      expect(messages.length).toBeGreaterThan(0);
      expect(messages[0]!.chatId).toBe(uid);
    }
  });

  it("7. should gracefully handle Redis invalidation and read failures by falling back to DB", async () => {
    const badRedis = {
      ...redis,
      del: async () => {
        throw new Error("Redis cluster disconnected");
      },
    } as unknown as Redis;

    const failingResolver = new TenantResolver({
      prisma,
      redis: badRedis,
      cacheTtlSec: 600,
      logger,
    });

    await expect(failingResolver.invalidate(botTokenHash, botId)).resolves.not.toThrow();

    const failingReadRedis = {
      ...redis,
      get: async () => {
        throw new Error("Redis read timeout");
      },
      set: async () => "OK",
    } as unknown as Redis;

    const readFailingResolver = new TenantResolver({
      prisma,
      redis: failingReadRedis,
      cacheTtlSec: 600,
      logger,
    });

    const resolved = await readFailingResolver.resolve(botTokenHash);
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe(botId);
  });
});
