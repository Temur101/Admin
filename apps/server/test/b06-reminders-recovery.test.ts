import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Transformer } from "grammy";
import { connectRedis, type Redis } from "../src/core/redis.js";
import { env } from "../src/core/env.js";
import { logger } from "../src/core/logger.js";
import { MockTelegramTransport } from "../src/adapters/telegram/mock-transport.js";
import { encryptSecret, sha256Hex } from "../src/core/crypto.js";
import { runBookingReminderWorker } from "../src/workers/booking-reminder-worker.js";
import {
  REMINDER_ZSET_KEY,
  cancelBooking,
} from "../src/bots/quickbook/booking-service.js";
import {
  getTestPrismaClient,
  createTestRedisClient,
  safeCleanTestDb,
  safeCleanTestRedis,
} from "./helpers/test-env.js";

class TestableTelegramTransport extends MockTelegramTransport {
  public failSendMessageError: Error | null = null;

  override transformerFor(botId: string): Transformer {
    const baseTransformer = super.transformerFor(botId);
    return async (prev, method, payload, signal) => {
      if (method === "sendMessage" && this.failSendMessageError) {
        throw this.failSendMessageError;
      }
      return baseTransformer(prev, method, payload, signal);
    };
  }
}

const prisma = getTestPrismaClient();

let redis: Redis;
let transport: TestableTelegramTransport;

