import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  connectRedis,
  encryptSecret,
  sha256Hex,
  MockTelegramTransport,
  logger,
  type Redis,
} from "../src/index.js";
import { runSubscriptionWorker } from "../src/workers/subscription-worker.js";
import { env } from "../src/core/env.js";
import {
  getTestPrismaClient,
  createTestRedisClient,
  safeCleanTestDb,
  safeCleanTestRedis,
} from "./helpers/test-env.js";

const prisma = getTestPrismaClient();

let redis: Redis;

describe("Subscription Worker Integration & Concurrency", () => {
  let transport: MockTelegramTransport;

  beforeAll(async () => {
    await prisma.$connect();
    redis = createTestRedisClient("test-worker");
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
  });

  it("1. Time-travel test: expires trial on day 4 and sends exactly 1 notification to admin", async () => {
    const tenant = await prisma.tenant.create({
      data: { clientName: "Client Worker Test", contactPhone: "+998901234567" },
    });

    const token = "123456:WorkerTestBotToken_1";
    const bot = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "LEADCATCH",
        botTokenEnc: encryptSecret(token, env.TOKEN_ENCRYPTION_KEY),
        botTokenHash: sha256Hex(token),
        webhookSecret: "secret_worker_1",
        subscription: {
          create: {
            status: "TRIAL",
            trialEndsAt: new Date(Date.now() - 86400000), // Ended yesterday (day 4)
          },
        },
      },
    });

    // Create an admin for this bot
    const adminTgId = 9988776655n;
    await prisma.botUser.create({
      data: {
        botId: bot.id,
        tgId: adminTgId,
        firstName: "Test Admin",
        isAdmin: true,
        lang: "RU",
      },
    });

    // Run worker
    const result = await runSubscriptionWorker({
      prisma,
      redis,
      transport,
      logger,
    });

    expect(result.executed).toBe(true);
    expect(result.expiredCount).toBe(1);

    // Verify DB update
    const updatedSub = await prisma.subscription.findUnique({
      where: { botId: bot.id },
    });
    expect(updatedSub?.status).toBe("EXPIRED");

    // Verify admin received notification
    const calls = transport.callsOf("sendMessage");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload.chat_id).toBe(Number(adminTgId));
    expect(String(calls[0]?.payload.text)).toContain("истекли");
  });

  it("2. Concurrency test: two concurrent workers execute exactly once under Redis lock", async () => {
    const tenant = await prisma.tenant.create({
      data: { clientName: "Client Concurrent Test", contactPhone: "+998901234567" },
    });

    const token = "123456:WorkerTestBotToken_2";
    const bot = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "LEADCATCH",
        botTokenEnc: encryptSecret(token, env.TOKEN_ENCRYPTION_KEY),
        botTokenHash: sha256Hex(token),
        webhookSecret: "secret_worker_2",
        subscription: {
          create: {
            status: "ACTIVE",
            trialEndsAt: new Date(Date.now() - 86400000 * 10),
            paidUntil: new Date(Date.now() - 3600000), // Expired 1 hour ago
          },
        },
      },
    });

    const adminTgId = 1122334455n;
    await prisma.botUser.create({
      data: {
        botId: bot.id,
        tgId: adminTgId,
        firstName: "Concurrent Admin",
        isAdmin: true,
        lang: "RU",
      },
    });

    // Run two workers simultaneously
    const [res1, res2] = await Promise.all([
      runSubscriptionWorker({ prisma, redis, transport, logger }),
      runSubscriptionWorker({ prisma, redis, transport, logger }),
    ]);

    // Exactly one must acquire the lock and execute; the other must gracefully skip
    const executedWorkers = [res1, res2].filter((r) => r.executed);
    const skippedWorkers = [res1, res2].filter((r) => !r.executed);

    expect(executedWorkers).toHaveLength(1);
    expect(skippedWorkers).toHaveLength(1);
    expect(executedWorkers[0]?.expiredCount).toBe(1);
    expect(skippedWorkers[0]?.expiredCount).toBe(0);

    // Exactly 1 message sent
    const calls = transport.callsOf("sendMessage");
    expect(calls).toHaveLength(1);
  });
});
