import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectRedis, type Redis } from "../src/core/redis.js";
import { env } from "../src/core/env.js";
import { logger } from "../src/core/logger.js";
import { MockTelegramTransport } from "../src/adapters/telegram/mock-transport.js";
import { encryptSecret, sha256Hex } from "../src/core/crypto.js";
import { BotPool } from "../src/gateway/bot-pool.js";
import type { ResolvedBot } from "../src/gateway/types.js";
import {
  getTestPrismaClient,
  createTestRedisClient,
  safeCleanTestDb,
  safeCleanTestRedis,
} from "./helpers/test-env.js";

const prisma = getTestPrismaClient();

const ADMIN_ID = 999001;
const CLIENT_ID = 999002;
const STRANGER_ID = 999003;

describe("QuickBook Reminder Actions: Confirm & Cancel Admin Notifications", () => {
  let redis: Redis;
  let transport: MockTelegramTransport;
  let botPool: BotPool;
  let botId: string;
  let resolvedBot: ResolvedBot;

  beforeAll(async () => {
    await prisma.$connect();
    redis = createTestRedisClient("test-reminder-actions");
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
      data: { clientName: "Barbershop Tenant", contactPhone: "+998901112233" },
    });

    const botToken = "123456789:TestActionsBotToken";
    const botTokenEnc = encryptSecret(botToken, env.TOKEN_ENCRYPTION_KEY);
    const botTokenHash = sha256Hex(botToken);

    const botSettings = {
      resourceType: "STAFF",
      resourceLabel: { ru: "Барбер", uz: "Sartarosh" },
      services: [
        {
          id: "srv_fade",
          name: { ru: "Стрижка Фейд", uz: "Feyd soch turmagi" },
          durationMin: 45,
          priceUzs: 100000,
        },
      ],
      resources: [
        {
          id: "barber_timur",
          name: { ru: "Тимур (Барбер)", uz: "Temur (Sartarosh)" },
          workDays: [1, 2, 3, 4, 5, 6],
          workHours: { start: "10:00", end: "21:00" },
        },
      ],
      slotIntervalMin: 30,
      bookingHorizonDays: 14,
      timezone: "Asia/Tashkent",
    };

    const bot = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "QUICKBOOK",
        botTokenEnc,
        botTokenHash,
        webhookSecret: "secret_actions",
        settings: botSettings,
        subscription: {
          create: {
            status: "ACTIVE",
            trialEndsAt: new Date(Date.now() + 86400000 * 30),
          },
        },
      },
    });
    botId = bot.id;

    // Admin user (RU)
    await prisma.botUser.create({
      data: {
        botId,
        tgId: BigInt(ADMIN_ID),
        firstName: "Админ Барбершопа",
        isAdmin: true,
        lang: "RU",
      },
    });

    // Client user (RU)
    await prisma.botUser.create({
      data: {
        botId,
        tgId: BigInt(CLIENT_ID),
        firstName: "Клиент Артем",
        isAdmin: false,
        lang: "RU",
      },
    });

    resolvedBot = {
      id: bot.id,
      tenantId: tenant.id,
      botType: bot.botType,
      botTokenEnc,
      botTokenHash,
      webhookSecret: bot.webhookSecret,
      botUsername: "barber_actions_bot",
      settings: botSettings,
      subscriptionStatus: "ACTIVE",
      trialEndsAt: new Date(Date.now() + 86400000 * 30).toISOString(),
      paidUntil: null,
    };

    botPool = new BotPool({
      capacity: 10,
      encryptionKey: env.TOKEN_ENCRYPTION_KEY,
      transport,
      redis,
      sessionTtlSec: 3600,
      logger,
      prisma,
    });
  });

  it("1. Customer confirms appointment: replies to customer and notifies admin (idempotently)", async () => {
    const booking = await prisma.booking.create({
      data: {
        botId,
        customerTgId: BigInt(CLIENT_ID),
        customerName: "Артем",
        customerPhone: "+998901234567",
        serviceId: "srv_fade",
        serviceName: "Стрижка Фейд",
        staffId: "barber_timur",
        durationMin: 45,
        slotTime: new Date("2026-10-28T09:00:00.000Z"),
        status: "CONFIRMED",
      },
    });

    const grammyBot = botPool.getOrCreateBot(resolvedBot);

    // Customer clicks "Confirm"
    transport.clear();
    await grammyBot.handleUpdate({
      update_id: 1,
      callback_query: {
        id: "cb_confirm_1",
        from: { id: CLIENT_ID, is_bot: false, first_name: "Артем" },
        message: {
          message_id: 10,
          date: 1700000000,
          chat: { id: CLIENT_ID, type: "private", first_name: "Артем" },
          text: "Напоминание о записи",
        },
        chat_instance: "ci_1",
        data: `book:confirm:${booking.id}`,
      },
    });

    // Customer gets confirmation reply
    const clientMsgs = transport.callsOf("sendMessage").filter((c) => c.payload.chat_id === CLIENT_ID);
    expect(clientMsgs).toHaveLength(1);
    expect(String(clientMsgs[0]?.payload.text)).toContain("Спасибо за подтверждение");

    // Admin gets confirmation notification
    const adminMsgs = transport.callsOf("sendMessage").filter((c) => c.payload.chat_id === ADMIN_ID);
    expect(adminMsgs).toHaveLength(1);
    const adminText = String(adminMsgs[0]?.payload.text);
    expect(adminText).toContain("Клиент подтвердил запись");
    expect(adminText).toContain("Артем");
    expect(adminText).toContain("+998901234567");
    expect(adminText).toContain("Стрижка Фейд");
    expect(adminText).toContain("Тимур (Барбер)");

    // Repeated click by customer: customer still gets reply, but admin receives NO duplicate!
    transport.clear();
    await grammyBot.handleUpdate({
      update_id: 2,
      callback_query: {
        id: "cb_confirm_repeat",
        from: { id: CLIENT_ID, is_bot: false, first_name: "Артем" },
        message: {
          message_id: 10,
          date: 1700000000,
          chat: { id: CLIENT_ID, type: "private", first_name: "Артем" },
          text: "Напоминание о записи",
        },
        chat_instance: "ci_1",
        data: `book:confirm:${booking.id}`,
      },
    });

    const clientRepeat = transport.callsOf("sendMessage").filter((c) => c.payload.chat_id === CLIENT_ID);
    expect(clientRepeat).toHaveLength(1);
    const adminRepeat = transport.callsOf("sendMessage").filter((c) => c.payload.chat_id === ADMIN_ID);
    expect(adminRepeat).toHaveLength(0);
  });

  it("2. Customer cancels appointment: cancels slot and notifies admin", async () => {
    const booking = await prisma.booking.create({
      data: {
        botId,
        customerTgId: BigInt(CLIENT_ID),
        customerName: "Артем",
        customerPhone: "+998901234567",
        serviceId: "srv_fade",
        serviceName: "Стрижка Фейд",
        staffId: "barber_timur",
        durationMin: 45,
        slotTime: new Date("2026-10-28T09:00:00.000Z"),
        status: "CONFIRMED",
      },
    });

    const grammyBot = botPool.getOrCreateBot(resolvedBot);

    // Customer clicks "Cancel"
    transport.clear();
    await grammyBot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: "cb_cancel_1",
        from: { id: CLIENT_ID, is_bot: false, first_name: "Артем" },
        message: {
          message_id: 11,
          date: 1700000000,
          chat: { id: CLIENT_ID, type: "private", first_name: "Артем" },
          text: "Напоминание о записи",
        },
        chat_instance: "ci_2",
        data: `book:cancel:${booking.id}`,
      },
    });

    // Customer gets cancellation confirmation
    const clientMsgs = transport.callsOf("sendMessage").filter((c) => c.payload.chat_id === CLIENT_ID);
    expect(clientMsgs).toHaveLength(1);
    expect(String(clientMsgs[0]?.payload.text)).toContain("отменена");

    // Admin gets cancellation notification
    const adminMsgs = transport.callsOf("sendMessage").filter((c) => c.payload.chat_id === ADMIN_ID);
    expect(adminMsgs).toHaveLength(1);
    const adminText = String(adminMsgs[0]?.payload.text);
    expect(adminText).toContain("Запись отменена клиентом");
    expect(adminText).toContain("Артем");
    expect(adminText).toContain("Стрижка Фейд");
    expect(adminText).toContain("Тимур (Барбер)");

    // DB status updated to CANCELLED
    const cancelled = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(cancelled?.status).toBe("CANCELLED");

    // Repeated cancel click: safe, does NOT send second notification to admin
    transport.clear();
    await grammyBot.handleUpdate({
      update_id: 4,
      callback_query: {
        id: "cb_cancel_repeat",
        from: { id: CLIENT_ID, is_bot: false, first_name: "Артем" },
        message: {
          message_id: 11,
          date: 1700000000,
          chat: { id: CLIENT_ID, type: "private", first_name: "Артем" },
          text: "Напоминание о записи",
        },
        chat_instance: "ci_2",
        data: `book:cancel:${booking.id}`,
      },
    });

    const adminRepeat = transport.callsOf("sendMessage").filter((c) => c.payload.chat_id === ADMIN_ID);
    expect(adminRepeat).toHaveLength(0);
  });

  it("3. Masks customer data and attaches payment button when bot subscription is EXPIRED", async () => {
    await prisma.subscription.update({
      where: { botId },
      data: { status: "EXPIRED" },
    });

    const booking = await prisma.booking.create({
      data: {
        botId,
        customerTgId: BigInt(CLIENT_ID),
        customerName: "Артем Секретов",
        customerPhone: "+998901234567",
        serviceId: "srv_fade",
        serviceName: "Стрижка Фейд",
        staffId: "barber_timur",
        durationMin: 45,
        slotTime: new Date("2026-10-28T09:00:00.000Z"),
        status: "CONFIRMED",
      },
    });

    const grammyBot = botPool.getOrCreateBot(resolvedBot);

    transport.clear();
    await grammyBot.handleUpdate({
      update_id: 5,
      callback_query: {
        id: "cb_confirm_masked",
        from: { id: CLIENT_ID, is_bot: false, first_name: "Артем" },
        message: {
          message_id: 12,
          date: 1700000000,
          chat: { id: CLIENT_ID, type: "private", first_name: "Артем" },
          text: "Напоминание",
        },
        chat_instance: "ci_3",
        data: `book:confirm:${booking.id}`,
      },
    });

    const adminMsgs = transport.callsOf("sendMessage").filter((c) => c.payload.chat_id === ADMIN_ID);
    expect(adminMsgs).toHaveLength(1);
    const adminText = String(adminMsgs[0]?.payload.text);
    expect(adminText).toContain("СКРЫТА");
    expect(adminText).toContain("+998 90 *** ** 67");
    expect(adminText).not.toContain("+998901234567");
    // Has payment inline button
    const markup = adminMsgs[0]?.payload.reply_markup as { inline_keyboard?: Array<Array<{ text: string; callback_data: string }>> };
    expect(markup?.inline_keyboard?.[0]?.[0]?.callback_data).toBe("admin:pay");
  });

  it("4. Sends notification in Uzbek (UZ) when admin preference is UZ", async () => {
    await prisma.botUser.update({
      where: { botId_tgId: { botId, tgId: BigInt(ADMIN_ID) } },
      data: { lang: "UZ" },
    });

    const booking = await prisma.booking.create({
      data: {
        botId,
        customerTgId: BigInt(CLIENT_ID),
        customerName: "Артем",
        customerPhone: "+998901234567",
        serviceId: "srv_fade",
        serviceName: "Стрижка Фейд",
        staffId: "barber_timur",
        durationMin: 45,
        slotTime: new Date("2026-10-28T09:00:00.000Z"),
        status: "CONFIRMED",
      },
    });

    const grammyBot = botPool.getOrCreateBot(resolvedBot);

    transport.clear();
    await grammyBot.handleUpdate({
      update_id: 6,
      callback_query: {
        id: "cb_confirm_uz",
        from: { id: CLIENT_ID, is_bot: false, first_name: "Артем" },
        message: {
          message_id: 13,
          date: 1700000000,
          chat: { id: CLIENT_ID, type: "private", first_name: "Артем" },
          text: "Eslatma",
        },
        chat_instance: "ci_4",
        data: `book:confirm:${booking.id}`,
      },
    });

    const adminMsgs = transport.callsOf("sendMessage").filter((c) => c.payload.chat_id === ADMIN_ID);
    expect(adminMsgs).toHaveLength(1);
    const adminText = String(adminMsgs[0]?.payload.text);
    expect(adminText).toContain("Mijoz qabulni tasdiqladi");
    expect(adminText).toContain("Feyd soch turmagi");
    expect(adminText).toContain("Temur (Sartarosh)");
  });

  it("5. Rejects unauthorized user clicks and sends no notification to admin", async () => {
    const booking = await prisma.booking.create({
      data: {
        botId,
        customerTgId: BigInt(CLIENT_ID),
        customerName: "Артем",
        customerPhone: "+998901234567",
        serviceId: "srv_fade",
        serviceName: "Стрижка Фейд",
        staffId: "barber_timur",
        durationMin: 45,
        slotTime: new Date("2026-10-28T09:00:00.000Z"),
        status: "CONFIRMED",
      },
    });

    const grammyBot = botPool.getOrCreateBot(resolvedBot);

    transport.clear();
    await grammyBot.handleUpdate({
      update_id: 7,
      callback_query: {
        id: "cb_stranger_confirm",
        from: { id: STRANGER_ID, is_bot: false, first_name: "Посторонний" },
        message: {
          message_id: 14,
          date: 1700000000,
          chat: { id: STRANGER_ID, type: "private", first_name: "Посторонний" },
          text: "Напоминание",
        },
        chat_instance: "ci_5",
        data: `book:confirm:${booking.id}`,
      },
    });

    const strangerMsgs = transport.callsOf("sendMessage").filter((c) => c.payload.chat_id === STRANGER_ID);
    expect(strangerMsgs).toHaveLength(1);
    expect(String(strangerMsgs[0]?.payload.text)).toContain("Доступ запрещен");

    const adminMsgs = transport.callsOf("sendMessage").filter((c) => c.payload.chat_id === ADMIN_ID);
    expect(adminMsgs).toHaveLength(0);
  });

  it("6. Retries admin notification on subsequent click if first delivery failed", async () => {
    const booking = await prisma.booking.create({
      data: {
        botId,
        customerTgId: BigInt(CLIENT_ID),
        customerName: "Артем",
        customerPhone: "+998901234567",
        serviceId: "srv_fade",
        serviceName: "Стрижка Фейд",
        staffId: "barber_timur",
        durationMin: 45,
        slotTime: new Date("2026-10-28T09:00:00.000Z"),
        status: "CONFIRMED",
      },
    });

    // Make transport fail ONLY when sending to ADMIN_ID on the first attempt
    let failAdminSend = true;
    const origTransformer = transport.transformerFor.bind(transport);
    transport.transformerFor = (bId: string) => {
      const base = origTransformer(bId);
      return async (prev, method, payload, signal) => {
        const p = (payload ?? {}) as Record<string, unknown>;
        if (failAdminSend && method === "sendMessage" && p.chat_id === ADMIN_ID) {
          throw new Error("Simulated Telegram 500 error for admin notification");
        }
        return base ? base(prev, method, payload, signal) : prev(method, payload, signal);
      };
    };

    try {
      const grammyBot = botPool.getOrCreateBot(resolvedBot);

      // 1st click: admin notification fails
      transport.clear();
      await grammyBot.handleUpdate({
        update_id: 8,
        callback_query: {
          id: "cb_confirm_retry_1",
          from: { id: CLIENT_ID, is_bot: false, first_name: "Артем" },
          message: {
            message_id: 15,
            date: 1700000000,
            chat: { id: CLIENT_ID, type: "private", first_name: "Артем" },
            text: "Напоминание",
          },
          chat_instance: "ci_6",
          data: `book:confirm:${booking.id}`,
        },
      });

      // Lock key should NOT remain set since delivery failed
      expect(await redis.get(`booking:confirm_notified:${booking.id}`)).toBeNull();

      // 2nd click: Telegram recovers -> admin notification succeeds!
      failAdminSend = false;
      transport.clear();
      await grammyBot.handleUpdate({
        update_id: 9,
        callback_query: {
          id: "cb_confirm_retry_2",
          from: { id: CLIENT_ID, is_bot: false, first_name: "Артем" },
          message: {
            message_id: 15,
            date: 1700000000,
            chat: { id: CLIENT_ID, type: "private", first_name: "Артем" },
            text: "Напоминание",
          },
          chat_instance: "ci_6",
          data: `book:confirm:${booking.id}`,
        },
      });

      const adminMsgs = transport.callsOf("sendMessage").filter((c) => c.payload.chat_id === ADMIN_ID);
      expect(adminMsgs).toHaveLength(1);
      expect(String(adminMsgs[0]?.payload.text)).toContain("Клиент подтвердил запись");
      expect(await redis.get(`booking:confirm_notified:${booking.id}`)).toBe("1");
    } finally {
      transport.transformerFor = origTransformer;
    }
  });
});
