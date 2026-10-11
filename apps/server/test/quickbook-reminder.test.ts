import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectRedis, type Redis } from "../src/core/redis.js";
import { env } from "../src/core/env.js";
import { logger } from "../src/core/logger.js";
import { MockTelegramTransport } from "../src/adapters/telegram/mock-transport.js";
import { encryptSecret, sha256Hex } from "../src/core/crypto.js";
import { runBookingReminderWorker } from "../src/workers/booking-reminder-worker.js";
import { REMINDER_ZSET_KEY } from "../src/bots/quickbook/booking-service.js";
import {
  getTestPrismaClient,
  createTestRedisClient,
  safeCleanTestDb,
  safeCleanTestRedis,
} from "./helpers/test-env.js";

const prisma = getTestPrismaClient();

let redis: Redis;
let transport: MockTelegramTransport;

describe("QuickBook Booking Reminder Worker Tests", () => {
  let botId: string;
  const customerTgId = 888777;

  beforeAll(async () => {
    await prisma.$connect();
    redis = createTestRedisClient("test-reminder");
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
      data: { clientName: "Reminder Tenant", contactPhone: "+998901234567" },
    });

    const botToken = "123456789:ReminderBotToken";
    const bot = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "QUICKBOOK",
        botTokenEnc: encryptSecret(botToken, env.TOKEN_ENCRYPTION_KEY),
        botTokenHash: sha256Hex(botToken),
        webhookSecret: "secret_remind",
        adminInviteCode: "remind_invite",
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

  it("should send reminder at exactly slot - 2h, exactly once, and not for cancelled bookings", async () => {
    // Booking at 14:00 (slotTime = 2026-10-15T09:00:00Z in UTC, which is 14:00 in Tashkent)
    const slotTime = new Date("2026-10-15T09:00:00.000Z");
    // Reminder time is 12:00 (slot - 2h = 2026-10-15T07:00:00Z)
    const reminderTime = new Date("2026-10-15T07:00:00.000Z");

    const booking = await prisma.booking.create({
      data: {
        botId,
        customerTgId: BigInt(customerTgId),
        customerName: "Иван",
        customerPhone: "+998901234567",
        serviceId: "srv_haircut",
        serviceName: "Мужская стрижка",
        staffId: "staff_alisher",
        durationMin: 45,
        slotTime,
        status: "CONFIRMED",
        reminderSent: false,
      },
    });

    // Schedule in Redis ZSET
    await redis.zadd(REMINDER_ZSET_KEY, reminderTime.getTime(), booking.id);

    // 1. Run worker at 11:59 (before reminder time)
    const beforeResult = await runBookingReminderWorker({
      prisma,
      redis,
      transport,
      logger,
      now: new Date("2026-10-15T06:59:00.000Z"),
    });

    expect(beforeResult.sentCount).toBe(0);
    expect(transport.callsOf("sendMessage")).toHaveLength(0);

    const bookingBefore = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(bookingBefore?.reminderSent).toBe(false);

    // 2. Run worker at 12:00 (exactly at reminder time)
    const atResult = await runBookingReminderWorker({
      prisma,
      redis,
      transport,
      logger,
      now: new Date("2026-10-15T07:00:00.000Z"),
    });

    expect(atResult.sentCount).toBe(1);
    const messages = transport.callsOf("sendMessage");
    expect(messages).toHaveLength(1);
    const msgText = String(messages[0]?.payload.text);
    expect(msgText).toContain("Напоминание о записи");
    expect(msgText).toContain("Мужская стрижка");

    const bookingAfter = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(bookingAfter?.reminderSent).toBe(true);

    // 3. Run worker again at 12:05 -> must not send duplicate!
    transport.clear();
    const afterResult = await runBookingReminderWorker({
      prisma,
      redis,
      transport,
      logger,
      now: new Date("2026-10-15T07:05:00.000Z"),
    });

    expect(afterResult.sentCount).toBe(0);
    expect(transport.callsOf("sendMessage")).toHaveLength(0);

    // 4. Cancelled booking test: create another booking and cancel it
    const cancelledBooking = await prisma.booking.create({
      data: {
        botId,
        customerTgId: BigInt(customerTgId),
        customerName: "Петр",
        customerPhone: "+998909876543",
        serviceId: "srv_beard",
        serviceName: "Стрижка бороды",
        staffId: "staff_jasur",
        durationMin: 30,
        slotTime,
        status: "CANCELLED", // Already cancelled!
        reminderSent: false,
      },
    });

    await redis.zadd(REMINDER_ZSET_KEY, reminderTime.getTime(), cancelledBooking.id);

    const cancelledRun = await runBookingReminderWorker({
      prisma,
      redis,
      transport,
      logger,
      now: new Date("2026-10-15T07:10:00.000Z"),
    });

    // Should NOT send to cancelled booking
    expect(cancelledRun.sentCount).toBe(0);
    expect(transport.callsOf("sendMessage")).toHaveLength(0);
  });
});
