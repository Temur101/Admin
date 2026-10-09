import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { connectRedis, createRedisClient, type Redis } from "../src/core/redis.js";
import { env } from "../src/core/env.js";
import { logger } from "../src/core/logger.js";
import { MockTelegramTransport } from "../src/adapters/telegram/mock-transport.js";
import { encryptSecret, sha256Hex } from "../src/core/crypto.js";
import { DEFAULT_QUICKBOOK_CONFIG } from "../src/bots/quickbook/default-config.js";
import { createBooking } from "../src/bots/quickbook/booking-service.js";

const testDbUrl =
  env.TEST_DATABASE_URL ||
  "postgresql://lcqb_app:5I70xaPikIy89TkEf8EADtcqpKusnnl4@127.0.0.1:5433/leadcatch_quickbook_test?schema=public";

const prisma = new PrismaClient({
  datasources: { db: { url: testDbUrl } },
});

let redis: Redis;
let transport: MockTelegramTransport;

describe("QuickBook Race Condition Test (50 Parallel Bookings)", () => {
  let botId: string;
  const slotTime = new Date("2026-10-20T10:00:00.000Z");

  beforeAll(async () => {
    await prisma.$connect();
    redis = createRedisClient({
      url: env.TEST_REDIS_URL || env.REDIS_URL,
      logger,
      name: "test-race",
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

    await prisma.booking.deleteMany();
    await prisma.lead.deleteMany();
    await prisma.paymentReceipt.deleteMany();
    await prisma.botUser.deleteMany();
    await prisma.subscription.deleteMany();
    await prisma.bot.deleteMany();
    await prisma.tenant.deleteMany();

    const tenant = await prisma.tenant.create({
      data: { clientName: "Race Tenant", contactPhone: "+998901112233" },
    });

    const botToken = "123456789:RaceTestBotToken";
    const bot = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "QUICKBOOK",
        botTokenEnc: encryptSecret(botToken, env.TOKEN_ENCRYPTION_KEY),
        botTokenHash: sha256Hex(botToken),
        webhookSecret: "secret_race",
        adminInviteCode: "race_invite",
        subscription: {
          create: {
            status: "TRIAL",
            trialEndsAt: new Date(Date.now() + 86400000 * 7),
          },
        },
      },
    });

    botId = bot.id;
  });

  it("should handle 50 concurrent bookings of the exact same slot: exactly 1 wins, 49 get alternative slots", async () => {
    const concurrency = 50;

    // Launch 50 simultaneous booking attempts
    const promises = Array.from({ length: concurrency }, (_, i) => {
      const pad = String(i).padStart(2, "0");
      return createBooking({
        prisma,
        redis,
        transport,
        logger,
        botId,
        customerTgId: 90000 + i,
        customerName: `Client ${i}`,
        customerPhone: `+9989012345${pad}`,
        serviceId: "srv_haircut",
        staffId: "staff_alisher",
        slotTime,
        config: DEFAULT_QUICKBOOK_CONFIG,
      });
    });

    const results = await Promise.all(promises);

    const successes = results.filter((r) => r.success);
    const conflicts = results.filter((r) => !r.success && r.error === "SLOT_TAKEN");

    // Exactly 1 booking succeeds
    expect(successes).toHaveLength(1);
    // Exactly 49 bookings get conflict and alternative slots
    expect(conflicts).toHaveLength(49);

    // Each conflict returned alternative slots
    for (const conflict of conflicts) {
      if (!conflict.success && conflict.error === "SLOT_TAKEN") {
        expect(conflict.alternativeSlots.length).toBeGreaterThan(0);
      }
    }

    // Verify database has exactly 1 booking for this slot
    const countInDb = await prisma.booking.count({
      where: {
        botId,
        staffId: "staff_alisher",
        slotTime,
        status: { in: ["PENDING", "CONFIRMED"] },
      },
    });
    expect(countInDb).toBe(1);
  });
});
