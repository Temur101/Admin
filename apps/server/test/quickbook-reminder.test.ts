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
        settings: {
          resourceType: "STAFF",
          resourceLabel: { ru: "Мастер", uz: "Usta" },
          services: [
            {
              id: "srv_haircut",
              name: { ru: "Мужская стрижка (VIP)", uz: "Erkaklar soch turmagi (VIP)" },
              durationMin: 45,
              priceUzs: 120000,
            },
          ],
          resources: [
            {
              id: "staff_alisher",
              name: { ru: "Алишер (Топ-барбер)", uz: "Alisher (Top-barber)" },
              workDays: [1, 2, 3, 4, 5, 6],
              workHours: { start: "09:00", end: "20:00" },
            },
          ],
          slotIntervalMin: 30,
          bookingHorizonDays: 14,
          timezone: "Asia/Tashkent",
        },
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

  it("should send reminder at exactly slot - 1h, exactly once, and not for cancelled bookings", async () => {
    // Booking at 14:00 (slotTime = 2026-10-15T09:00:00Z in UTC, which is 14:00 in Tashkent)
    const slotTime = new Date("2026-10-15T09:00:00.000Z");
    // Reminder time is 13:00 (slot - 1h = 2026-10-15T08:00:00Z)
    const reminderTime = new Date("2026-10-15T08:00:00.000Z");

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

    // 1. Run worker at 12:59 (before reminder time)
    const beforeResult = await runBookingReminderWorker({
      prisma,
      redis,
      transport,
      logger,
      now: new Date("2026-10-15T07:59:00.000Z"),
    });

    expect(beforeResult.sentCount).toBe(0);
    expect(transport.callsOf("sendMessage")).toHaveLength(0);

    const bookingBefore = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(bookingBefore?.reminderSent).toBe(false);

    // 2. Run worker at 13:00 (exactly at reminder time)
    const atResult = await runBookingReminderWorker({
      prisma,
      redis,
      transport,
      logger,
      now: new Date("2026-10-15T08:00:00.000Z"),
    });

    expect(atResult.sentCount).toBe(1);
    const messages = transport.callsOf("sendMessage");
    expect(messages).toHaveLength(1);
    const msgText = String(messages[0]?.payload.text);
    expect(msgText).toContain("Напоминание о записи");
    expect(msgText).toContain("Мужская стрижка (VIP)");
    expect(msgText).toContain("Мастер: Алишер (Топ-барбер)");
    expect(msgText).not.toContain("staff_alisher");

    const bookingAfter = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(bookingAfter?.reminderSent).toBe(true);

    // 3. Run worker again at 13:05 -> must not send duplicate!
    transport.clear();
    const afterResult = await runBookingReminderWorker({
      prisma,
      redis,
      transport,
      logger,
      now: new Date("2026-10-15T08:05:00.000Z"),
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
      now: new Date("2026-10-15T08:10:00.000Z"),
    });

    // Should NOT send to cancelled booking
    expect(cancelledRun.sentCount).toBe(0);
    expect(transport.callsOf("sendMessage")).toHaveLength(0);
  });

  it("should format reminder in Uzbek (UZ) and safely fallback when staffId/serviceId is removed from settings", async () => {
    const slotTime = new Date("2026-10-15T09:00:00.000Z");
    const reminderTime = new Date("2026-10-15T08:00:00.000Z");

    await prisma.botUser.update({
      where: { botId_tgId: { botId, tgId: BigInt(customerTgId) } },
      data: { lang: "UZ" },
    });

    const uzBooking = await prisma.booking.create({
      data: {
        botId,
        customerTgId: BigInt(customerTgId),
        customerName: "Алишер",
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
    await redis.zadd(REMINDER_ZSET_KEY, reminderTime.getTime(), uzBooking.id);

    const uzResult = await runBookingReminderWorker({
      prisma,
      redis,
      transport,
      logger,
      now: reminderTime,
    });
    expect(uzResult.sentCount).toBe(1);
    const uzText = String(transport.callsOf("sendMessage")[0]?.payload.text);
    expect(uzText).toContain("Erkaklar soch turmagi (VIP)");
    expect(uzText).toContain("Usta: Alisher (Top-barber)");

    // Fallback when staffId and serviceId were removed from settings and resourceLabel is omitted
    transport.clear();
    await prisma.bot.update({
      where: { id: botId },
      data: {
        settings: {
          resourceType: "ROOM",
          services: [
            {
              id: "srv_active",
              name: { ru: "Аренда зала", uz: "Zal ijarasi" },
              durationMin: 60,
              priceUzs: 200000,
            },
          ],
          resources: [
            {
              id: "room_active",
              name: { ru: "Зал 1", uz: "1-zal" },
              workDays: [1, 2, 3, 4, 5],
              workHours: { start: "09:00", end: "18:00" },
            },
          ],
          slotIntervalMin: 30,
          bookingHorizonDays: 14,
          timezone: "Asia/Tashkent",
        },
      },
    });

    const fallbackBooking = await prisma.booking.create({
      data: {
        botId,
        customerTgId: BigInt(customerTgId),
        customerName: "Алишер",
        customerPhone: "+998901234567",
        serviceId: "srv_deleted",
        serviceName: "Архивная услуга",
        staffId: "room_vip_1",
        durationMin: 30,
        slotTime,
        status: "CONFIRMED",
        reminderSent: false,
      },
    });
    await redis.zadd(REMINDER_ZSET_KEY, reminderTime.getTime(), fallbackBooking.id);

    const fallbackResult = await runBookingReminderWorker({
      prisma,
      redis,
      transport,
      logger,
      now: reminderTime,
    });
    expect(fallbackResult.sentCount).toBe(1);
    const fbText = String(transport.callsOf("sendMessage")[0]?.payload.text);
    expect(fbText).toContain("Архивная услуга");
    expect(fbText).toContain("Xona: room_vip_1");
  });
});
