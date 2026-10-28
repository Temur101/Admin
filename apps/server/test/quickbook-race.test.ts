import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectRedis, type Redis } from "../src/core/redis.js";
import { env } from "../src/core/env.js";
import { logger } from "../src/core/logger.js";
import { MockTelegramTransport } from "../src/adapters/telegram/mock-transport.js";
import { encryptSecret, sha256Hex } from "../src/core/crypto.js";
import { QUICKBOOK_TEST_CONFIG } from "./helpers/quickbook-fixture.js";
import { createBooking } from "../src/bots/quickbook/booking-service.js";
import {
  getTestPrismaClient,
  createTestRedisClient,
  safeCleanTestDb,
  safeCleanTestRedis,
} from "./helpers/test-env.js";

const prisma = getTestPrismaClient();

let redis: Redis;
let transport: MockTelegramTransport;

describe("QuickBook Race Condition Test (50 Parallel Bookings)", () => {
  let botId: string;
  const slotTime = new Date("2026-10-20T10:00:00.000Z");

  beforeAll(async () => {
    await prisma.$connect();
    redis = createTestRedisClient("test-race");
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
      data: { clientName: "Race Tenant", contactPhone: "+998901112233" },
    });

    const botToken = "123456789:RaceTestBotToken";
    const bot = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "QUICKBOOK",
        botTokenEnc: encryptSecret(botToken, env.TOKEN_ENCRYPTION_KEY),
        botTokenHash: sha256Hex(botToken),
        webhookSecret: "secret_race",        subscription: {
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
        config: QUICKBOOK_TEST_CONFIG,
        now: new Date("2026-10-20T03:00:00.000Z"),
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
