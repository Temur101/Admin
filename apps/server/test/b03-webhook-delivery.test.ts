import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildApp,
  connectRedis,
  encryptSecret,
  sha256Hex,
  MockTelegramTransport,
  type Redis,
  type FastifyInstance,
} from "../src/index.js";
import { env } from "../src/core/env.js";
import { logger } from "../src/core/logger.js";
import {
  BotPool,
  TenantResolver,
  UpdateDeduplicator,
  WebhookInboxService,
} from "../src/gateway/index.js";
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

describe("B03: Webhook Reception Without Message Loss", () => {
  let redis: Redis;
  let transport: MockTelegramTransport;
  let botIdA: string;
  let botTokenHashA: string;
  let botIdB: string;
  let botTokenHashB: string;
  const SECRET_TOKEN = "secret_b03_delivery_token";
  const USER_ID = 8801;

  beforeAll(async () => {
    await prisma.$connect();
    redis = createTestRedisClient("test-b03-delivery");
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
      data: { clientName: "B03 Tenant", contactPhone: "+998901234567" },
    });

    botTokenHashA = sha256Hex("1001:BotAToken");
    botTokenHashB = sha256Hex("1002:BotBToken");

    const botA = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "LEADCATCH",
        botTokenEnc: encryptSecret("1001:BotAToken", env.TOKEN_ENCRYPTION_KEY),
        botTokenHash: botTokenHashA,
        webhookSecret: SECRET_TOKEN,
        botUsername: "@b03_bot_a",
        adminInviteCode: "b03_adm_code_a",
        subscription: {
          create: {
            status: "ACTIVE",
            trialEndsAt: new Date(Date.now() + 86400000 * 30),
            paidUntil: new Date(Date.now() + 86400000 * 30),
          },
        },
      },
    });
    botIdA = botA.id;

    const botB = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "QUICKBOOK",
        botTokenEnc: encryptSecret("1002:BotBToken", env.TOKEN_ENCRYPTION_KEY),
        botTokenHash: botTokenHashB,
        webhookSecret: SECRET_TOKEN,
        botUsername: "@b03_bot_b",
        adminInviteCode: "b03_adm_code_b",
        subscription: {
          create: {
            status: "ACTIVE",
            trialEndsAt: new Date(Date.now() + 86400000 * 30),
            paidUntil: new Date(Date.now() + 86400000 * 30),
          },
        },
      },
    });
    botIdB = botB.id;
  });

  it("1. should return 429 under capacity overload without marking update as duplicate, allowing retry", async () => {
    let app: FastifyInstance | null = null;
    let handledCount = 0;

    app = await buildApp({
      prisma,
      redis,
      transport,
      onUpdateHandled: () => {
        handledCount++;
      },
    });
    await app.ready();

    // Warm up resolver
    const resolver = new TenantResolver({ prisma, redis, cacheTtlSec: 600, logger });
    await resolver.resolve(botTokenHashA);

    // Inject request with maxInflight exceeded (we inject through a mock maxInflight gateway or app)
    const updateId = 10001;

    // Test capacity limit by triggering gateway with maxInflight = 0
    const testApp = await buildApp({
      prisma,
      redis,
      transport,
    });
    // In buildApp, env.WEBHOOK_MAX_INFLIGHT defaults to 500, but we can verify capacity 429
    // by testing with an app configured with maxInflight = 0
    const localResolver = new TenantResolver({ prisma, redis, cacheTtlSec: 600, logger });
    const localPool = new BotPool({
      capacity: 10,
      encryptionKey: env.TOKEN_ENCRYPTION_KEY,
      transport,
      redis,
      sessionTtlSec: 60,
      logger,
      prisma,
    });
    const localDedup = new UpdateDeduplicator(redis, 60, logger);
    const localInbox = new WebhookInboxService({
      prisma,
      redis,
      botPool: localPool,
      tenantResolver: localResolver,
      deduplicator: localDedup,
      logger,
    });

    const Fastify = (await import("fastify")).default;
    const overloadedApp = Fastify();
    const { registerWebhookGateway } = await import("../src/gateway/webhook-handler.js");
    registerWebhookGateway(overloadedApp, {
      tenantResolver: localResolver,
      botPool: localPool,
      deduplicator: localDedup,
      inboxService: localInbox,
      logger,
      maxInflight: 0, // 0 capacity -> immediately over capacity
    });
    await overloadedApp.ready();

    // 1. First attempt: returns 429
    const res429 = await overloadedApp.inject({
      method: "POST",
      url: `/api/v1/tg/webhook/${botTokenHashA}`,
      headers: { "x-telegram-bot-api-secret-token": SECRET_TOKEN },
      payload: {
        update_id: updateId,
        message: {
          message_id: 1,
          date: Math.floor(Date.now() / 1000),
          chat: { id: USER_ID, type: "private" },
          from: { id: USER_ID, is_bot: false, first_name: "TestUser" },
          text: "/start",
        },
      },
    });

    expect(res429.statusCode).toBe(429);
    expect(res429.json()).toEqual({ ok: false, error: "Server busy" });

    // Assert update was NOT marked duplicate in Redis and NOT in WebhookInbox
    const isDup = await localDedup.isDuplicate(botIdA, updateId);
    expect(isDup).toBe(false);

    const inboxRecord = await prisma.webhookInbox.findUnique({
      where: { botId_updateId: { botId: botIdA, updateId: BigInt(updateId) } },
    });
    expect(inboxRecord).toBeNull();

    await overloadedApp.close();

    // 2. Retry on regular app with available capacity: MUST SUCCEED (not rejected as duplicate!)
    const resRetry = await app.inject({
      method: "POST",
      url: `/api/v1/tg/webhook/${botTokenHashA}`,
      headers: { "x-telegram-bot-api-secret-token": SECRET_TOKEN },
      payload: {
        update_id: updateId,
        message: {
          message_id: 1,
          date: Math.floor(Date.now() / 1000),
          chat: { id: USER_ID, type: "private" },
          from: { id: USER_ID, is_bot: false, first_name: "TestUser" },
          text: "/start",
        },
      },
    });

    expect(resRetry.statusCode).toBe(200);
    expect(resRetry.json()).toEqual({ ok: true });

    // Wait for update processing
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (handledCount > 0) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    expect(handledCount).toBe(1);

    // Verify inbox record is COMPLETED
    const savedInbox = await prisma.webhookInbox.findUnique({
      where: { botId_updateId: { botId: botIdA, updateId: BigInt(updateId) } },
    });
    expect(savedInbox).not.toBeNull();
    expect(savedInbox?.status).toBe("COMPLETED");

    await app.close();
    await testApp.close();
  });

  it("2. should atomically handle concurrent duplicate updates on same bot: exactly one processes, others return duplicate", async () => {
    let processCount = 0;

    const app = await buildApp({
      prisma,
      redis,
      transport,
      onUpdateHandled: () => {
        processCount++;
      },
    });
    await app.ready();

    const updateId = 20002;
    const requests = Array.from({ length: 10 }, () =>
      app.inject({
        method: "POST",
        url: `/api/v1/tg/webhook/${botTokenHashA}`,
        headers: { "x-telegram-bot-api-secret-token": SECRET_TOKEN },
        payload: {
          update_id: updateId,
          message: {
            message_id: 1,
            date: Math.floor(Date.now() / 1000),
            chat: { id: USER_ID, type: "private" },
            from: { id: USER_ID, is_bot: false, first_name: "TestUser" },
            text: "/start",
          },
        },
      }),
    );

    const responses = await Promise.all(requests);

    // All 10 requests must receive 200 OK
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
    }

    // Exactly 1 returned { ok: true }, 9 returned { ok: true, duplicate: true }
    const nonDuplicates = responses.filter((r) => r.json().duplicate !== true);
    const duplicates = responses.filter((r) => r.json().duplicate === true);

    expect(nonDuplicates.length).toBe(1);
    expect(duplicates.length).toBe(9);

    // Exactly 1 WebhookInbox record exists in PostgreSQL
    const inboxRecords = await prisma.webhookInbox.findMany({
      where: { botId: botIdA, updateId: BigInt(updateId) },
    });
    expect(inboxRecords.length).toBe(1);

    // Wait for single processing to finish
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (processCount > 0) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    expect(processCount).toBe(1);
    await app.close();
  });

  it("3. should handle identical update_id across DIFFERENT bots without collision or cross-talk", async () => {
    const handledBots: string[] = [];

    const app = await buildApp({
      prisma,
      redis,
      transport,
      onUpdateHandled: (botId) => {
        handledBots.push(botId);
      },
    });
    await app.ready();

    const sharedUpdateId = 30003;

    // Send update with same update_id to Bot A and Bot B concurrently
    const [resA, resB] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/api/v1/tg/webhook/${botTokenHashA}`,
        headers: { "x-telegram-bot-api-secret-token": SECRET_TOKEN },
        payload: {
          update_id: sharedUpdateId,
          message: {
            message_id: 1,
            date: Math.floor(Date.now() / 1000),
            chat: { id: USER_ID, type: "private" },
            from: { id: USER_ID, is_bot: false, first_name: "UserA" },
            text: "/start",
          },
        },
      }),
      app.inject({
        method: "POST",
        url: `/api/v1/tg/webhook/${botTokenHashB}`,
        headers: { "x-telegram-bot-api-secret-token": SECRET_TOKEN },
        payload: {
          update_id: sharedUpdateId,
          message: {
            message_id: 1,
            date: Math.floor(Date.now() / 1000),
            chat: { id: USER_ID, type: "private" },
            from: { id: USER_ID, is_bot: false, first_name: "UserB" },
            text: "/start",
          },
        },
      }),
    ]);

    expect(resA.statusCode).toBe(200);
    expect(resA.json()).toEqual({ ok: true });

    expect(resB.statusCode).toBe(200);
    expect(resB.json()).toEqual({ ok: true });

    // Wait for both updates to be handled
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (handledBots.length >= 2) {
          clearInterval(check);
          resolve();
        }
      }, 20);
    });

    expect(handledBots).toContain(botIdA);
    expect(handledBots).toContain(botIdB);

    // Verify both inbox records exist independently
    const inboxA = await prisma.webhookInbox.findUnique({
      where: { botId_updateId: { botId: botIdA, updateId: BigInt(sharedUpdateId) } },
    });
    const inboxB = await prisma.webhookInbox.findUnique({
      where: { botId_updateId: { botId: botIdB, updateId: BigInt(sharedUpdateId) } },
    });

    expect(inboxA).not.toBeNull();
    expect(inboxA?.status).toBe("COMPLETED");

    expect(inboxB).not.toBeNull();
    expect(inboxB?.status).toBe("COMPLETED");

    await app.close();
  });

  it("4. should recover and execute pending updates after simulated server crash or restart", async () => {
    const resolver = new TenantResolver({ prisma, redis, cacheTtlSec: 600, logger });
    const pool = new BotPool({
      capacity: 10,
      encryptionKey: env.TOKEN_ENCRYPTION_KEY,
      transport,
      redis,
      sessionTtlSec: 60,
      logger,
      prisma,
    });
    const dedup = new UpdateDeduplicator(redis, 60, logger);
    const inboxService = new WebhookInboxService({
      prisma,
      redis,
      botPool: pool,
      tenantResolver: resolver,
      deduplicator: dedup,
      logger,
    });

    // Seed User with language
    await prisma.botUser.create({
      data: {
        botId: botIdA,
        tgId: BigInt(USER_ID),
        isAdmin: false,
        lang: "RU",
      },
    });

    const updateId = 40004;

    // Simulate crash: record was persisted into WebhookInbox with RECEIVED status, but process died before handling
    const createdInbox = await prisma.webhookInbox.create({
      data: {
        botId: botIdA,
        updateId: BigInt(updateId),
        payload: {
          update_id: updateId,
          message: {
            message_id: 1,
            date: Math.floor(Date.now() / 1000),
            chat: { id: USER_ID, type: "private" },
            from: { id: USER_ID, is_bot: false, first_name: "CrashUser" },
            text: "/start",
          },
        },
        status: "RECEIVED",
        attempts: 0,
      },
    });

    expect(createdInbox.status).toBe("RECEIVED");

    // Process restarts and runs recovery sweep
    const recoveredCount = await inboxService.recoverPending(10);
    expect(recoveredCount).toBe(1);

    // Verify inbox item transitioned to COMPLETED
    const afterRecovery = await prisma.webhookInbox.findUnique({
      where: { id: createdInbox.id },
    });
    expect(afterRecovery?.status).toBe("COMPLETED");
    expect(afterRecovery?.processedAt).not.toBeNull();

    // Verify user received welcome/quiz message from bot
    const sent = getSentMessages(transport, USER_ID);
    expect(sent.length).toBeGreaterThan(0);
  });

  it("5. should prevent duplicate business records (leads) on retry after partial success", async () => {
    const resolver = new TenantResolver({ prisma, redis, cacheTtlSec: 600, logger });
    const pool = new BotPool({
      capacity: 10,
      encryptionKey: env.TOKEN_ENCRYPTION_KEY,
      transport,
      redis,
      sessionTtlSec: 60,
      logger,
      prisma,
    });
    const dedup = new UpdateDeduplicator(redis, 60, logger);
    const inboxService = new WebhookInboxService({
      prisma,
      redis,
      botPool: pool,
      tenantResolver: resolver,
      deduplicator: dedup,
      logger,
    });

    const resolved = await resolver.resolve(botTokenHashA);
    expect(resolved).not.toBeNull();

    // Reach the actual contact step; a phone without an active quiz is intentionally ignored.
    const user = { id: USER_ID, is_bot: false as const, first_name: "LeadCustomer" };
    const chat = { id: USER_ID, type: "private" as const, first_name: "LeadCustomer" };
    await pool.handleUpdate(resolved!, {
      update_id: 49000,
      message: { message_id: 1, date: 1, from: user, chat, text: "/start" },
    });
    await pool.handleUpdate(resolved!, {
      update_id: 49001,
      callback_query: { id: "language", from: user, chat_instance: "test", data: "set_lang:RU" },
    });
    for (let step = 0; step < 3; step++) {
      const last = transport
        .callsOf("sendMessage")
        .filter((call) => Number(call.payload.chat_id) === USER_ID)
        .at(-1)!;
      const markup = last.payload.reply_markup as {
        inline_keyboard: { callback_data: string }[][];
      };
      await pool.handleUpdate(resolved!, {
        update_id: 49002 + step,
        callback_query: {
          id: `answer-${step}`,
          from: user,
          chat_instance: "test",
          data: markup.inline_keyboard[0]![0]!.callback_data,
        },
      });
    }
    let fail = true;
    pool.getOrCreateBot(resolved!).api.config.use(async (previous, method, body, signal) => {
      if (method === "sendMessage" && fail) {
        fail = false;
        throw new Error("Telegram confirmation lost");
      }
      return previous(method, body, signal);
    });
    const payload = {
      update_id: 50005,
      message: {
        message_id: 99,
        date: Math.floor(Date.now() / 1000),
        chat: { id: USER_ID, type: "private" },
        from: { id: USER_ID, is_bot: false, first_name: "LeadCustomer" },
        contact: {
          phone_number: "+998901234567",
          first_name: "LeadCustomer",
        },
      },
    };

    // First execution
    const enqueue1 = await inboxService.enqueue(botIdA, 50005, payload);
    expect(enqueue1.status).toBe("ENQUEUED");
    await expect(inboxService.processItem(enqueue1.inboxId!, resolved!, payload)).rejects.toThrow(
      "Telegram confirmation lost",
    );
    expect(
      (await prisma.webhookInbox.findUnique({ where: { id: enqueue1.inboxId! } }))?.status,
    ).toBe("RECEIVED");

    let leads = await prisma.lead.findMany({
      where: { botId: botIdA, customerTgId: BigInt(USER_ID) },
    });
    expect(leads.length).toBe(1);

    // Simulate recovery / retry of the exact same message contact payload
    await inboxService.processItem(enqueue1.inboxId!, resolved!, payload);
    expect(
      (await prisma.webhookInbox.findUnique({ where: { id: enqueue1.inboxId! } }))?.status,
    ).toBe("COMPLETED");

    // Leads count MUST still be exactly 1 (no duplicate lead!)
    leads = await prisma.lead.findMany({
      where: { botId: botIdA, customerTgId: BigInt(USER_ID) },
    });
    expect(leads.length).toBe(1);
  });

  it("6. should return 503 and reject HTTP 200 when database persistence fails", async () => {
    // Failing prisma mock for inbox creation
    const failingPrisma = {
      ...prisma,
      webhookInbox: {
        ...prisma.webhookInbox,
        create: async () => {
          throw new Error("PostgreSQL connection lost");
        },
      },
    } as unknown as typeof prisma;

    const resolver = new TenantResolver({ prisma, redis, cacheTtlSec: 600, logger });
    const pool = new BotPool({
      capacity: 10,
      encryptionKey: env.TOKEN_ENCRYPTION_KEY,
      transport,
      redis,
      sessionTtlSec: 60,
      logger,
      prisma,
    });
    const dedup = new UpdateDeduplicator(redis, 60, logger);
    const inboxService = new WebhookInboxService({
      prisma: failingPrisma,
      redis,
      botPool: pool,
      tenantResolver: resolver,
      deduplicator: dedup,
      logger,
    });

    const Fastify = (await import("fastify")).default;
    const testApp = Fastify();
    const { registerWebhookGateway } = await import("../src/gateway/webhook-handler.js");
    registerWebhookGateway(testApp, {
      tenantResolver: resolver,
      botPool: pool,
      deduplicator: dedup,
      inboxService,
      logger,
    });
    await testApp.ready();

    const res = await testApp.inject({
      method: "POST",
      url: `/api/v1/tg/webhook/${botTokenHashA}`,
      headers: { "x-telegram-bot-api-secret-token": SECRET_TOKEN },
      payload: {
        update_id: 60006,
        message: {
          message_id: 1,
          date: Math.floor(Date.now() / 1000),
          chat: { id: USER_ID, type: "private" },
          from: { id: USER_ID, is_bot: false, first_name: "User" },
          text: "/start",
        },
      },
    });

    // When DB fails, server MUST NOT return 200! It must return 503 so Telegram retries!
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, error: "Database unavailable" });

    await testApp.close();
  });

  it("7. should serialize concurrent updates from the same Telegram user using session locking", async () => {
    const resolver = new TenantResolver({ prisma, redis, cacheTtlSec: 600, logger });
    const pool = new BotPool({
      capacity: 10,
      encryptionKey: env.TOKEN_ENCRYPTION_KEY,
      transport,
      redis,
      sessionTtlSec: 60,
      logger,
      prisma,
    });
    const dedup = new UpdateDeduplicator(redis, 60, logger);
    const inboxService = new WebhookInboxService({
      prisma,
      redis,
      botPool: pool,
      tenantResolver: resolver,
      deduplicator: dedup,
      logger,
    });

    const resolved = await resolver.resolve(botTokenHashA);
    expect(resolved).not.toBeNull();

    await prisma.botUser.create({
      data: {
        botId: botIdA,
        tgId: BigInt(USER_ID),
        isAdmin: false,
        lang: "RU",
      },
    });

    // User sends 2 messages simultaneously
    const payload1 = {
      update_id: 70001,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: USER_ID, type: "private" },
        from: { id: USER_ID, is_bot: false, first_name: "RapidUser" },
        text: "/start",
      },
    };

    const payload2 = {
      update_id: 70002,
      message: {
        message_id: 2,
        date: Math.floor(Date.now() / 1000),
        chat: { id: USER_ID, type: "private" },
        from: { id: USER_ID, is_bot: false, first_name: "RapidUser" },
        text: "/quiz",
      },
    };

    const [enq1, enq2] = await Promise.all([
      inboxService.enqueue(botIdA, 70001, payload1),
      inboxService.enqueue(botIdA, 70002, payload2),
    ]);

    expect(enq1.status).toBe("ENQUEUED");
    expect(enq2.status).toBe("ENQUEUED");

    // Process both concurrently -> session lock serializes them sequentially
    await Promise.all([
      inboxService.processItem(enq1.inboxId!, resolved!, payload1),
      inboxService.processItem(enq2.inboxId!, resolved!, payload2),
    ]);

    const item1 = await prisma.webhookInbox.findUnique({ where: { id: enq1.inboxId } });
    const item2 = await prisma.webhookInbox.findUnique({ where: { id: enq2.inboxId } });

    expect(item1?.status).toBe("COMPLETED");
    expect(item2?.status).toBe("COMPLETED");

    // User session remains valid and not corrupted
    const sessionRaw = await redis.get(`sess:${botIdA}:${USER_ID}`);
    expect(sessionRaw).not.toBeNull();
  });
});
