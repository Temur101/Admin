import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectRedis, type Redis } from "../src/core/redis.js";
import { env } from "../src/core/env.js";
import { logger } from "../src/core/logger.js";
import { MockTelegramTransport } from "../src/adapters/telegram/mock-transport.js";
import { encryptSecret, sha256Hex } from "../src/core/crypto.js";
import {
  createBooking,
  cancelBooking,
} from "../src/bots/quickbook/booking-service.js";
import {
  acquireSlotLock,
  releaseSlotLock,
  isSlotLocked,
} from "../src/bots/quickbook/slot-lock.js";
import {
  getTestPrismaClient,
  createTestRedisClient,
  safeCleanTestDb,
  safeCleanTestRedis,
} from "./helpers/test-env.js";
import type { QuickBookConfig } from "@lcqb/contracts";

const prisma = getTestPrismaClient();

let redis: Redis;
let transport: MockTelegramTransport;

describe("B04: Overlapping Bookings Prevention", () => {
  let botId: string;
  let botTokenHash: string;
  let tenantId: string;

  // Custom QuickBook config with a 60-min service, 30-min service, and defined break hours
  const customConfig: QuickBookConfig = {
    resourceType: "STAFF",
    services: [
      {
        id: "srv_standard_30",
        name: { ru: "Стрижка (30 мин)", uz: "Soch turmagi (30 daqiqa)" },
        durationMin: 30,
        priceUzs: 50000,
      },
      {
        id: "srv_long_60",
        name: { ru: "Комплекс (60 мин)", uz: "Kompleks (60 daqiqa)" },
        durationMin: 60,
        priceUzs: 100000,
      },
      {
        id: "srv_special",
        name: { ru: "Спецуслуга", uz: "Maxsus xizmat" },
        durationMin: 45,
        priceUzs: 80000,
      },
    ],
    resources: [
      {
        id: "staff_primary",
        name: { ru: "Мастер Алишер", uz: "Usta Alisher" },
        serviceIds: ["srv_standard_30", "srv_long_60"], // does NOT support srv_special
        workDays: [1, 2, 3, 4, 5], // Mon-Fri
        workHours: { start: "09:00", end: "18:00" },
        breakHours: { start: "13:00", end: "14:00" }, // Break 13:00-14:00
      },
      {
        id: "staff_secondary",
        name: { ru: "Мастер Бобир", uz: "Usta Bobir" },
        serviceIds: ["srv_standard_30", "srv_long_60", "srv_special"],
        workDays: [1, 2, 3, 4, 5, 6],
        workHours: { start: "10:00", end: "20:00" },
      },
    ],
    slotIntervalMin: 30,
    bookingHorizonDays: 14,
    timezone: "Asia/Tashkent",
  };

  // Fixed reference base date: Tuesday 2026-10-20 (a working day, UTC+5)
  // 10:00 Tashkent = 05:00 UTC
  const slot_10_00_Utc = new Date(Date.UTC(2026, 9, 20, 5, 0, 0)); // 10:00 Tashkent
  const slot_10_30_Utc = new Date(Date.UTC(2026, 9, 20, 5, 30, 0)); // 10:30 Tashkent
  const slot_11_00_Utc = new Date(Date.UTC(2026, 9, 20, 6, 0, 0)); // 11:00 Tashkent
  const slot_11_30_Utc = new Date(Date.UTC(2026, 9, 20, 6, 30, 0)); // 11:30 Tashkent

  // Simulated "now": 2026-10-20 08:00 Tashkent (03:00 UTC)
  const simulatedNow = new Date(Date.UTC(2026, 9, 20, 3, 0, 0));

  beforeAll(async () => {
    await prisma.$connect();
    redis = createTestRedisClient("test-b04");
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
      data: { clientName: "B04 Tenant", contactPhone: "+998901112233" },
    });
    tenantId = tenant.id;

    const botToken = "123456789:B04TestBotToken";
    botTokenHash = sha256Hex(botToken);
    const bot = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "QUICKBOOK",
        botTokenEnc: encryptSecret(botToken, env.TOKEN_ENCRYPTION_KEY),
        botTokenHash,
        webhookSecret: "secret_b04",
        adminInviteCode: "b04_invite",
        settings: { quickbook: customConfig },
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

  it("1. should handle 50 concurrent requests for the exact same slot: exactly 1 wins, 49 get alternative slots", async () => {
    const concurrency = 50;

    const promises = Array.from({ length: concurrency }, (_, i) => {
      const pad = String(i).padStart(2, "0");
      return createBooking({
        prisma,
        redis,
        transport,
        logger,
        botId,
        customerTgId: 70000 + i,
        customerName: `Client ${i}`,
        customerPhone: `+9989011122${pad}`,
        serviceId: "srv_standard_30",
        staffId: "staff_primary",
        slotTime: slot_10_00_Utc,
        config: customConfig,
        now: simulatedNow,
      });
    });

    const results = await Promise.all(promises);

    const successes = results.filter((r) => r.success);
    const conflicts = results.filter((r) => !r.success && r.error === "SLOT_TAKEN");

    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(49);

    for (const conflict of conflicts) {
      if (!conflict.success && conflict.error === "SLOT_TAKEN") {
        expect(conflict.alternativeSlots.length).toBeGreaterThan(0);
      }
    }

    // Exactly 1 booking in database
    const dbBookings = await prisma.booking.findMany({
      where: { botId, staffId: "staff_primary", status: "CONFIRMED" },
    });
    expect(dbBookings).toHaveLength(1);
    expect(dbBookings[0]!.slotTime.getTime()).toBe(slot_10_00_Utc.getTime());
  });

  it("2. should reject parallel overlapping intervals (10:00-11:00 vs 10:30-11:00): exactly 1 wins, no overlap created", async () => {
    // Attempt A: 10:00 to 11:00 (duration: 60 min, covers [10:00, 11:00))
    const attemptA = createBooking({
      prisma,
      redis,
      transport,
      logger,
      botId,
      customerTgId: 71001,
      customerName: "Client 60min",
      customerPhone: "+998901113301",
      serviceId: "srv_long_60", // 60 min
      staffId: "staff_primary",
      slotTime: slot_10_00_Utc,
      config: customConfig,
      now: simulatedNow,
    });

    // Attempt B: 10:30 to 11:00 (duration: 30 min, covers [10:30, 11:00)) -> OVERLAPS with Attempt A!
    const attemptB = createBooking({
      prisma,
      redis,
      transport,
      logger,
      botId,
      customerTgId: 71002,
      customerName: "Client 30min",
      customerPhone: "+998901113302",
      serviceId: "srv_standard_30", // 30 min
      staffId: "staff_primary",
      slotTime: slot_10_30_Utc,
      config: customConfig,
      now: simulatedNow,
    });

    const [resA, resB] = await Promise.all([attemptA, attemptB]);

    const successes = [resA, resB].filter((r) => r.success);
    const failures = [resA, resB].filter((r) => !r.success);

    // Exactly one must succeed, the other must be rejected due to overlap conflict
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect((failures[0] as { error: string }).error).toBe("SLOT_TAKEN");

    // Check database has strictly 1 confirmed booking
    const activeBookings = await prisma.booking.findMany({
      where: { botId, staffId: "staff_primary", status: "CONFIRMED" },
    });
    expect(activeBookings).toHaveLength(1);
  });

  it("3. should allow adjacent non-overlapping intervals (10:00-11:00 and 11:00-12:00) for same staff", async () => {
    // Booking 1: 10:00 to 11:00 (60 min)
    const res1 = await createBooking({
      prisma,
      redis,
      transport,
      logger,
      botId,
      customerTgId: 72001,
      customerName: "Client 1",
      customerPhone: "+998901114401",
      serviceId: "srv_long_60",
      staffId: "staff_primary",
      slotTime: slot_10_00_Utc,
      config: customConfig,
      now: simulatedNow,
    });
    expect(res1.success).toBe(true);

    // Booking 2: 11:00 to 12:00 (60 min) -> touches boundary at 11:00, does NOT overlap
    const res2 = await createBooking({
      prisma,
      redis,
      transport,
      logger,
      botId,
      customerTgId: 72002,
      customerName: "Client 2",
      customerPhone: "+998901114402",
      serviceId: "srv_long_60",
      staffId: "staff_primary",
      slotTime: slot_11_00_Utc,
      config: customConfig,
      now: simulatedNow,
    });
    expect(res2.success).toBe(true);

    const bookings = await prisma.booking.findMany({
      where: { botId, staffId: "staff_primary", status: "CONFIRMED" },
      orderBy: { slotTime: "asc" },
    });
    expect(bookings).toHaveLength(2);
    expect(bookings[0]!.slotTime.getTime()).toBe(slot_10_00_Utc.getTime());
    expect(bookings[1]!.slotTime.getTime()).toBe(slot_11_00_Utc.getTime());
  });

  it("4. should allow identical timeslots across different resources and different bots", async () => {
    // 1. Same bot, different staff: Staff Secondary
    const resStaff2 = await createBooking({
      prisma,
      redis,
      transport,
      logger,
      botId,
      customerTgId: 73001,
      customerName: "Client Staff2",
      customerPhone: "+998901115501",
      serviceId: "srv_long_60",
      staffId: "staff_secondary",
      slotTime: slot_10_00_Utc,
      config: customConfig,
      now: simulatedNow,
    });
    expect(resStaff2.success).toBe(true);

    // 2. Same bot, Staff Primary at 10:00
    const resStaff1 = await createBooking({
      prisma,
      redis,
      transport,
      logger,
      botId,
      customerTgId: 73002,
      customerName: "Client Staff1",
      customerPhone: "+998901115502",
      serviceId: "srv_long_60",
      staffId: "staff_primary",
      slotTime: slot_10_00_Utc,
      config: customConfig,
      now: simulatedNow,
    });
    expect(resStaff1.success).toBe(true);

    // 3. Different bot on same tenant: at 10:00 for staff_primary
    const botToken2 = "987654321:OtherBotToken";
    const otherBot = await prisma.bot.create({
      data: {
        tenantId,
        botType: "QUICKBOOK",
        botTokenEnc: encryptSecret(botToken2, env.TOKEN_ENCRYPTION_KEY),
        botTokenHash: sha256Hex(botToken2),
        webhookSecret: "secret_other",
        adminInviteCode: "other_invite",
      },
    });

    const resOtherBot = await createBooking({
      prisma,
      redis,
      transport,
      logger,
      botId: otherBot.id,
      customerTgId: 73003,
      customerName: "Client OtherBot",
      customerPhone: "+998901115503",
      serviceId: "srv_long_60",
      staffId: "staff_primary",
      slotTime: slot_10_00_Utc,
      config: customConfig,
      now: simulatedNow,
    });
    expect(resOtherBot.success).toBe(true);
  });

  it("5. should allow re-booking a slot if previous booking was CANCELLED", async () => {
    // 1. Initial booking 10:00-11:00
    const bookingRes = await createBooking({
      prisma,
      redis,
      transport,
      logger,
      botId,
      customerTgId: 74001,
      customerName: "Client Cancel",
      customerPhone: "+998901116601",
      serviceId: "srv_long_60",
      staffId: "staff_primary",
      slotTime: slot_10_00_Utc,
      config: customConfig,
      now: simulatedNow,
    });
    expect(bookingRes.success).toBe(true);
    if (!bookingRes.success) return;

    // 2. Cancel the booking
    const cancelRes = await cancelBooking(prisma, redis, {
      bookingId: bookingRes.booking.id,
      botId,
      userId: 74001,
    });
    expect(cancelRes.success).toBe(true);

    // 3. New booking overlapping 10:30-11:00 for the same staff must SUCCEED!
    const rebookRes = await createBooking({
      prisma,
      redis,
      transport,
      logger,
      botId,
      customerTgId: 74002,
      customerName: "Client Rebook",
      customerPhone: "+998901116602",
      serviceId: "srv_standard_30",
      staffId: "staff_primary",
      slotTime: slot_10_30_Utc,
      config: customConfig,
      now: simulatedNow,
    });
    expect(rebookRes.success).toBe(true);

    // Confirm DB status
    const allBookings = await prisma.booking.findMany({
      where: { botId, staffId: "staff_primary" },
      orderBy: { slotTime: "asc" },
    });
    expect(allBookings).toHaveLength(2);
    expect(allBookings.find((b) => b.id === bookingRes.booking.id)?.status).toBe("CANCELLED");
    expect(allBookings.find((b) => b.id !== bookingRes.booking.id)?.status).toBe("CONFIRMED");
  });

  it("6. should reject invalid/outdated slot requests with appropriate errors and alternative slots", async () => {
    // A. Past Date: requested slot is before simulatedNow
    const pastSlot = new Date(simulatedNow.getTime() - 3600000); // 1 hr earlier
    const resPast = await createBooking({
      prisma,
      redis,
      transport,
      logger,
      botId,
      customerTgId: 75001,
      customerPhone: "+998901117701",
      serviceId: "srv_standard_30",
      staffId: "staff_primary",
      slotTime: pastSlot,
      config: customConfig,
      now: simulatedNow,
    });
    expect(resPast.success).toBe(false);
    if (!resPast.success && "alternativeSlots" in resPast) {
      expect(resPast.error).toBe("SLOT_IN_PAST");
      expect(resPast.alternativeSlots.length).toBeGreaterThan(0);
    }

    // B. Break Hours: 13:00 to 14:00 is lunch break for staff_primary
    // 13:00 Tashkent = 08:00 UTC
    const breakSlot = new Date(Date.UTC(2026, 9, 20, 8, 0, 0));
    const resBreak = await createBooking({
      prisma,
      redis,
      transport,
      logger,
      botId,
      customerTgId: 75002,
      customerPhone: "+998901117702",
      serviceId: "srv_standard_30",
      staffId: "staff_primary",
      slotTime: breakSlot,
      config: customConfig,
      now: simulatedNow,
    });
    expect(resBreak.success).toBe(false);
    if (!resBreak.success && "alternativeSlots" in resBreak) {
      expect(resBreak.error).toBe("SLOT_IN_BREAK");
      expect(resBreak.alternativeSlots.length).toBeGreaterThan(0);
    }

    // C. Outside Schedule: Saturday for staff_primary (only works Mon-Fri)
    // 2026-10-24 is Saturday
    const satSlot = new Date(Date.UTC(2026, 9, 24, 5, 0, 0));
    const resSat = await createBooking({
      prisma,
      redis,
      transport,
      logger,
      botId,
      customerTgId: 75003,
      customerPhone: "+998901117703",
      serviceId: "srv_standard_30",
      staffId: "staff_primary",
      slotTime: satSlot,
      config: customConfig,
      now: simulatedNow,
    });
    expect(resSat.success).toBe(false);
    if (!resSat.success) {
      expect(resSat.error).toBe("NOT_IN_SCHEDULE");
    }

    // D. Outside Booking Horizon: 20 days in advance (horizon = 14)
    const futureSlot = new Date(simulatedNow.getTime() + 20 * 86400000);
    const resHorizon = await createBooking({
      prisma,
      redis,
      transport,
      logger,
      botId,
      customerTgId: 75004,
      customerPhone: "+998901117704",
      serviceId: "srv_standard_30",
      staffId: "staff_primary",
      slotTime: futureSlot,
      config: customConfig,
      now: simulatedNow,
    });
    expect(resHorizon.success).toBe(false);
    if (!resHorizon.success) {
      expect(resHorizon.error).toBe("OUTSIDE_HORIZON");
    }

    // E. Incompatible service: staff_primary does NOT support srv_special
    const resIncompatible = await createBooking({
      prisma,
      redis,
      transport,
      logger,
      botId,
      customerTgId: 75005,
      customerPhone: "+998901117705",
      serviceId: "srv_special",
      staffId: "staff_primary",
      slotTime: slot_10_00_Utc,
      config: customConfig,
      now: simulatedNow,
    });
    expect(resIncompatible.success).toBe(false);
    if (!resIncompatible.success) {
      expect(resIncompatible.error).toBe("SERVICE_NOT_SUPPORTED");
    }
  });

  it("7. should prevent releasing a recaptured lock when old lock has expired (unique capture token)", async () => {
    const testSlot = slot_11_30_Utc;
    const userId = 76001;

    // 1. User acquires lock with short TTL (1 sec)
    const lock1 = await acquireSlotLock(redis, {
      botId,
      staffId: "staff_primary",
      slotTime: testSlot,
      userId,
      ttlSec: 1,
    });
    expect(lock1.acquired).toBe(true);
    expect(lock1.lockToken).toBeDefined();

    // 2. Wait 1.2s for lock 1 to expire in Redis
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Lock 1 has expired
    const expiredCheck = await isSlotLocked(redis, botId, "staff_primary", testSlot);
    expect(expiredCheck).toBe(false);

    // 3. User recaptures the lock (new capture token)
    const lock2 = await acquireSlotLock(redis, {
      botId,
      staffId: "staff_primary",
      slotTime: testSlot,
      userId,
      ttlSec: 10,
    });
    expect(lock2.acquired).toBe(true);
    expect(lock2.lockToken).not.toBe(lock1.lockToken);

    // 4. Stale callback from attempt 1 tries to release the lock using lock1.lockToken
    const staleRelease = await releaseSlotLock(redis, {
      botId,
      staffId: "staff_primary",
      slotTime: testSlot,
      userId,
      lockToken: lock1.lockToken,
    });

    // Stale release MUST fail because the active lock was captured with lock2 token!
    expect(staleRelease).toBe(false);

    // Slot MUST still remain locked by lock2!
    const stillLocked = await isSlotLocked(redis, botId, "staff_primary", testSlot);
    expect(stillLocked).toBe(true);

    // 5. Valid release with lock2.lockToken succeeds
    const validRelease = await releaseSlotLock(redis, {
      botId,
      staffId: "staff_primary",
      slotTime: testSlot,
      userId,
      lockToken: lock2.lockToken,
    });
    expect(validRelease).toBe(true);

    const finallyUnlocked = await isSlotLocked(redis, botId, "staff_primary", testSlot);
    expect(finallyUnlocked).toBe(false);
  });

  it("8. should enforce PostgreSQL GiST exclusion constraint on raw direct database inserts", async () => {
    // 1. Insert 10:00-11:00 directly into Booking table
    await prisma.booking.create({
      data: {
        botId,
        customerTgId: BigInt(77001),
        customerName: "Direct Client 1",
        customerPhone: "+998901118801",
        serviceId: "srv_long_60",
        serviceName: "Комплекс",
        staffId: "staff_primary",
        durationMin: 60,
        slotTime: slot_10_00_Utc,
        endTime: slot_11_00_Utc,
        status: "CONFIRMED",
      },
    });

    // 2. Attempting a direct insert of overlapping 10:30-11:30 must be rejected by PostgreSQL exclusion constraint
    await expect(
      prisma.booking.create({
        data: {
          botId,
          customerTgId: BigInt(77002),
          customerName: "Direct Client 2",
          customerPhone: "+998901118802",
          serviceId: "srv_long_60",
          serviceName: "Комплекс",
          staffId: "staff_primary",
          durationMin: 60,
          slotTime: slot_10_30_Utc,
          endTime: slot_11_30_Utc,
          status: "CONFIRMED",
        },
      }),
    ).rejects.toThrow();

    // 3. Attempting a direct insert of adjacent 11:00-12:00 must SUCCEED
    const adjacentBooking = await prisma.booking.create({
      data: {
        botId,
        customerTgId: BigInt(77003),
        customerName: "Direct Client 3",
        customerPhone: "+998901118803",
        serviceId: "srv_long_60",
        serviceName: "Комплекс",
        staffId: "staff_primary",
        durationMin: 60,
        slotTime: slot_11_00_Utc,
        endTime: new Date(slot_11_00_Utc.getTime() + 60 * 60000),
        status: "CONFIRMED",
      },
    });

    expect(adjacentBooking).toBeDefined();
    expect(adjacentBooking.id).toBeDefined();
  });
});
