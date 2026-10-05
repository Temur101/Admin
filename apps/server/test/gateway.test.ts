import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  buildApp,
  createRedisClient,
  connectRedis,
  encryptSecret,
  sha256Hex,
  MockTelegramTransport,
  BotPool,
  TenantResolver,
  UpdateDeduplicator,
  logger,
  type Redis,
  type ResolvedBot,
} from "../src/index.js";
import { env } from "../src/core/env.js";

const testDbUrl =
  env.TEST_DATABASE_URL ||
  "postgresql://lcqb_app:5I70xaPikIy89TkEf8EADtcqpKusnnl4@127.0.0.1:5433/leadcatch_quickbook_test?schema=public";

const prisma = new PrismaClient({
  datasources: {
    db: { url: testDbUrl },
  },
});

let redis: Redis;
const TEST_TOKEN_PLAIN = "123456789:ABCdefGHIjklMNOpqrsTUVwxyz_1234567";
const TEST_TOKEN_HASH = sha256Hex(TEST_TOKEN_PLAIN);
const TEST_WEBHOOK_SECRET = "webhook_secret_valid_1234567890";

describe("Stage 2: Webhook Gateway & Multi-Tenant Routing", () => {
  let botId: string;
  let tenantId: string;

  beforeAll(async () => {
    await prisma.$connect();
    redis = createRedisClient({
      url: env.TEST_REDIS_URL || env.REDIS_URL,
      logger,
      name: "test-gateway",
    });
    await connectRedis(redis);
  });

  afterAll(async () => {
    if (redis && redis.status !== "end") {
      await redis.quit();
    }
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Flush test keys in Redis
    await redis.flushdb();

    // Clean tables
    await prisma.booking.deleteMany();
    await prisma.lead.deleteMany();
    await prisma.paymentReceipt.deleteMany();
    await prisma.botUser.deleteMany();
    await prisma.subscription.deleteMany();
    await prisma.bot.deleteMany();
    await prisma.tenant.deleteMany();

    // Create test tenant and bot
    const tenant = await prisma.tenant.create({
      data: {
        clientName: "Gateway Test Client",
        contactPhone: "+998901112233",
      },
    });
    tenantId = tenant.id;

    const botTokenEnc = encryptSecret(TEST_TOKEN_PLAIN, env.TOKEN_ENCRYPTION_KEY);
    const bot = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "LEADCATCH",
        botTokenEnc,
        botTokenHash: TEST_TOKEN_HASH,
        webhookSecret: TEST_WEBHOOK_SECRET,
        adminInviteCode: "test_invite_001",
        subscription: {
          create: {
            status: "ACTIVE",
            trialEndsAt: new Date(Date.now() + 86400000 * 3),
            paidUntil: new Date(Date.now() + 86400000 * 30),
          },
        },
      },
    });
    botId = bot.id;
  });

  it("1. should return 400 if botTokenHash format is invalid", async () => {
    const app = await buildApp({ prisma, redis });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/tg/webhook/invalid-short-hash",
      headers: {
        "x-telegram-bot-api-secret-token": TEST_WEBHOOK_SECRET,
      },
      payload: { update_id: 100 },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ ok: false, error: "Invalid botTokenHash format" });
    await app.close();
  });

  it("2. should return 401 if secret token header is missing", async () => {
    const app = await buildApp({ prisma, redis });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tg/webhook/${TEST_TOKEN_HASH}`,
      payload: { update_id: 101 },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ ok: false, error: "Missing secret token header" });
    await app.close();
  });

  it("3. should return 404 if bot is not found", async () => {
    const app = await buildApp({ prisma, redis });
    await app.ready();

    const unknownHash = sha256Hex("unknown-bot-token-999");
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tg/webhook/${unknownHash}`,
      headers: {
        "x-telegram-bot-api-secret-token": TEST_WEBHOOK_SECRET,
      },
      payload: { update_id: 102 },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ ok: false, error: "Bot not found" });
    await app.close();
  });

  it("4. should return 401 if secret token header does not match", async () => {
    const app = await buildApp({ prisma, redis });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tg/webhook/${TEST_TOKEN_HASH}`,
      headers: {
        "x-telegram-bot-api-secret-token": "wrong_secret_token_12345",
      },
      payload: { update_id: 103 },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ ok: false, error: "Invalid secret token" });
    await app.close();
  });

  it("5. should return 400 if update payload is missing update_id", async () => {
    const app = await buildApp({ prisma, redis });
    await app.ready();

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tg/webhook/${TEST_TOKEN_HASH}`,
      headers: {
        "x-telegram-bot-api-secret-token": TEST_WEBHOOK_SECRET,
      },
      payload: { not_an_update: true },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ ok: false, error: "Invalid Telegram update payload" });
    await app.close();
  });

  it("6. should return 200 OK in < 50ms on valid update and execute asynchronously", async () => {
    let updateHandled = false;
    let handledUpdateId = 0;

    const app = await buildApp({
      prisma,
      redis,
      onUpdateHandled: (_bId, uId) => {
        updateHandled = true;
        handledUpdateId = uId;
      },
    });
    await app.ready();

    // Pre-warm bot cache in L1 Redis
    const resolver = new TenantResolver({
      prisma,
      redis,
      cacheTtlSec: 600,
      logger,
    });
    await resolver.resolve(TEST_TOKEN_HASH);

    const startTime = performance.now();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/tg/webhook/${TEST_TOKEN_HASH}`,
      headers: {
        "x-telegram-bot-api-secret-token": TEST_WEBHOOK_SECRET,
      },
      payload: {
        update_id: 50001,
        message: {
          message_id: 1,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 12345, type: "private" },
          text: "/start",
        },
      },
    });
    const duration = performance.now() - startTime;

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    // Gateway responds immediately without waiting for bot logic
    expect(duration).toBeLessThan(50);

    // Wait for the asynchronous background processing via setImmediate
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (updateHandled) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    expect(handledUpdateId).toBe(50001);
    await app.close();
  });

  it("7. should deduplicate: 10 concurrent requests with identical update_id are processed exactly once", async () => {
    let processCount = 0;

    const app = await buildApp({
      prisma,
      redis,
      onUpdateHandled: () => {
        processCount++;
      },
    });
    await app.ready();

    const updateId = 999001;
    const requests = Array.from({ length: 10 }, () =>
      app.inject({
        method: "POST",
        url: `/api/v1/tg/webhook/${TEST_TOKEN_HASH}`,
        headers: {
          "x-telegram-bot-api-secret-token": TEST_WEBHOOK_SECRET,
        },
        payload: {
          update_id: updateId,
          message: {
            message_id: 1,
            date: Math.floor(Date.now() / 1000),
            chat: { id: 777, type: "private" },
            text: "Parallel test",
          },
        },
      }),
    );

    const responses = await Promise.all(requests);

    // All requests must receive 200 OK (Telegram requires 200 OK so it doesn't back off)
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
    }

    // Exactly one response has duplicate: undefined (or ok: true), and 9 have duplicate: true
    const normalResponses = responses.filter((r) => !r.json<{ duplicate?: boolean }>().duplicate);
    const dupResponses = responses.filter((r) => r.json<{ duplicate?: boolean }>().duplicate);

    expect(normalResponses).toHaveLength(1);
    expect(dupResponses).toHaveLength(9);

    // Wait for async processing
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(processCount).toBe(1);

    await app.close();
  });

  it("8. Chaos Test: Redis degradation doesn't crash server and falls back gracefully", async () => {
    // Create an isolated resolver pointing to an unconnectable fake Redis client port
    const brokenRedis = createRedisClient({
      url: "redis://127.0.0.1:6378/0", // Non-existent port
      logger,
      name: "broken-redis",
      maxReconnectDelayMs: 100,
    });

    const tenantResolver = new TenantResolver({
      prisma,
      redis: brokenRedis,
      cacheTtlSec: 60,
      logger,
    });

    // Should still resolve bot directly from PostgreSQL without crashing
    const resolved = await tenantResolver.resolve(TEST_TOKEN_HASH);
    expect(resolved).not.toBeNull();
    expect(resolved?.id).toBe(botId);
    expect(resolved?.tenantId).toBe(tenantId);

    // Deduplicator with broken Redis should fail open (return false for duplicate, not throw)
    const deduplicator = new UpdateDeduplicator(brokenRedis, 60, logger);
    const isDup = await deduplicator.isDuplicate(botId, 12345);
    expect(isDup).toBe(false);

    await brokenRedis.quit().catch(() => {});
  });

  it("9. Memory leak test: 10,000 updates over 500 bot tokens stay bounded in LRU cache", async () => {
    const transport = new MockTelegramTransport();
    const capacity = 100;
    const botPool = new BotPool({
      capacity,
      encryptionKey: env.TOKEN_ENCRYPTION_KEY,
      transport,
      redis,
      sessionTtlSec: 3600,
      logger,
    });

    // Create 500 distinct resolved bot profiles
    const bots: ResolvedBot[] = [];
    for (let i = 0; i < 500; i++) {
      const plainToken = `${100000 + i}:AAAFakeToken_${i}_XYZ`;
      bots.push({
        id: `00000000-0000-0000-0000-${i.toString().padStart(12, "0")}`,
        tenantId,
        botType: i % 2 === 0 ? "LEADCATCH" : "QUICKBOOK",
        botTokenEnc: encryptSecret(plainToken, env.TOKEN_ENCRYPTION_KEY),
        botTokenHash: sha256Hex(plainToken),
        webhookSecret: `secret_${i}`,
        botUsername: `bot_${i}`,
        adminInviteCode: `code_${i}`,
        settings: {},
        subscriptionStatus: "ACTIVE",
        trialEndsAt: new Date().toISOString(),
        paidUntil: new Date().toISOString(),
      });
    }

    // Force GC if exposed
    if (typeof global.gc === "function") {
      global.gc();
    }
    const heapBefore = process.memoryUsage().heapUsed;

    // Simulate 10,000 update dispatches rotating through 500 bots
    for (let i = 0; i < 10000; i++) {
      const bot = bots[i % 500]!;
      const botInstance = botPool.getOrCreateBot(bot);
      await botInstance.handleUpdate({
        update_id: i,
        message: {
          message_id: i,
          date: 1700000000,
          chat: { id: 1000 + (i % 500), type: "private", first_name: "Test" },
          from: { id: 1000 + (i % 500), is_bot: false, first_name: "Test" },
          text: "/start",
        },
      });
    }

    // Pool capacity must never exceed 100
    expect(botPool.size).toBe(capacity);

    // Mock transport ring buffer bounded to 1,000 calls
    expect(transport.calls.length).toBeLessThanOrEqual(1000);

    if (typeof global.gc === "function") {
      global.gc();
    }
    const heapAfter = process.memoryUsage().heapUsed;
    const deltaBytes = heapAfter - heapBefore;
    const deltaMb = deltaBytes / (1024 * 1024);

    // Delta must be under 20 MB (plan requirement)
    expect(deltaMb).toBeLessThan(20);
  });
});
