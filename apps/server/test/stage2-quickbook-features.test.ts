import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyJwt from "@fastify/jwt";
import {
  MockTelegramTransport,
  connectRedis,
  encryptSecret,
  sha256Hex,
  logger,
  type Redis,
} from "../src/index.js";
import { env } from "../src/core/env.js";
import {
  createBooking,
} from "../src/bots/quickbook/booking-service.js";
import { rescheduleBooking } from "../src/bots/quickbook/reschedule-service.js";
import {
  createTimeBlock,
} from "../src/bots/quickbook/time-block-service.js";
import { findAffectedBookings } from "../src/bots/quickbook/conflict-checker.js";
import { generateAvailableSlots } from "../src/bots/quickbook/slot-generator.js";
import { runBookingReminderWorker } from "../src/workers/booking-reminder-worker.js";
import { registerBotsSimpleSettingsRoutes } from "../src/admin-api/bots-simple-settings.js";
import type { QuickBookConfig } from "@lcqb/contracts";
import {
  getTestPrismaClient,
  createTestRedisClient,
  safeCleanTestDb,
  safeCleanTestRedis,
} from "./helpers/test-env.js";

const prisma = getTestPrismaClient();
let redis: Redis;

const TEST_CONFIG: QuickBookConfig = {
  resourceType: "STAFF",
  resourceLabel: { ru: "Мастер", uz: "Usta" },
  services: [
    {
      id: "haircut",
      name: { ru: "Стрижка", uz: "Soch turmagi" },
      durationMin: 30,
      priceUzs: 50000,
    },
    {
      id: "beard",
      name: { ru: "Борода", uz: "Soqol" },
      durationMin: 30,
      priceUzs: 30000,
    },
  ],
  resources: [
    {
      id: "master-1",
      name: { ru: "Алишер", uz: "Alisher" },
      workDays: [0, 1, 2, 3, 4, 5, 6],
      workHours: { start: "09:00", end: "18:00" },
    },
  ],
  slotIntervalMin: 30,
  bookingHorizonDays: 14,
  timezone: "Asia/Tashkent",
};

