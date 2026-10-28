import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildApp,
  connectRedis,
  MockTelegramTransport,
  type FastifyInstance,
  type Redis,
} from "../src/index.js";
import { env } from "../src/core/env.js";
import { encryptSecret, sha256Hex } from "../src/core/crypto.js";
import {
  createTestRedisClient,
  getTestPrismaClient,
  safeCleanTestDb,
  safeCleanTestRedis,
} from "./helpers/test-env.js";
import {
  createEmptyQuickBookConfig,
  createEmptyQuizConfig,
} from "@lcqb/contracts";

const prisma = getTestPrismaClient();
let redis: Redis;
let transport: MockTelegramTransport;
let app: FastifyInstance;

describe("Bot Reset & Advanced Subscription Management Tests", () => {
  beforeAll(async () => {
    await prisma.$connect();
    redis = createTestRedisClient("test-reset-sub");
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
    return res.json<{ accessToken: string }>().accessToken;
  }

  async function createFixtureTenantAndBot(type: "LEADCATCH" | "QUICKBOOK" = "LEADCATCH") {
    const tenant = await prisma.tenant.create({
      data: {
        clientName: `Tenant ${Date.now()}`,
        contactPhone: "+998901234567",
      },
    });

    const token = `fake-token-${Date.now()}-${Math.random()}`;
    const tokenHash = sha256Hex(token);
    const tokenEnc = encryptSecret(token, env.TOKEN_ENCRYPTION_KEY);

    const initialSettings =
      type === "LEADCATCH"
        ? {
            welcomeText: { ru: "Старое приветствие" },
            questions: [{ id: "q1", text: { ru: "Вопрос 1" }, type: "text" }],
          }
        : {
            resourceType: "STAFF",
            services: [{ id: "s1", name: { ru: "Консультация" }, durationMinutes: 30 }],
            resources: [{ id: "r1", name: { ru: "Иванов" }, serviceIds: ["s1"] }],
            schedule: [],
          };

    const bot = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: type,
        botTokenHash: tokenHash,
        botTokenEnc: tokenEnc,
        webhookSecret: "secret123",
        botUsername: `test_${type.toLowerCase()}_bot`,
        settings: initialSettings,
        isActive: true,
        subscription: {
          create: {
            status: "TRIAL",
            trialEndsAt: new Date(Date.now() + 7 * 86400 * 1000),
          },
        },
      },
      include: { subscription: true },
    });

    return { tenant, bot };
  }

  describe("POST /api/v1/bots/:id/reset", () => {
    it("requires admin authentication", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/bots/00000000-0000-0000-0000-000000000000/reset",
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 404 for unknown bot", async () => {
      const token = await getAdminToken();
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/bots/00000000-0000-0000-0000-000000000000/reset",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
    });

    it("resets LeadCatch bot settings, deactivates bot, and clears only its Redis sessions", async () => {
      const token = await getAdminToken();
      const { bot } = await createFixtureTenantAndBot("LEADCATCH");
      const { bot: otherBot } = await createFixtureTenantAndBot("QUICKBOOK");

      // Set up Redis sessions for both bots
      await redis.set(`sess:${bot.id}:11111`, JSON.stringify({ step: "q1" }));
      await redis.set(`sess:${bot.id}:22222`, JSON.stringify({ step: "q2" }));
      await redis.set(`sess:${otherBot.id}:33333`, JSON.stringify({ step: "booking" }));

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/bots/${bot.id}/reset`,
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ ok: boolean; clearedSessions: number }>();
      expect(body.ok).toBe(true);
      expect(body.clearedSessions).toBe(2);

      // Verify DB state
      const updatedBot = await prisma.bot.findUniqueOrThrow({ where: { id: bot.id } });
      expect(updatedBot.isActive).toBe(false);
      expect(updatedBot.settings).toEqual(createEmptyQuizConfig());
      expect(updatedBot.botTokenHash).toBe(bot.botTokenHash);

      // Verify Redis state
      expect(await redis.get(`sess:${bot.id}:11111`)).toBeNull();
      expect(await redis.get(`sess:${bot.id}:22222`)).toBeNull();
      expect(await redis.get(`sess:${otherBot.id}:33333`)).not.toBeNull();
    });

    it("resets QuickBook bot settings preserving resourceType", async () => {
      const token = await getAdminToken();
      const { bot } = await createFixtureTenantAndBot("QUICKBOOK");

      const res = await app.inject({
        method: "POST",
        url: `/api/v1/bots/${bot.id}/reset`,
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(200);
      const updatedBot = await prisma.bot.findUniqueOrThrow({ where: { id: bot.id } });
      expect(updatedBot.isActive).toBe(false);
      expect(updatedBot.settings).toEqual(createEmptyQuickBookConfig("STAFF"));
    });
  });

  describe("Subscription management: /extend, /reduce, /trial", () => {
    it("rejects invalid days in /extend and successfully extends active period", async () => {
      const token = await getAdminToken();
      const { bot } = await createFixtureTenantAndBot("LEADCATCH");

      // 400 for 0, negative, >3650
      const invalidRes1 = await app.inject({
        method: "POST",
        url: `/api/v1/bots/${bot.id}/extend`,
        headers: { Authorization: `Bearer ${token}` },
        payload: { days: 0 },
      });
      expect(invalidRes1.statusCode).toBe(400);

      const invalidRes2 = await app.inject({
        method: "POST",
        url: `/api/v1/bots/${bot.id}/extend`,
        headers: { Authorization: `Bearer ${token}` },
        payload: { days: 5000 },
      });
      expect(invalidRes2.statusCode).toBe(400);

      // Valid extend 30 days
      const extendRes = await app.inject({
        method: "POST",
        url: `/api/v1/bots/${bot.id}/extend`,
        headers: { Authorization: `Bearer ${token}` },
        payload: { days: 30 },
      });
      expect(extendRes.statusCode).toBe(200);
      const extBody = extendRes.json<{
        ok: boolean;
        subscription: { status: string; paidUntil: string };
      }>();
      expect(extBody.subscription.status).toBe("ACTIVE");
      expect(new Date(extBody.subscription.paidUntil).getTime()).toBeGreaterThan(Date.now());
    });

    it("reduces subscription days and marks EXPIRED if target date is in the past", async () => {
      const token = await getAdminToken();
      const { bot } = await createFixtureTenantAndBot("LEADCATCH");

      // Reduce trial by 2 days
      const reduceRes1 = await app.inject({
        method: "POST",
        url: `/api/v1/bots/${bot.id}/reduce`,
        headers: { Authorization: `Bearer ${token}` },
        payload: { days: 2 },
      });
      expect(reduceRes1.statusCode).toBe(200);
      const body1 = reduceRes1.json<{
        subscription: { status: string; trialEndsAt: string };
      }>();
      expect(body1.subscription.status).toBe("TRIAL");

      // Reduce trial by 10 days -> shifts past now -> EXPIRED
      const reduceRes2 = await app.inject({
        method: "POST",
        url: `/api/v1/bots/${bot.id}/reduce`,
        headers: { Authorization: `Bearer ${token}` },
        payload: { days: 10 },
      });
      expect(reduceRes2.statusCode).toBe(200);
      const body2 = reduceRes2.json<{
        subscription: { status: string };
      }>();
      expect(body2.subscription.status).toBe("EXPIRED");
    });

    it("reduces paidUntil when bot is ACTIVE and sets EXPIRED if past", async () => {
      const token = await getAdminToken();
      const { bot } = await createFixtureTenantAndBot("LEADCATCH");

      // First extend to ACTIVE
      await app.inject({
        method: "POST",
        url: `/api/v1/bots/${bot.id}/extend`,
        headers: { Authorization: `Bearer ${token}` },
        payload: { days: 10 },
      });

      // Reduce paid subscription by 3 days
      const redRes1 = await app.inject({
        method: "POST",
        url: `/api/v1/bots/${bot.id}/reduce`,
        headers: { Authorization: `Bearer ${token}` },
        payload: { days: 3 },
      });
      expect(redRes1.statusCode).toBe(200);
      expect(redRes1.json<{ subscription: { status: string } }>().subscription.status).toBe(
        "ACTIVE",
      );

      // Reduce by 20 days -> goes to past -> EXPIRED
      const redRes2 = await app.inject({
        method: "POST",
        url: `/api/v1/bots/${bot.id}/reduce`,
        headers: { Authorization: `Bearer ${token}` },
        payload: { days: 20 },
      });
      expect(redRes2.statusCode).toBe(200);
      expect(redRes2.json<{ subscription: { status: string } }>().subscription.status).toBe(
        "EXPIRED",
      );
    });

    it("grants trial period, rejecting when paid subscription is active", async () => {
      const token = await getAdminToken();
      const { bot } = await createFixtureTenantAndBot("LEADCATCH");

      // Extend to ACTIVE
      await app.inject({
        method: "POST",
        url: `/api/v1/bots/${bot.id}/extend`,
        headers: { Authorization: `Bearer ${token}` },
        payload: { days: 30 },
      });

      // Attempt trial grant -> 409 conflict
      const trialConflict = await app.inject({
        method: "POST",
        url: `/api/v1/bots/${bot.id}/trial`,
        headers: { Authorization: `Bearer ${token}` },
        payload: { days: 7 },
      });
      expect(trialConflict.statusCode).toBe(409);

      // Reduce paidUntil until EXPIRED
      await app.inject({
        method: "POST",
        url: `/api/v1/bots/${bot.id}/reduce`,
        headers: { Authorization: `Bearer ${token}` },
        payload: { days: 40 },
      });

      // Now grant trial period
      const trialOk = await app.inject({
        method: "POST",
        url: `/api/v1/bots/${bot.id}/trial`,
        headers: { Authorization: `Bearer ${token}` },
        payload: { days: 14 },
      });
      expect(trialOk.statusCode).toBe(200);
      const trialBody = trialOk.json<{
        subscription: { status: string; trialEndsAt: string; paidUntil: null };
      }>();
      expect(trialBody.subscription.status).toBe("TRIAL");
      expect(trialBody.subscription.paidUntil).toBeNull();
      expect(new Date(trialBody.subscription.trialEndsAt).getTime()).toBeGreaterThan(Date.now());
    });

    it("immediately invalidates Redis bot cache upon /extend, /reduce, /trial, and /unblock", async () => {
      const token = await getAdminToken();
      const { bot } = await createFixtureTenantAndBot("LEADCATCH");

      const hashKey = `bot:hash:${bot.botTokenHash}`;
      const idKey = `bot:id:${bot.id}`;

      // Seed stale cache entries (simulating 10-minute TTL cache)
      await redis.set(hashKey, JSON.stringify({ subscriptionStatus: "EXPIRED" }), "EX", 600);
      await redis.set(idKey, JSON.stringify({ subscriptionStatus: "EXPIRED" }), "EX", 600);

      const extendRes = await app.inject({
        method: "POST",
        url: `/api/v1/bots/${bot.id}/extend`,
        headers: { Authorization: `Bearer ${token}` },
        payload: { days: 10 },
      });
      expect(extendRes.statusCode).toBe(200);
      expect(await redis.get(hashKey)).toBeNull();
      expect(await redis.get(idKey)).toBeNull();

      // Re-seed cache and test /reduce invalidation
      await redis.set(hashKey, "stale", "EX", 600);
      await redis.set(idKey, "stale", "EX", 600);
      const reduceRes = await app.inject({
        method: "POST",
        url: `/api/v1/bots/${bot.id}/reduce`,
        headers: { Authorization: `Bearer ${token}` },
        payload: { days: 20 },
      });
      expect(reduceRes.statusCode).toBe(200);
      expect(await redis.get(hashKey)).toBeNull();
      expect(await redis.get(idKey)).toBeNull();

      // Re-seed cache and test /trial invalidation
      await redis.set(hashKey, "stale", "EX", 600);
      await redis.set(idKey, "stale", "EX", 600);
      const trialRes = await app.inject({
        method: "POST",
        url: `/api/v1/bots/${bot.id}/trial`,
        headers: { Authorization: `Bearer ${token}` },
        payload: { days: 5 },
      });
      expect(trialRes.statusCode).toBe(200);
      expect(await redis.get(hashKey)).toBeNull();
      expect(await redis.get(idKey)).toBeNull();

      // Re-seed cache and test /unblock invalidation
      await redis.set(hashKey, "stale", "EX", 600);
      await redis.set(idKey, "stale", "EX", 600);
      const unblockRes = await app.inject({
        method: "POST",
        url: `/api/v1/bots/${bot.id}/unblock`,
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(unblockRes.statusCode).toBe(200);
      expect(await redis.get(hashKey)).toBeNull();
      expect(await redis.get(idKey)).toBeNull();
    });
  });
});