describe("B06: Resilient Booking Reminders & Recovery", () => {
  let botId: string;
  const customerTgId = 998877;

  beforeAll(async () => {
    await prisma.$connect();
    redis = createTestRedisClient("test-b06-reminders");
    await connectRedis(redis);
    transport = new TestableTelegramTransport();
  });

  afterAll(async () => {
    if (redis && redis.status !== "end") {
      await redis.quit();
    }
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    transport.clear();
    transport.failSendMessageError = null;
    await safeCleanTestRedis(redis);
    await safeCleanTestDb(prisma);

    const tenant = await prisma.tenant.create({
      data: { clientName: "Tenant B06", contactPhone: "+998901234567" },
    });

    const botToken = "123456789:B06ReminderBotToken";
    const bot = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "QUICKBOOK",
        botTokenEnc: encryptSecret(botToken, env.TOKEN_ENCRYPTION_KEY),
        botTokenHash: sha256Hex(botToken),
        webhookSecret: "secret_b06_remind",
        adminInviteCode: "b06_invite",
        subscription: {
          create: {
            status: "TRIAL",
            trialEndsAt: new Date(Date.now() + 86400000 * 7),
          },
        },
      },
    });
    botId = bot.id;

    await prisma.botUser.create({
      data: {
        botId,
        tgId: BigInt(customerTgId),
        firstName: "Клиент",
        lang: "RU",
      },
    });
  });

  it("Telegram failure: backs off and retries, eventually marking success only after delivery", async () => {
    const slotTime = new Date("2026-10-20T10:00:00.000Z");
    const reminderTime = new Date("2026-10-20T08:00:00.000Z");

    const booking = await prisma.booking.create({
      data: {
        botId,
        customerTgId: BigInt(customerTgId),
        customerName: "Алишер",
        customerPhone: "+998901112233",
        serviceId: "srv_haircut",
        serviceName: "Мужская стрижка",
        staffId: "staff_1",
        durationMin: 45,
        slotTime,
        status: "CONFIRMED",
        reminderSent: false,
      },
    });

    await redis.zadd(REMINDER_ZSET_KEY, reminderTime.getTime(), booking.id);

    // 1. Simulate external Telegram error (network drop / 502)
    transport.failSendMessageError = new Error("Telegram API Error: 502 Bad Gateway");

    // Run worker at 08:00
    const failRun = await runBookingReminderWorker({
      prisma,
      redis,
      transport,
      logger,
      now: reminderTime,
      backoffMs: 10_000, // 10s backoff for test
    });

    expect(failRun.sentCount).toBe(0);
    expect(failRun.failedCount).toBe(1);

    // Verify booking in DB: reminderSent is STILL FALSE, attempts incremented to 1
    const bookingAfterFail = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(bookingAfterFail.reminderSent).toBe(false);
    expect(bookingAfterFail.reminderAttempts).toBe(1);
    expect(bookingAfterFail.reminderLastError).toContain("Telegram API Error: 502 Bad Gateway");
    expect(bookingAfterFail.reminderLockedUntil).not.toBeNull();
    const lockedUntil = bookingAfterFail.reminderLockedUntil!.getTime();
    expect(lockedUntil).toBe(reminderTime.getTime() + 10_000);

    // 2. Run during backoff period (08:00:05) -> should NOT retry yet
    const midRun = await runBookingReminderWorker({
      prisma,
      redis,
      transport,
      logger,
      now: new Date(reminderTime.getTime() + 5_000),
      backoffMs: 10_000,
    });
    expect(midRun.sentCount).toBe(0);
    expect(midRun.failedCount).toBe(0);

    // 3. Fix Telegram connection and advance time past backoff (08:00:15)
    transport.failSendMessageError = null;
    const retryRun = await runBookingReminderWorker({
      prisma,
      redis,
      transport,
      logger,
      now: new Date(reminderTime.getTime() + 15_000),
      backoffMs: 10_000,
    });

    expect(retryRun.sentCount).toBe(1);
    expect(retryRun.failedCount).toBe(0);

    // Verify DB updated to success strictly after Telegram accepted message
    const bookingFinal = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(bookingFinal.reminderSent).toBe(true);
    expect(bookingFinal.reminderLastError).toBeNull();
    expect(bookingFinal.reminderLockedUntil).toBeNull();

    // Verify Redis score removed
    const inRedis = await redis.zscore(REMINDER_ZSET_KEY, booking.id);
    expect(inRedis).toBeNull();
  });

  it("Dead-letter handling: exhausts max attempts and stops retrying with observable dead-letter log", async () => {
    const slotTime = new Date("2026-10-21T10:00:00.000Z");
    const reminderTime = new Date("2026-10-21T08:00:00.000Z");

    const booking = await prisma.booking.create({
      data: {
        botId,
        customerTgId: BigInt(customerTgId),
        customerName: "Тест Превышения",
        customerPhone: "+998901112233",
        serviceId: "srv_haircut",
        serviceName: "Мужская стрижка",
        staffId: "staff_1",
        durationMin: 30,
        slotTime,
        status: "CONFIRMED",
        reminderSent: false,
      },
    });

    await redis.zadd(REMINDER_ZSET_KEY, reminderTime.getTime(), booking.id);

    // Always fail
    transport.failSendMessageError = new Error("Chat not found / Bot blocked");

    // Attempt 1 (now = 08:00:00)
    await runBookingReminderWorker({
      prisma,
      redis,
      transport,
      logger,
      now: reminderTime,
      maxAttempts: 3,
      backoffMs: 5_000,
    });
    let b = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(b.reminderAttempts).toBe(1);
    expect(b.reminderSent).toBe(false);

    // Attempt 2 (now = 08:00:10)
    await runBookingReminderWorker({
      prisma,
      redis,
      transport,
      logger,
      now: new Date(reminderTime.getTime() + 10_000),
      maxAttempts: 3,
      backoffMs: 5_000,
    });
    b = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(b.reminderAttempts).toBe(2);
    expect(b.reminderSent).toBe(false);

    // Attempt 3 (now = 08:00:20) -> should reach maxAttempts and enter dead-letter
    const finalAttempt = await runBookingReminderWorker({
      prisma,
      redis,
      transport,
      logger,
      now: new Date(reminderTime.getTime() + 20_000),
      maxAttempts: 3,
      backoffMs: 5_000,
    });
    expect(finalAttempt.failedCount).toBe(1);

    b = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(b.reminderAttempts).toBe(3);
    expect(b.reminderSent).toBe(false);
    expect(b.reminderLockedUntil).toBeNull();
    expect(b.reminderLastError).toContain("DEAD_LETTER");

    // Attempt 4 (now = 08:00:30) -> should NOT be picked up anymore
    const deadRun = await runBookingReminderWorker({
      prisma,
      redis,
      transport,
      logger,
      now: new Date(reminderTime.getTime() + 30_000),
      maxAttempts: 3,
      backoffMs: 5_000,
    });
    expect(deadRun.sentCount).toBe(0);
    expect(deadRun.failedCount).toBe(0);
  });

  it("Recovery from DB when Redis was down during booking creation", async () => {
    const slotTime = new Date("2026-10-22T14:00:00.000Z");
    const reminderTime = new Date("2026-10-22T13:00:00.000Z");

    // Booking created in DB, but Redis NEVER had this booking scheduled (simulating Redis crash during booking)
    const booking = await prisma.booking.create({
      data: {
        botId,
        customerTgId: BigInt(customerTgId),
        customerName: "Рекавери Пользователь",
        customerPhone: "+998909998877",
        serviceId: "srv_consultation",
        serviceName: "Консультация",
        staffId: "staff_doctor",
        durationMin: 60,
        slotTime,
        status: "CONFIRMED",
        reminderSent: false,
      },
    });

    // Ensure Redis ZSET is completely empty
    await redis.del(REMINDER_ZSET_KEY);
    const countInRedis = await redis.zcard(REMINDER_ZSET_KEY);
    expect(countInRedis).toBe(0);

    // Run worker at reminder time
    const result = await runBookingReminderWorker({
      prisma,
      redis,
      transport,
      logger,
      now: reminderTime,
      enableRecoveryFromDb: true,
    });

    expect(result.sentCount).toBe(1);
    const messages = transport.callsOf("sendMessage");
    expect(messages).toHaveLength(1);
    expect(String(messages[0]?.payload.text)).toContain("Консультация");

    // Verify DB marked sent
    const updated = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(updated.reminderSent).toBe(true);
  });

  it("Cancelled booking: does not send reminder if cancelled before worker execution", async () => {
    const slotTime = new Date("2026-10-23T14:00:00.000Z");
    const reminderTime = new Date("2026-10-23T12:00:00.000Z");

    const booking = await prisma.booking.create({
      data: {
        botId,
        customerTgId: BigInt(customerTgId),
        customerName: "Отмененная Бронь",
        customerPhone: "+998909998877",
        serviceId: "srv_consultation",
        serviceName: "Консультация",
        staffId: "staff_doctor",
        durationMin: 60,
        slotTime,
        status: "CONFIRMED",
        reminderSent: false,
      },
    });

    // Scheduled in Redis ZSET
    await redis.zadd(REMINDER_ZSET_KEY, reminderTime.getTime(), booking.id);

    // Customer cancels booking
    await cancelBooking(prisma, redis, {
      bookingId: booking.id,
      botId,
      userId: customerTgId,
    });

    // Run worker at reminder time
    const result = await runBookingReminderWorker({
      prisma,
      redis,
      transport,
      logger,
      now: reminderTime,
    });

    expect(result.sentCount).toBe(0);
    expect(transport.callsOf("sendMessage")).toHaveLength(0);
  });

  it("Concurrent workers: two workers do not send duplicate reminders (atomic row-level lease)", async () => {
    const slotTime = new Date("2026-10-24T10:00:00.000Z");
    const reminderTime = new Date("2026-10-24T08:00:00.000Z");

    const booking = await prisma.booking.create({
      data: {
        botId,
        customerTgId: BigInt(customerTgId),
        customerName: "Конкурентный Тест",
        customerPhone: "+998901239988",
        serviceId: "srv_haircut",
        serviceName: "Стрижка",
        staffId: "staff_1",
        durationMin: 30,
        slotTime,
        status: "CONFIRMED",
        reminderSent: false,
      },
    });

    await redis.zadd(REMINDER_ZSET_KEY, reminderTime.getTime(), booking.id);

    // Run two workers simultaneously
    const [w1, w2] = await Promise.all([
      runBookingReminderWorker({
        prisma,
        redis,
        transport,
        logger,
        now: reminderTime,
      }),
      runBookingReminderWorker({
        prisma,
        redis,
        transport,
        logger,
        now: reminderTime,
      }),
    ]);

    // One worker sends it, the other sees lock or claim count 0
    expect(w1.sentCount + w2.sentCount).toBe(1);
    expect(transport.callsOf("sendMessage")).toHaveLength(1);

    const b = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(b.reminderSent).toBe(true);
    expect(b.reminderAttempts).toBe(1);
  });

  it("Lease expiration & crash recovery: expired lease allows subsequent worker to recover task", async () => {
    const slotTime = new Date("2026-10-25T10:00:00.000Z");
    const reminderTime = new Date("2026-10-25T08:00:00.000Z");

    // Simulate worker 1 claimed lease with 2s TTL, but crashed before sending
    const booking = await prisma.booking.create({
      data: {
        botId,
        customerTgId: BigInt(customerTgId),
        customerName: "Упавший Воркер",
        customerPhone: "+998901239988",
        serviceId: "srv_haircut",
        serviceName: "Стрижка",
        staffId: "staff_1",
        durationMin: 30,
        slotTime,
        status: "CONFIRMED",
        reminderSent: false,
        reminderAttempts: 1,
        reminderLockedUntil: new Date(reminderTime.getTime() + 2_000), // lease locked for 2s
      },
    });

    await redis.zadd(REMINDER_ZSET_KEY, reminderTime.getTime(), booking.id);

    // Worker 2 runs at 08:00:01 (while lease is active) -> cannot claim
    const activeRun = await runBookingReminderWorker({
      prisma,
      redis,
      transport,
      logger,
      now: new Date(reminderTime.getTime() + 1_000),
    });
    expect(activeRun.sentCount).toBe(0);
    expect(transport.callsOf("sendMessage")).toHaveLength(0);

    // Worker 2 runs at 08:00:03 (after lease expired) -> claims and completes!
    const recoveredRun = await runBookingReminderWorker({
      prisma,
      redis,
      transport,
      logger,
      now: new Date(reminderTime.getTime() + 3_000),
    });
    expect(recoveredRun.sentCount).toBe(1);
    expect(transport.callsOf("sendMessage")).toHaveLength(1);

    const b = await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } });
    expect(b.reminderSent).toBe(true);
    expect(b.reminderLockedUntil).toBeNull();
  });

  it("Downtime recovery: skips and marks expired for tasks whose appointment slot has already passed", async () => {
    const slotTime = new Date("2026-10-26T08:00:00.000Z"); // Slot was at 08:00
    // Server was down for hours, restarts at 11:00 (now > slotTime)
    const nowAfterSlot = new Date("2026-10-26T11:00:00.000Z");

    const overdueBooking = await prisma.booking.create({
      data: {
        botId,
        customerTgId: BigInt(customerTgId),
        customerName: "Просроченная Бронь",
        customerPhone: "+998901239988",
        serviceId: "srv_haircut",
        serviceName: "Стрижка",
        staffId: "staff_1",
        durationMin: 30,
        slotTime,
        status: "CONFIRMED",
        reminderSent: false,
      },
    });

    await redis.zadd(REMINDER_ZSET_KEY, slotTime.getTime() - 2 * 3600 * 1000, overdueBooking.id);

    const result = await runBookingReminderWorker({
      prisma,
      redis,
      transport,
      logger,
      now: nowAfterSlot,
    });

    // Should NOT send message to avoid spamming user for past appointment
    expect(result.sentCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(transport.callsOf("sendMessage")).toHaveLength(0);

    // Should mark reminderSent: true with EXPIRED_PAST_SLOT
    const b = await prisma.booking.findUniqueOrThrow({ where: { id: overdueBooking.id } });
    expect(b.reminderSent).toBe(true);
    expect(b.reminderLastError).toBe("EXPIRED_PAST_SLOT");
  });
});