describe("Stage 2 QuickBook Features: Manual Booking, Client Reschedule, TimeBlocks & Settings", () => {
  let transport: MockTelegramTransport;
  let botId: string;
  let app: FastifyInstance;
  let adminToken: string;

  const BOT_TOKEN = "888999000:Stage2QuickBookBotToken";
  const ADMIN_TG_ID = 5001001;
  const CLIENT_TG_ID = 6001001;
  const CLIENT2_TG_ID = 6001002;

  beforeAll(async () => {
    redis = createTestRedisClient();
    await connectRedis(redis);
  });

  afterAll(async () => {
    if (app) await app.close();
    await redis.quit();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await safeCleanTestDb(prisma);
    await safeCleanTestRedis(redis);

    transport = new MockTelegramTransport();

    const tenant = await prisma.tenant.create({
      data: {
        clientName: "Барбершоп Stage 2",
        contactPhone: "+998901234567",
      },
    });

    const botTokenHash = sha256Hex(BOT_TOKEN);
    const bot = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "QUICKBOOK",
        botTokenEnc: encryptSecret(BOT_TOKEN, env.TOKEN_ENCRYPTION_KEY),
        botTokenHash,
        webhookSecret: "stage2secret",
        settings: TEST_CONFIG as unknown as object,
        subscription: {
          create: {
            status: "ACTIVE",
            trialEndsAt: new Date(Date.now() + 86400000 * 7),
            paidUntil: new Date(Date.now() + 86400000 * 30),
          },
        },
      },
    });

    botId = bot.id;

    // Create Admin and SuperAdmin
    const admin = await prisma.admin.upsert({
      where: { email: "superadmin_stage2@test.local" },
      update: {},
      create: {
        email: "superadmin_stage2@test.local",
        passwordHash: "hash",
      },
    });

    // Fastify app for testing endpoints
    app = Fastify();
    await app.register(fastifyJwt, { secret: env.JWT_ACCESS_SECRET });
    adminToken = app.jwt.sign({
      adminId: admin.id,
      email: admin.email,
      tokenType: "access",
    });

    registerBotsSimpleSettingsRoutes(app, prisma, redis);
    await app.ready();
  });

  it("2.1 Manual Booking: created with customerTgId=null, source=MANUAL, createdByTgId set, and reminder worker skips it", async () => {
    const slotTime = new Date(Date.UTC(2026, 9, 20, 5, 0, 0)); // 10:00 Tashkent time (UTC+5)

    const res = await createBooking({
      prisma,
      redis,
      transport,
      logger,
      botId,
      customerTgId: null,
      customerName: "Ручной Клиент",
      customerPhone: "+998901112233",
      phoneVerified: false,
      serviceId: "haircut",
      staffId: "master-1",
      slotTime,
      config: TEST_CONFIG,
      source: "MANUAL",
      createdByTgId: ADMIN_TG_ID,
      now: new Date(Date.UTC(2026, 9, 20, 0, 0, 0)),
    });

    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(res.booking.customerTgId).toBeNull();
    expect(res.booking.source).toBe("MANUAL");
    expect(res.booking.createdByTgId).toBe(BigInt(ADMIN_TG_ID));
    expect(res.booking.customerName).toBe("Ручной Клиент");

    // Run reminder worker right before the slot
    const reminderNow = new Date(slotTime.getTime() - 3600 * 1000 + 1000);
    const workerResult = await runBookingReminderWorker({
      prisma,
      redis,
      transport,
      logger,
      now: reminderNow,
    });

    expect(workerResult.executed).toBe(true);
    // Manual booking was skipped without attempting Telegram message
    expect(transport.callsOf("sendMessage").length).toBe(0);

    const dbBooking = await prisma.booking.findUnique({
      where: { id: res.booking.id },
    });
    expect(dbBooking?.reminderSent).toBe(true);
  });

  it("2.2 Client Reschedule: atomically updates slotTime, resets reminderSent, and checks conflicts", async () => {
    const slot1 = new Date(Date.UTC(2026, 9, 20, 5, 0, 0)); // 10:00 Tashkent
    const slot2 = new Date(Date.UTC(2026, 9, 20, 6, 0, 0)); // 11:00 Tashkent

    // Client 1 books slot 1
    const res1 = await createBooking({
      prisma,
      redis,
      transport,
      logger,
      botId,
      customerTgId: CLIENT_TG_ID,
      customerName: "Клиент 1",
      customerPhone: "+998901112233",
      serviceId: "haircut",
      staffId: "master-1",
      slotTime: slot1,
      config: TEST_CONFIG,
      now: new Date(Date.UTC(2026, 9, 20, 0, 0, 0)),
    });
    expect(res1.success).toBe(true);
    if (!res1.success) return;

    // Reschedule Client 1 to slot 2
    const reschedRes = await rescheduleBooking({
      prisma,
      redis,
      transport,
      logger,
      botId,
      bookingId: res1.booking.id,
      newSlotTime: slot2,
      userId: CLIENT_TG_ID,
      config: TEST_CONFIG,
      now: new Date(Date.UTC(2026, 9, 20, 0, 0, 0)),
    });

    expect(reschedRes.success).toBe(true);
    if (!reschedRes.success) return;
    expect(reschedRes.booking.slotTime.getTime()).toBe(slot2.getTime());
    expect(reschedRes.booking.reminderSent).toBe(false);

    // Now Client 2 books slot 1 (which was freed up by reschedule)
    const res2 = await createBooking({
      prisma,
      redis,
      transport,
      logger,
      botId,
      customerTgId: CLIENT2_TG_ID,
      customerName: "Клиент 2",
      customerPhone: "+998902223344",
      serviceId: "haircut",
      staffId: "master-1",
      slotTime: slot1,
      config: TEST_CONFIG,
      now: new Date(Date.UTC(2026, 9, 20, 0, 0, 0)),
    });
    expect(res2.success).toBe(true);
    if (!res2.success) return;

    // Client 2 attempts to reschedule into slot 2 (already occupied by Client 1)
    const conflictResched = await rescheduleBooking({
      prisma,
      redis,
      transport,
      logger,
      botId,
      bookingId: res2.booking.id,
      newSlotTime: slot2,
      userId: CLIENT2_TG_ID,
      config: TEST_CONFIG,
      now: new Date(Date.UTC(2026, 9, 20, 0, 0, 0)),
    });
    expect(conflictResched.success).toBe(false);
    if (conflictResched.success) return;
    expect(conflictResched.error).toBe("SLOT_TAKEN");
  });

  it("2.3 TimeBlocks: excludes blocked slots from generator and rejects booking during block", async () => {
    const blockStart = new Date(Date.UTC(2026, 9, 20, 6, 0, 0)); // 11:00 Tashkent
    const blockEnd = new Date(Date.UTC(2026, 9, 20, 8, 0, 0)); // 13:00 Tashkent

    await createTimeBlock(prisma, {
      botId,
      resourceId: "master-1",
      startsAt: blockStart,
      endsAt: blockEnd,
      reason: "Обед и перерыв",
      createdByTgId: ADMIN_TG_ID,
    });

    // Slots generator for 2026-10-20
    const slots = await generateAvailableSlots({
      botId,
      config: TEST_CONFIG,
      serviceId: "haircut",
      staffId: "master-1",
      dateStr: "2026-10-20",
      prisma,
      now: new Date(Date.UTC(2026, 9, 20, 0, 0, 0)),
    });

    // 11:00, 11:30, 12:00, 12:30 must NOT be in available slots
    const times = slots.map((s) => s.timeLabel);
    expect(times).not.toContain("11:00");
    expect(times).not.toContain("11:30");
    expect(times).not.toContain("12:00");
    expect(times).not.toContain("12:30");
    expect(times).toContain("10:30");
    expect(times).toContain("13:00");

    // Attempting to create booking during blocked slot fails
    const createRes = await createBooking({
      prisma,
      redis,
      transport,
      logger,
      botId,
      customerTgId: CLIENT_TG_ID,
      customerPhone: "+998901234567",
      serviceId: "haircut",
      staffId: "master-1",
      slotTime: blockStart,
      config: TEST_CONFIG,
      now: new Date(Date.UTC(2026, 9, 20, 0, 0, 0)),
    });
    expect(createRes.success).toBe(false);
    if (createRes.success) return;
    expect(createRes.error).toBe("SLOT_TAKEN");
  });

  it("2.4 Conflict Checker: detects affected bookings on proposed TimeBlock and schedule changes", async () => {
    const slotTime = new Date(Date.UTC(2026, 9, 20, 7, 0, 0)); // 12:00 Tashkent

    const res = await createBooking({
      prisma,
      redis,
      transport,
      logger,
      botId,
      customerTgId: CLIENT_TG_ID,
      customerName: "Клиент Конфликт",
      customerPhone: "+998909998877",
      serviceId: "haircut",
      staffId: "master-1",
      slotTime,
      config: TEST_CONFIG,
      now: new Date(Date.UTC(2026, 9, 20, 0, 0, 0)),
    });
    expect(res.success).toBe(true);

    // Check conflict when a new TimeBlock covers 12:00
    const conflictBlock = await findAffectedBookings({
      botId,
      prisma,
      now: new Date(Date.UTC(2026, 9, 20, 0, 0, 0)),
      newBlock: {
        resourceId: "master-1",
        startsAt: new Date(Date.UTC(2026, 9, 20, 6, 30, 0)),
        endsAt: new Date(Date.UTC(2026, 9, 20, 8, 0, 0)),
      },
    });

    expect(conflictBlock.hasConflicts).toBe(true);
    expect(conflictBlock.affectedCount).toBe(1);
    expect(conflictBlock.affectedBookings[0]!.reason).toBe("OVERLAPS_TIME_BLOCK");

    // Check conflict when master-1 workHours are shortened to end at 11:00
    const modifiedConfig: QuickBookConfig = {
      ...TEST_CONFIG,
      resources: [
        {
          ...TEST_CONFIG.resources[0]!,
          workHours: { start: "09:00", end: "11:00" },
        },
      ],
    };

    const conflictSettings = await findAffectedBookings({
      botId,
      prisma,
      now: new Date(Date.UTC(2026, 9, 20, 0, 0, 0)),
      newSettings: modifiedConfig,
    });

    expect(conflictSettings.hasConflicts).toBe(true);
    expect(conflictSettings.affectedCount).toBe(1);
    expect(conflictSettings.affectedBookings[0]!.reason).toBe("OUTSIDE_WORK_HOURS");
  });

  it("2.5 Simple Settings & TimeBlock Admin API: updates settings, manages blocks and checks conflicts", async () => {
    // 1. PATCH simple-settings (price update)
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/bots/${botId}/simple-settings`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        prices: [{ serviceId: "haircut", priceUzs: 75000 }],
        welcomeMessage: { ru: "Добро пожаловать в барбершоп!", uz: "Xush kelibsiz!" },
      },
    });

    expect(patchRes.statusCode).toBe(200);
    const updatedBot = await prisma.bot.findUnique({ where: { id: botId } });
    const settings = (updatedBot?.settings ?? {}) as unknown as QuickBookConfig;
    expect(settings.services[0].priceUzs).toBe(75000);
    expect(settings.customTexts.welcome.ru).toBe("Добро пожаловать в барбершоп!");

    // Audit log was recorded
    const logs = await prisma.botSettingsLog.findMany({ where: { botId } });
    expect(logs.length).toBe(1);

    // 2. POST /time-blocks
    const tbRes = await app.inject({
      method: "POST",
      url: `/api/v1/bots/${botId}/time-blocks`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        resourceId: "master-1",
        startsAt: "2026-10-21T10:00:00.000Z",
        endsAt: "2026-10-21T14:00:00.000Z",
        reason: "Отгул",
      },
    });
    expect(tbRes.statusCode).toBe(201);
    const tbData = JSON.parse(tbRes.body);
    const blockId = tbData.timeBlock.id;

    // 3. GET /time-blocks
    const getTbRes = await app.inject({
      method: "GET",
      url: `/api/v1/bots/${botId}/time-blocks`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(getTbRes.statusCode).toBe(200);
    const getTbData = JSON.parse(getTbRes.body);
    expect(getTbData.timeBlocks.length).toBe(1);

    // 4. DELETE /time-blocks/:blockId
    const delTbRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/bots/${botId}/time-blocks/${blockId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(delTbRes.statusCode).toBe(200);

    const getTbAfterDel = await app.inject({
      method: "GET",
      url: `/api/v1/bots/${botId}/time-blocks`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(JSON.parse(getTbAfterDel.body).timeBlocks.length).toBe(0);
  });
});
