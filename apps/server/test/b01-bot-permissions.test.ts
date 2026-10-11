import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectRedis, encryptSecret, MockTelegramTransport, type Redis } from "../src/index.js";
import { env } from "../src/core/env.js";
import { logger } from "../src/core/logger.js";
import { BotPool } from "../src/gateway/bot-pool.js";
import type { ResolvedBot } from "../src/gateway/types.js";
import { cancelBooking } from "../src/bots/quickbook/booking-service.js";
import {
  getTestPrismaClient,
  createTestRedisClient,
  safeCleanTestDb,
  safeCleanTestRedis,
} from "./helpers/test-env.js";

const prisma = getTestPrismaClient();

describe("B01: Bot Permissions & Action Security", () => {
  let redis: Redis;
  let transport: MockTelegramTransport;
  let botPool: BotPool;
  let botId: string;
  let otherBotId: string;
  let resolvedBot: ResolvedBot;

  const BOT_TOKEN = "111222333:PermTestBotToken";
  const ADMIN_INVITE_CODE = "perm_adm_code_123";
  const REGULAR_USER_ID = 5001;
  const REVOKED_ADMIN_ID = 5002;
  const ACTIVE_ADMIN_ID = 5003;
  const CLIENT_A_ID = 6001;
  const CLIENT_B_ID = 6002;

  beforeAll(async () => {
    await prisma.$connect();
    redis = createTestRedisClient("test-b01-perm");
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
      data: { clientName: "Perm Test Tenant", contactPhone: "+998901234567" },
    });

    const botTokenEnc = encryptSecret(BOT_TOKEN, env.TOKEN_ENCRYPTION_KEY);
    const bot = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "QUICKBOOK",
        botTokenEnc,
        botTokenHash: "hash_perm_bot_1",
        webhookSecret: "secret_perm_1",
        adminInviteCode: ADMIN_INVITE_CODE,
        subscription: {
          create: {
            status: "ACTIVE",
            trialEndsAt: new Date(Date.now() + 86400000 * 30),
            paidUntil: new Date(Date.now() + 86400000 * 30),
          },
        },
      },
    });
    botId = bot.id;

    // Create another bot to test cross-bot isolation
    const otherBot = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "QUICKBOOK",
        botTokenEnc,
        botTokenHash: "hash_perm_bot_other",
        webhookSecret: "secret_perm_other",
        adminInviteCode: "other_adm_code",
        subscription: {
          create: {
            status: "ACTIVE",
            trialEndsAt: new Date(Date.now() + 86400000 * 30),
          },
        },
      },
    });
    otherBotId = otherBot.id;

    // Set up users in database
    await prisma.botUser.createMany({
      data: [
        {
          botId,
          tgId: BigInt(REGULAR_USER_ID),
          firstName: "Regular User",
          isAdmin: false,
          lang: "RU",
        },
        {
          botId,
          tgId: BigInt(REVOKED_ADMIN_ID),
          firstName: "Revoked Admin",
          isAdmin: false, // revoked!
          lang: "RU",
        },
        {
          botId,
          tgId: BigInt(ACTIVE_ADMIN_ID),
          firstName: "Active Admin",
          isAdmin: true,
          lang: "RU",
        },
        {
          botId,
          tgId: BigInt(CLIENT_A_ID),
          firstName: "Client A",
          isAdmin: false,
          lang: "RU",
        },
        {
          botId,
          tgId: BigInt(CLIENT_B_ID),
          firstName: "Client B",
          isAdmin: false,
          lang: "RU",
        },
      ],
    });

    resolvedBot = {
      id: bot.id,
      tenantId: tenant.id,
      botType: bot.botType,
      botTokenEnc,
      botTokenHash: bot.botTokenHash,
      webhookSecret: bot.webhookSecret,
      botUsername: "perm_test_bot",
      adminInviteCode: bot.adminInviteCode,
      settings: {},
      subscriptionStatus: "ACTIVE",
      trialEndsAt: new Date(Date.now() + 86400000 * 30).toISOString(),
      paidUntil: new Date(Date.now() + 86400000 * 30).toISOString(),
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

  it("1. Regular user and revoked admin cannot view leads via admin:leads callback", async () => {
    const grammyBot = botPool.getOrCreateBot(resolvedBot);

    // Regular user clicks admin:leads
    transport.clear();
    await grammyBot.handleUpdate({
      update_id: 101,
      callback_query: {
        id: "cb_perm_reg",
        from: { id: REGULAR_USER_ID, is_bot: false, first_name: "Regular" },
        message: {
          message_id: 1,
          date: 1700000000,
          chat: { id: REGULAR_USER_ID, type: "private", first_name: "Regular" },
          text: "Menu",
        },
        chat_instance: "ci_1",
        data: "admin:leads",
      },
    });

    // Check no message sent and answered with alert
    const sentToRegular = transport.callsOf("sendMessage").filter((c) => c.payload.chat_id === REGULAR_USER_ID);
    expect(sentToRegular).toHaveLength(0);
    const cbAnswerRegular = transport.callsOf("answerCallbackQuery").find((c) => c.payload.callback_query_id === "cb_perm_reg");
    expect(cbAnswerRegular?.payload.show_alert).toBe(true);

    // Revoked admin clicks admin:leads
    transport.clear();
    await grammyBot.handleUpdate({
      update_id: 102,
      callback_query: {
        id: "cb_perm_revoked",
        from: { id: REVOKED_ADMIN_ID, is_bot: false, first_name: "Revoked" },
        message: {
          message_id: 2,
          date: 1700000000,
          chat: { id: REVOKED_ADMIN_ID, type: "private", first_name: "Revoked" },
          text: "Menu",
        },
        chat_instance: "ci_2",
        data: "admin:leads",
      },
    });

    const sentToRevoked = transport.callsOf("sendMessage").filter((c) => c.payload.chat_id === REVOKED_ADMIN_ID);
    expect(sentToRevoked).toHaveLength(0);
    const cbAnswerRevoked = transport.callsOf("answerCallbackQuery").find((c) => c.payload.callback_query_id === "cb_perm_revoked");
    expect(cbAnswerRevoked?.payload.show_alert).toBe(true);

    // Active admin clicks admin:leads -> succeeds
    transport.clear();
    await grammyBot.handleUpdate({
      update_id: 103,
      callback_query: {
        id: "cb_perm_admin",
        from: { id: ACTIVE_ADMIN_ID, is_bot: false, first_name: "Admin" },
        message: {
          message_id: 3,
          date: 1700000000,
          chat: { id: ACTIVE_ADMIN_ID, type: "private", first_name: "Admin" },
          text: "Menu",
        },
        chat_instance: "ci_3",
        data: "admin:leads",
      },
    });

    const sentToAdmin = transport.callsOf("sendMessage").filter((c) => c.payload.chat_id === ACTIVE_ADMIN_ID);
    expect(sentToAdmin.length).toBeGreaterThan(0);
  });

  it("2. Client B cannot cancel Client A's booking via callback or service", async () => {
    const booking = await prisma.booking.create({
      data: {
        botId,
        customerTgId: BigInt(CLIENT_A_ID),
        customerName: "Client A",
        customerPhone: "+998901111111",
        serviceId: "srv_1",
        serviceName: "Service 1",
        staffId: "staff_1",
        durationMin: 30,
        slotTime: new Date(Date.now() + 86400000),
        status: "PENDING",
      },
    });

    const grammyBot = botPool.getOrCreateBot(resolvedBot);

    // Client B attempts to cancel Client A's booking via callback
    transport.clear();
    await grammyBot.handleUpdate({
      update_id: 201,
      callback_query: {
        id: "cb_hijack_cancel",
        from: { id: CLIENT_B_ID, is_bot: false, first_name: "Attacker B" },
        message: {
          message_id: 10,
          date: 1700000000,
          chat: { id: CLIENT_B_ID, type: "private", first_name: "Attacker B" },
          text: "Reminder",
        },
        chat_instance: "ci_hijack",
        data: `book:cancel:${booking.id}`,
      },
    });

    // Check rejection message sent to Client B
    const callsB = transport.callsOf("sendMessage").filter((c) => c.payload.chat_id === CLIENT_B_ID);
    expect(callsB.length).toBeGreaterThan(0);
    expect(String(callsB[0]?.payload.text)).toContain("Доступ запрещен");

    // Check DB status was NOT changed to CANCELLED
    const freshBooking = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(freshBooking?.status).toBe("PENDING");

    // Direct service cancellation check with wrong botId
    const wrongBotRes = await cancelBooking(prisma, redis, {
      bookingId: booking.id,
      botId: otherBotId,
      userId: CLIENT_A_ID,
    });
    expect(wrongBotRes.success).toBe(false);
    if (!wrongBotRes.success) {
      expect(wrongBotRes.error).toBe("FORBIDDEN");
    }

    // Direct service cancellation check with wrong user
    const wrongUserRes = await cancelBooking(prisma, redis, {
      bookingId: booking.id,
      botId,
      userId: CLIENT_B_ID,
    });
    expect(wrongUserRes.success).toBe(false);
    if (!wrongUserRes.success) {
      expect(wrongUserRes.error).toBe("FORBIDDEN");
    }
  });

  it("3. Owner can cancel own booking, and repeated cancellation is safe and idempotent", async () => {
    const booking = await prisma.booking.create({
      data: {
        botId,
        customerTgId: BigInt(CLIENT_A_ID),
        customerName: "Client A",
        customerPhone: "+998901111111",
        serviceId: "srv_1",
        serviceName: "Service 1",
        staffId: "staff_1",
        durationMin: 30,
        slotTime: new Date(Date.now() + 86400000),
        status: "PENDING",
      },
    });

    const grammyBot = botPool.getOrCreateBot(resolvedBot);

    // 1st cancel by owner -> succeeds
    transport.clear();
    await grammyBot.handleUpdate({
      update_id: 301,
      callback_query: {
        id: "cb_owner_cancel_1",
        from: { id: CLIENT_A_ID, is_bot: false, first_name: "Owner A" },
        message: {
          message_id: 20,
          date: 1700000000,
          chat: { id: CLIENT_A_ID, type: "private", first_name: "Owner A" },
          text: "Reminder",
        },
        chat_instance: "ci_owner",
        data: `book:cancel:${booking.id}`,
      },
    });

    const calls1 = transport.callsOf("sendMessage").filter((c) => c.payload.chat_id === CLIENT_A_ID);
    expect(calls1.length).toBeGreaterThan(0);
    expect(String(calls1[0]?.payload.text)).toContain("отменена");

    const cancelledBooking = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(cancelledBooking?.status).toBe("CANCELLED");

    // 2nd cancel by owner (repeated / stale button click) -> safe, idempotent, doesn't throw
    transport.clear();
    await grammyBot.handleUpdate({
      update_id: 302,
      callback_query: {
        id: "cb_owner_cancel_2",
        from: { id: CLIENT_A_ID, is_bot: false, first_name: "Owner A" },
        message: {
          message_id: 20,
          date: 1700000000,
          chat: { id: CLIENT_A_ID, type: "private", first_name: "Owner A" },
          text: "Reminder",
        },
        chat_instance: "ci_owner",
        data: `book:cancel:${booking.id}`,
      },
    });

    const calls2 = transport.callsOf("sendMessage").filter((c) => c.payload.chat_id === CLIENT_A_ID);
    expect(calls2.length).toBeGreaterThan(0);
    expect(String(calls2[0]?.payload.text)).toContain("отменена");
  });

  it("4. Booking confirmation validates booking existence, botId and user ownership", async () => {
    const booking = await prisma.booking.create({
      data: {
        botId,
        customerTgId: BigInt(CLIENT_A_ID),
        customerName: "Client A",
        customerPhone: "+998901111111",
        serviceId: "srv_1",
        serviceName: "Service 1",
        staffId: "staff_1",
        durationMin: 30,
        slotTime: new Date(Date.now() + 86400000),
        status: "PENDING",
      },
    });

    const grammyBot = botPool.getOrCreateBot(resolvedBot);

    // Client B tries to confirm Client A's booking
    transport.clear();
    await grammyBot.handleUpdate({
      update_id: 401,
      callback_query: {
        id: "cb_confirm_hijack",
        from: { id: CLIENT_B_ID, is_bot: false, first_name: "Client B" },
        message: {
          message_id: 30,
          date: 1700000000,
          chat: { id: CLIENT_B_ID, type: "private", first_name: "Client B" },
          text: "Reminder",
        },
        chat_instance: "ci_conf",
        data: `book:confirm:${booking.id}`,
      },
    });

    const callsB = transport.callsOf("sendMessage").filter((c) => c.payload.chat_id === CLIENT_B_ID);
    expect(callsB.length).toBeGreaterThan(0);
    expect(String(callsB[0]?.payload.text)).toContain("Доступ запрещен");

    // Client A confirms own booking
    transport.clear();
    await grammyBot.handleUpdate({
      update_id: 402,
      callback_query: {
        id: "cb_confirm_owner",
        from: { id: CLIENT_A_ID, is_bot: false, first_name: "Client A" },
        message: {
          message_id: 31,
          date: 1700000000,
          chat: { id: CLIENT_A_ID, type: "private", first_name: "Client A" },
          text: "Reminder",
        },
        chat_instance: "ci_conf_owner",
        data: `book:confirm:${booking.id}`,
      },
    });

    const callsA = transport.callsOf("sendMessage").filter((c) => c.payload.chat_id === CLIENT_A_ID);
    expect(callsA.length).toBeGreaterThan(0);
    expect(String(callsA[0]?.payload.text)).toContain("подтверждение");

    const confirmed = await prisma.booking.findUnique({ where: { id: booking.id } });
    expect(confirmed?.status).toBe("CONFIRMED");
  });
});
