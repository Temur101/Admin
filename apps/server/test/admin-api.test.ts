import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildApp,
  connectRedis,
  MockTelegramTransport,
  type FastifyInstance,
  type Redis,
} from "../src/index.js";
import { env } from "../src/core/env.js";
import {
  createTestRedisClient,
  getTestPrismaClient,
  safeCleanTestDb,
  safeCleanTestRedis,
} from "./helpers/test-env.js";
import { submitPaymentReceipt } from "../src/bots/shared/payment-service.js";

const prisma = getTestPrismaClient();
let redis: Redis;
let transport: MockTelegramTransport;
let app: FastifyInstance;

describe("Stage 7: Admin REST API & Clarifications Integration Test", () => {
  beforeAll(async () => {
    await prisma.$connect();
    redis = createTestRedisClient("test-admin-api");
    await connectRedis(redis);
    transport = new MockTelegramTransport();

    app = await buildApp({
      prisma,
      redis,
      transport,
      enableScheduler: false,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    if (redis && redis.status !== "end") {
      await redis.quit();
    }
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    transport.clear();
    await safeCleanTestRedis(redis);
    await safeCleanTestDb(prisma);
  });

  // Helper to obtain a valid admin JWT access token
  async function getAdminToken(): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: "10.0.0.1",
      payload: {
        email: env.SUPERADMIN_EMAIL,
        password: env.SUPERADMIN_PASSWORD,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; accessToken: string }>();
    return body.accessToken;
  }

  describe("1. Authentication & Security (Argon2, JWT, Rate Limiting)", () => {
    it("should reject unauthorized requests to protected endpoints", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/tenants",
      });
      expect(res.statusCode).toBe(401);
    });

    it("should login with superadmin credentials and reject wrong password", async () => {
      const failRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        remoteAddress: "10.0.0.2",
        payload: {
          email: env.SUPERADMIN_EMAIL,
          password: "wrongpassword123",
        },
      });
      expect(failRes.statusCode).toBe(401);

      const token = await getAdminToken();
      expect(token).toBeDefined();

      const okRes = await app.inject({
        method: "GET",
        url: "/api/v1/tenants",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      expect(okRes.statusCode).toBe(200);
    });

    it("should rate limit login attempts after 10 failed attempts", async () => {
      const rateLimitIp = "192.168.99.99";
      for (let i = 0; i < 10; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/auth/login",
          remoteAddress: rateLimitIp,
          payload: {
            email: env.SUPERADMIN_EMAIL,
            password: "wrongpassword",
          },
        });
        expect(res.statusCode).toBe(401);
      }

      // 11th request from this IP must be rate-limited with 429
      const blockedRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        remoteAddress: rateLimitIp,
        payload: {
          email: env.SUPERADMIN_EMAIL,
          password: "wrongpassword",
        },
      });
      expect(blockedRes.statusCode).toBe(429);
    });
  });

  describe("2. Tenants Management", () => {
    it("should create, list, and suspend tenants", async () => {
      const token = await getAdminToken();

      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/tenants",
        headers: { Authorization: `Bearer ${token}` },
        payload: {
          clientName: "Barbershop Pilot",
          contactPhone: "+998901234567",
        },
      });
      expect(createRes.statusCode).toBe(201);
      const tenant = createRes.json<{ ok: boolean; tenant: { id: string; clientName: string } }>().tenant;
      expect(tenant.clientName).toBe("Barbershop Pilot");

      const listRes = await app.inject({
        method: "GET",
        url: "/api/v1/tenants",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(listRes.statusCode).toBe(200);
      const tenants = listRes.json<{ ok: boolean; tenants: Array<{ id: string }> }>().tenants;
      expect(tenants.some((t) => t.id === tenant.id)).toBe(true);

      const deleteRes = await app.inject({
        method: "DELETE",
        url: `/api/v1/tenants/${tenant.id}`,
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(deleteRes.statusCode).toBe(200);
      const updatedTenant = await prisma.tenant.findUnique({ where: { id: tenant.id } });
      expect(updatedTenant?.status).toBe("SUSPENDED");
    });
  });

  describe("3. Bot Lifecycle & Clarification 4 (Suspend vs Purge)", () => {
    it("should register bot, suspend without losing data, and reject non-purge DELETE", async () => {
      const token = await getAdminToken();

      const tenantRes = await app.inject({
        method: "POST",
        url: "/api/v1/tenants",
        headers: { Authorization: `Bearer ${token}` },
        payload: { clientName: "Pilot B", contactPhone: "+998909998877" },
      });
      const tenantId = tenantRes.json<{ tenant: { id: string } }>().tenant.id;

      // Register bot
      const createBotRes = await app.inject({
        method: "POST",
        url: "/api/v1/bots",
        headers: { Authorization: `Bearer ${token}` },
        payload: {
          tenantId,
          botType: "QUICKBOOK",
          botToken: "123456789:TestQuickBookBotToken",
        },
      });
      expect(createBotRes.statusCode).toBe(201);
      const bot = createBotRes.json<{ bot: { id: string; isActive: boolean; adminInviteCode: string } }>().bot;
      expect(bot.isActive).toBe(true);

      // Clarification 4: DELETE without ?purge=true must return 400
      const safeDeleteRes = await app.inject({
        method: "DELETE",
        url: `/api/v1/bots/${bot.id}`,
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(safeDeleteRes.statusCode).toBe(400);

      // Suspend bot: stops webhook, preserves data
      const suspendRes = await app.inject({
        method: "POST",
        url: `/api/v1/bots/${bot.id}/suspend`,
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(suspendRes.statusCode).toBe(200);
      const dbBotSuspended = await prisma.bot.findUnique({ where: { id: bot.id } });
      expect(dbBotSuspended?.isActive).toBe(false);

      // Resume bot
      const resumeRes = await app.inject({
        method: "POST",
        url: `/api/v1/bots/${bot.id}/resume`,
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(resumeRes.statusCode).toBe(200);
      const dbBotResumed = await prisma.bot.findUnique({ where: { id: bot.id } });
      expect(dbBotResumed?.isActive).toBe(true);

      // Reissue admin invite
      const reissueRes = await app.inject({
        method: "POST",
        url: `/api/v1/bots/${bot.id}/reissue-invite`,
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(reissueRes.statusCode).toBe(200);
      const newInvite = reissueRes.json<{ adminInviteCode: string }>().adminInviteCode;
      expect(newInvite).not.toBe(bot.adminInviteCode);

      // Extend subscription
      const extendRes = await app.inject({
        method: "POST",
        url: `/api/v1/bots/${bot.id}/extend`,
        headers: { Authorization: `Bearer ${token}` },
        payload: { days: 45 },
      });
      expect(extendRes.statusCode).toBe(200);

      // Verify stats.adminsCount vs stats.usersCount in list and details endpoints
      await prisma.botUser.createMany({
        data: [
          { botId: bot.id, tgId: 1001n, firstName: "Admin 1", isAdmin: true },
          { botId: bot.id, tgId: 2001n, firstName: "Client 1", isAdmin: false },
          { botId: bot.id, tgId: 2002n, firstName: "Client 2", isAdmin: false },
        ],
      });

      const botsListRes = await app.inject({
        method: "GET",
        url: "/api/v1/bots",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(botsListRes.statusCode).toBe(200);
      const listedBot = botsListRes
        .json<{ bots: Array<{ id: string; stats: { adminsCount: number; usersCount: number } }> }>()
        .bots.find((b) => b.id === bot.id);
      expect(listedBot?.stats.adminsCount).toBe(1);
      expect(listedBot?.stats.usersCount).toBe(3);

      const botDetailRes = await app.inject({
        method: "GET",
        url: `/api/v1/bots/${bot.id}`,
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(botDetailRes.statusCode).toBe(200);
      const detailedBot = botDetailRes.json<{
        bot: { stats: { adminsCount: number; usersCount: number } };
      }>().bot;
      expect(detailedBot.stats.adminsCount).toBe(1);
      expect(detailedBot.stats.usersCount).toBe(3);

      // Permanent purge with ?purge=true
      const purgeRes = await app.inject({
        method: "DELETE",
        url: `/api/v1/bots/${bot.id}?purge=true`,
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(purgeRes.statusCode).toBe(200);
      const dbBotPurged = await prisma.bot.findUnique({ where: { id: bot.id } });
      expect(dbBotPurged).toBeNull();
    });
  });

  describe("4. Templates & Settings Configuration", () => {
    it("should list templates and apply ready presets", async () => {
      const token = await getAdminToken();

      const templatesRes = await app.inject({
        method: "GET",
        url: "/api/v1/templates",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(templatesRes.statusCode).toBe(200);
      const templates = templatesRes.json<{ templates: Array<{ id: string }> }>().templates;
      expect(templates.some((t) => t.id === "education_center")).toBe(true);
      expect(templates.some((t) => t.id === "barbershop_2masters")).toBe(true);

      // Platform Settings GET and PUT
      const settingsGetRes = await app.inject({
        method: "GET",
        url: "/api/v1/settings",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(settingsGetRes.statusCode).toBe(200);

      const settingsPutRes = await app.inject({
        method: "PUT",
        url: "/api/v1/settings",
        headers: { Authorization: `Bearer ${token}` },
        payload: {
          paymentDetails: "8600 1234 5678 9999 (Uzcard)",
          supportContact: "@pilot_support",
          maintenanceMode: false,
        },
      });
      expect(settingsPutRes.statusCode).toBe(200);
      const updated = settingsPutRes.json<{ settings: { paymentDetails: string } }>().settings;
      expect(updated.paymentDetails).toBe("8600 1234 5678 9999 (Uzcard)");
    });
  });

  describe("5. QuickBook Manual Booking & Clarification 1 (Nullable BigInt, source MANUAL)", () => {
    it("should create manual booking with customerTgId = null and source = MANUAL", async () => {
      const token = await getAdminToken();

      const tenant = await prisma.tenant.create({
        data: { clientName: "QuickBook Pilot", contactPhone: "+998901112233" },
      });

      const botRes = await app.inject({
        method: "POST",
        url: "/api/v1/bots",
        headers: { Authorization: `Bearer ${token}` },
        payload: {
          tenantId: tenant.id,
          botType: "QUICKBOOK",
          botToken: "987654321:QuickBookManualBotToken",
        },
      });
      const botId = botRes.json<{ bot: { id: string } }>().bot.id;

      // Apply Barbershop 2 Masters preset
      await app.inject({
        method: "POST",
        url: `/api/v1/bots/${botId}/apply-template`,
        headers: { Authorization: `Bearer ${token}` },
        payload: { templateId: "barbershop_2masters" },
      });

      // Target slot: next Monday at 12:00
      const targetDate = new Date();
      targetDate.setDate(targetDate.getDate() + 2);
      targetDate.setHours(12, 0, 0, 0);

      // Create manual booking via Admin API
      const bookingRes = await app.inject({
        method: "POST",
        url: `/api/v1/bots/${botId}/bookings`,
        headers: { Authorization: `Bearer ${token}` },
        payload: {
          serviceId: "srv_haircut",
          staffId: "master_alisher",
          slotTime: targetDate.toISOString(),
          customerName: "Ручной Клиент (Телефон)",
          customerPhone: "+998901234567",
        },
      });

      expect(bookingRes.statusCode).toBe(201);
      const bookingData = bookingRes.json<{ booking: { id: string; customerTgId: string | null; source: string } }>().booking;

      // Clarification 1 verification:
      expect(bookingData.customerTgId).toBeNull();
      expect(bookingData.source).toBe("MANUAL");

      // Verify in DB directly
      const dbBooking = await prisma.booking.findUnique({ where: { id: bookingData.id } });
      expect(dbBooking).not.toBeNull();
      expect(dbBooking?.customerTgId).toBeNull();
      expect(dbBooking?.source).toBe("MANUAL");

      // Attempt to book same slot -> must fail with 409 SLOT_TAKEN
      const conflictRes = await app.inject({
        method: "POST",
        url: `/api/v1/bots/${botId}/bookings`,
        headers: { Authorization: `Bearer ${token}` },
        payload: {
          serviceId: "srv_haircut",
          staffId: "master_alisher",
          slotTime: targetDate.toISOString(),
          customerName: "Второй Клиент",
          customerPhone: "+998907654321",
        },
      });
      expect(conflictRes.statusCode).toBe(409);

      // Cancel booking
      const cancelRes = await app.inject({
        method: "DELETE",
        url: `/api/v1/bots/${botId}/bookings/${bookingData.id}`,
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(cancelRes.statusCode).toBe(200);
      const cancelledDb = await prisma.booking.findUnique({ where: { id: bookingData.id } });
      expect(cancelledDb?.status).toBe("CANCELLED");
    });
  });

  describe("6. Billing, Receipts & Clarification 2 (Atomic Pending Limit)", () => {
    it("should prevent duplicate PENDING receipts under transaction lock", async () => {
      const token = await getAdminToken();

      const tenant = await prisma.tenant.create({
        data: { clientName: "Billing Tenant", contactPhone: "+998907776655" },
      });

      const botRes = await app.inject({
        method: "POST",
        url: "/api/v1/bots",
        headers: { Authorization: `Bearer ${token}` },
        payload: {
          tenantId: tenant.id,
          botType: "QUICKBOOK",
          botToken: "111222333:BillingReceiptBotToken",
        },
      });
      const botId = botRes.json<{ bot: { id: string } }>().bot.id;

      // Submit first receipt
      const receipt1 = await submitPaymentReceipt({
        prisma,
        redis,
        botId,
        submittedByTgId: 10001,
        kind: "TEXT",
        textNote: "TX123456",
        months: 1,
        amountUzs: 150000,
      });
      expect(receipt1.receipt.status).toBe("PENDING");

      // Clarification 2 verification: Second PENDING receipt for same bot must be rejected
      await expect(
        submitPaymentReceipt({
          prisma,
          redis,
          botId,
          submittedByTgId: 10001,
          kind: "TEXT",
          textNote: "TX999999",
          months: 1,
          amountUzs: 150000,
        }),
      ).rejects.toThrow("PENDING_RECEIPT_EXISTS");

      // Approve first receipt via Admin API
      const approveRes = await app.inject({
        method: "POST",
        url: `/api/v1/receipts/${receipt1.receipt.id}/approve`,
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(approveRes.statusCode).toBe(200);

      const approvedDb = await prisma.paymentReceipt.findUnique({
        where: { id: receipt1.receipt.id },
      });
      expect(approvedDb?.status).toBe("APPROVED");

      // After approval, another receipt can be submitted
      const receipt2 = await submitPaymentReceipt({
        prisma,
        redis,
        botId,
        submittedByTgId: 10001,
        kind: "TEXT",
        textNote: "TX777777",
        months: 1,
        amountUzs: 150000,
      });
      expect(receipt2.receipt.status).toBe("PENDING");

      // Reject second receipt via Admin API
      const rejectRes = await app.inject({
        method: "POST",
        url: `/api/v1/receipts/${receipt2.receipt.id}/reject`,
        headers: { Authorization: `Bearer ${token}` },
        payload: { reason: "Чек не читается" },
      });
      expect(rejectRes.statusCode).toBe(200);
      const rejectedDb = await prisma.paymentReceipt.findUnique({
        where: { id: receipt2.receipt.id },
      });
      expect(rejectedDb?.status).toBe("REJECTED");
      expect(rejectedDb?.rejectionReason).toBe("Чек не читается");
    });
  });

  describe("7. Analytics Dashboard & Clarification 3 (Normalized MRR vs Cash Collected)", () => {
    it("should compute normalized MRR from active recurring subscriptions and track cash separately", async () => {
      const token = await getAdminToken();

      const tenant = await prisma.tenant.create({
        data: { clientName: "Analytics Tenant", contactPhone: "+998903332211" },
      });

      const botRes = await app.inject({
        method: "POST",
        url: "/api/v1/bots",
        headers: { Authorization: `Bearer ${token}` },
        payload: {
          tenantId: tenant.id,
          botType: "QUICKBOOK",
          botToken: "444555666:AnalyticsBotToken",
        },
      });
      const botId = botRes.json<{ bot: { id: string } }>().bot.id;

      // Create an approved receipt: 3 months for 450,000 UZS
      const futureDate = new Date();
      futureDate.setMonth(futureDate.getMonth() + 3);

      await prisma.subscription.update({
        where: { botId },
        data: {
          status: "ACTIVE",
          paidUntil: futureDate,
        },
      });

      await prisma.paymentReceipt.create({
        data: {
          botId,
          submittedByTgId: 55555n,
          kind: "TEXT",
          textNote: "TX_ANALYTICS",
          months: 3,
          amount: 450000,
          grantedUntil: futureDate,
          prevStatus: "TRIAL",
          status: "APPROVED",
          reviewedAt: new Date(),
        },
      });

      const dashRes = await app.inject({
        method: "GET",
        url: "/api/v1/analytics/dashboard",
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(dashRes.statusCode).toBe(200);
      const body = dashRes.json<{
        metrics: {
          normalizedMrr: number;
          cashCollectedTotal: number;
          cashCollectedThisMonth: number;
          activeSubscriptionsCount: number;
          botsTotal: number;
        };
      }>();

      // Clarification 3 verification:
      // Normalized MRR = 450,000 / 3 = 150,000 UZS/month
      expect(body.metrics.normalizedMrr).toBe(150000);
      // Cash Collected = total 450,000 UZS paid
      expect(body.metrics.cashCollectedTotal).toBe(450000);
      expect(body.metrics.cashCollectedThisMonth).toBe(450000);
      expect(body.metrics.activeSubscriptionsCount).toBe(1);
    });
  });
});
