import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectRedis, type Redis } from "../src/core/redis.js";
import { env } from "../src/core/env.js";
import { logger } from "../src/core/logger.js";
import { MockTelegramTransport } from "../src/adapters/telegram/mock-transport.js";
import { encryptSecret, sha256Hex } from "../src/core/crypto.js";
import { buildApp } from "../src/index.js";
import { runSubscriptionWorker } from "../src/workers/subscription-worker.js";
import {
  getTestPrismaClient,
  createTestRedisClient,
  safeCleanTestDb,
  safeCleanTestRedis,
} from "./helpers/test-env.js";

const prisma = getTestPrismaClient();

let redis: Redis;
let transport: MockTelegramTransport;

describe("B07: Background Worker Lifecycle, Scheduler & Health Probes", () => {
  let botId: string;
  const adminTgId = 112233;

  beforeAll(async () => {
    await prisma.$connect();
    redis = createTestRedisClient("test-b07-lifecycle");
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
      data: { clientName: "Tenant B07", contactPhone: "+998901234567" },
    });

    const botToken = "123456789:B07BotToken";
    const bot = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "QUICKBOOK",
        botTokenEnc: encryptSecret(botToken, env.TOKEN_ENCRYPTION_KEY),
        botTokenHash: sha256Hex(botToken),
        webhookSecret: "secret_b07",
        adminInviteCode: "b07_invite",
        subscription: {
          create: {
            status: "TRIAL",
            trialEndsAt: new Date(Date.now() - 3600_000), // Expired 1 hour ago
          },
        },
      },
    });
    botId = bot.id;

    await prisma.botUser.create({
      data: {
        botId,
        tgId: BigInt(adminTgId),
        firstName: "Админ B07",
        isAdmin: true,
        lang: "RU",
      },
    });
  });

  it("1. Ordinary startup runs scheduler automatically without manual worker invocation", async () => {
    // Schedule a reminder that is due right now
    const now = new Date();
    const booking = await prisma.booking.create({
      data: {
        botId,
        customerTgId: BigInt(888111),
        customerName: "Клиент Авто",
        customerPhone: "+998901112233",
        serviceId: "srv_1",
        serviceName: "Тест",
        staffId: "staff_1",
        durationMin: 30,
        slotTime: new Date(now.getTime() + 3600_000), // In 1 hour (within 2h window)
        status: "CONFIRMED",
        reminderSent: false,
      },
    });

    // Start app with scheduler enabled
    const app = await buildApp({
      prisma,
      redis,
      transport,
      enableScheduler: true,
      schedulerOptions: {
        runImmediately: true,
        subscriptionIntervalMs: 60_000,
        reminderIntervalMs: 60_000,
      },
    });
    await app.ready();

    // Verify scheduler was registered and is running
    const scheduler = (app as unknown as { scheduler: { running: boolean } }).scheduler;
    expect(scheduler).toBeDefined();
    expect(scheduler.running).toBe(true);

    // Wait a brief tick for the immediate executions to settle
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Verify subscription was expired by the automated background scheduler
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { botId } });
    expect(sub.status).toBe("EXPIRED");

    // Verify booking reminder was sent by the automated background scheduler
    const updatedBooking = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(updatedBooking.reminderSent).toBe(true);

    // Verify graceful shutdown stops scheduler cleanly
    await app.close();
    expect(scheduler.running).toBe(false);
  });

  it("2. Graceful shutdown leaves no lingering timers or active tasks", async () => {
    const app = await buildApp({
      prisma,
      redis,
      transport,
      enableScheduler: true,
      schedulerOptions: {
        subscriptionIntervalMs: 10_000,
        reminderIntervalMs: 10_000,
      },
    });
    await app.ready();

    const scheduler = (app as unknown as { scheduler: { running: boolean; activeTaskCount: number } }).scheduler;
    expect(scheduler.running).toBe(true);

    // Close application
    await app.close();

    expect(scheduler.running).toBe(false);
    expect(scheduler.activeTaskCount).toBe(0);
  });

  it("3. Long worker tick does not delete another worker's new lock (atomic Lua release)", async () => {
    const LOCK_KEY = "lock:worker:subscription";

    // Simulate Worker 1 acquired lock with a short TTL, and it expired.
    // Worker 2 comes in and acquires the lock with its own token.
    const worker2Token = "worker-2-owner-token-999";
    await redis.set(LOCK_KEY, worker2Token, "EX", 60);

    // Now run Worker 1 whose lock attempt fails because Worker 2 holds it
    const res = await runSubscriptionWorker({
      prisma,
      redis,
      transport,
      logger,
      lockTtlSec: 1,
    });
    expect(res.executed).toBe(false);

    // Verify Worker 2's lock was NOT deleted by Worker 1
    const currentVal = await redis.get(LOCK_KEY);
    expect(currentVal).toBe(worker2Token);
  });

  it("4. Subscription renewal during worker tick is NOT overwritten to EXPIRED", async () => {
    // Current sub is TRIAL, expired
    const subBefore = await prisma.subscription.findUniqueOrThrow({ where: { botId } });
    expect(subBefore.status).toBe("TRIAL");

    // Simulate concurrent admin approval: subscription is extended to ACTIVE until next year!
    const futureDate = new Date(Date.now() + 30 * 86400_000);
    await prisma.subscription.update({
      where: { botId },
      data: {
        status: "ACTIVE",
        paidUntil: futureDate,
      },
    });

    // Run subscription worker (pretending it ran with a snapshot right before renewal)
    await runSubscriptionWorker({
      prisma,
      redis,
      transport,
      logger,
      now: new Date(),
    });

    // The subscription should NOT be converted to EXPIRED
    const subAfter = await prisma.subscription.findUniqueOrThrow({ where: { botId } });
    expect(subAfter.status).toBe("ACTIVE");
    expect(subAfter.paidUntil?.getTime()).toBe(futureDate.getTime());
  });

  it("5. Health probes: separates liveness from readiness, reflecting dependency failure", async () => {
    const app = await buildApp({
      prisma,
      redis,
      transport,
      enableScheduler: false,
    });
    await app.ready();

    // 1. Healthy dependencies -> /health/live and /health/ready return 200
    const liveRes = await app.inject({ method: "GET", url: "/health/live" });
    expect(liveRes.statusCode).toBe(200);
    const liveBody = liveRes.json<{ status: string; uptime: number }>();
    expect(liveBody.status).toBe("ok");

    const readyRes = await app.inject({ method: "GET", url: "/health/ready" });
    expect(readyRes.statusCode).toBe(200);
    const readyBody = readyRes.json<{ status: string; dependencies: { database: string; redis: string } }>();
    expect(readyBody.status).toBe("ok");
    expect(readyBody.dependencies.database).toBe("connected");
    expect(readyBody.dependencies.redis).toBe("connected");

    const healthRes = await app.inject({ method: "GET", url: "/health" });
    expect(healthRes.statusCode).toBe(200);

    // 2. Simulate Redis failure on readiness probe
    const originalPing = redis.ping.bind(redis);
    redis.ping = async () => {
      throw new Error("Connection refused: 127.0.0.1:6379");
    };

    // /health/live should STILL be 200 (process is running)
    const liveAfterBreak = await app.inject({ method: "GET", url: "/health/live" });
    expect(liveAfterBreak.statusCode).toBe(200);

    // /health/ready MUST return 503 Service Unavailable
    const readyAfterBreak = await app.inject({ method: "GET", url: "/health/ready" });
    expect(readyAfterBreak.statusCode).toBe(503);
    const brokenBody = readyAfterBreak.json<{ status: string; dependencies: { redis: string } }>();
    expect(brokenBody.status).toBe("unhealthy");
    expect(brokenBody.dependencies.redis).toBe("error");

    // /health MUST also return 503
    const healthAfterBreak = await app.inject({ method: "GET", url: "/health" });
    expect(healthAfterBreak.statusCode).toBe(503);

    // Restore redis.ping
    redis.ping = originalPing;

    await app.close();
  });

  it("6. Prevents overlapping in-process ticks for the same worker", async () => {
    const app = await buildApp({
      prisma,
      redis,
      transport,
      enableScheduler: true,
      schedulerOptions: {
        runImmediately: false,
        subscriptionIntervalMs: 60_000,
        reminderIntervalMs: 60_000,
      },
    });
    await app.ready();

    const scheduler = (
      app as unknown as {
        scheduler: {
          triggerSubscriptionTick: () => Promise<unknown>;
          triggerReminderTick: () => Promise<unknown>;
          activeTaskCount: number;
        };
      }
    ).scheduler;

    const subTask1 = scheduler.triggerSubscriptionTick();
    const subTask2 = scheduler.triggerSubscriptionTick();
    expect(subTask1).toBe(subTask2);

    const remTask1 = scheduler.triggerReminderTick();
    const remTask2 = scheduler.triggerReminderTick();
    expect(remTask1).toBe(remTask2);
    expect(scheduler.activeTaskCount).toBe(2);

    await Promise.all([subTask1, remTask1]);
    expect(scheduler.activeTaskCount).toBe(0);

    await app.close();
  });
});
