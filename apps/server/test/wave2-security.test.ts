import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  buildApp,
  connectRedis,
  MockTelegramTransport,
  LruCache,
  saveReceiptImage,
  encryptSecret,
  BackgroundWorkerScheduler,
  WebhookInboxService,
  BotPool,
  TenantResolver,
  UpdateDeduplicator,
  type FastifyInstance,
  type Redis,
  type ResolvedBot,
} from "../src/index.js";
import { env } from "../src/core/env.js";
import { logger } from "../src/core/logger.js";
import {
  createTestRedisClient,
  getTestPrismaClient,
  safeCleanTestDb,
  safeCleanTestRedis,
} from "./helpers/test-env.js";

const prisma = getTestPrismaClient();
let redis: Redis;
let transport: MockTelegramTransport;
let app: FastifyInstance;

describe("Wave 2 Security, Recovery and Memory Audits", () => {
  beforeAll(async () => {
    await prisma.$connect();
    redis = createTestRedisClient("test-wave2-security");
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

  async function getTokens(): Promise<{ accessToken: string; refreshToken: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: "10.10.1.1",
      payload: {
        email: env.SUPERADMIN_EMAIL,
        password: env.SUPERADMIN_PASSWORD,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ ok: boolean; accessToken: string }>();
    const cookies = res.cookies;
    const refreshCookie = cookies.find((c) => c.name === "refreshToken");
    expect(refreshCookie).toBeDefined();
    return {
      accessToken: body.accessToken,
      refreshToken: refreshCookie?.value ?? "",
    };
  }

  describe("CRIT-02: JWT access vs refresh security separation", () => {
    it("should issue distinct access and refresh tokens with correct tokenType", async () => {
      const { accessToken, refreshToken } = await getTokens();

      const decodedAccess = app.jwt.verify<{ adminId: string; email: string; tokenType: string }>(
        accessToken,
        { key: env.JWT_ACCESS_SECRET },
      );
      expect(decodedAccess.tokenType).toBe("access");

      const decodedRefresh = app.jwt.verify<{ adminId: string; email: string; tokenType: string }>(
        refreshToken,
        { key: env.JWT_REFRESH_SECRET },
      );
      expect(decodedRefresh.tokenType).toBe("refresh");
    });

    it("should reject refresh token when used on access-protected endpoint", async () => {
      const { refreshToken } = await getTokens();

      const res = await app.inject({
        method: "GET",
        url: "/api/v1/auth/me",
        headers: {
          Authorization: `Bearer ${refreshToken}`,
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it("should reject access token when used on refresh endpoint", async () => {
      const { accessToken } = await getTokens();

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        cookies: {
          refreshToken: accessToken,
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it("should rotate access token with valid refresh token", async () => {
      const { refreshToken } = await getTokens();

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        cookies: {
          refreshToken,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ ok: boolean; accessToken: string }>();
      expect(body.ok).toBe(true);
      expect(body.accessToken).toBeDefined();

      const verified = app.jwt.verify<{ tokenType: string }>(body.accessToken, {
        key: env.JWT_ACCESS_SECRET,
      });
      expect(verified.tokenType).toBe("access");
    });

    it("should revoke both accessToken and refreshToken in Redis upon logout", async () => {
      const { accessToken, refreshToken } = await getTokens();

      // Verify accessToken works before logout
      const meBefore = await app.inject({
        method: "GET",
        url: "/api/v1/auth/me",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
      expect(meBefore.statusCode).toBe(200);

      // Logout passing both Authorization header and refreshToken cookie
      const logoutRes = await app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        cookies: {
          refreshToken,
        },
      });
      expect(logoutRes.statusCode).toBe(200);

      // Old accessToken must immediately fail with 401
      const meAfter = await app.inject({
        method: "GET",
        url: "/api/v1/auth/me",
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });
      expect(meAfter.statusCode).toBe(401);

      // Old refreshToken must fail with 401 on /api/v1/auth/refresh
      const refreshAfter = await app.inject({
        method: "POST",
        url: "/api/v1/auth/refresh",
        cookies: {
          refreshToken,
        },
      });
      expect(refreshAfter.statusCode).toBe(401);
    });
  });

  describe("CRIT-01, MAJ-10 & CRIT-07: Receipts storage, traversal defense & auth", () => {
    it("saveReceiptImage should return relative filename", async () => {
      const dummyBuffer = Buffer.from("fake-image-content");
      const uploadDir = env.UPLOAD_DIR;
      const fileName = await saveReceiptImage(dummyBuffer, uploadDir, "webp");

      expect(path.isAbsolute(fileName)).toBe(false);
      expect(fileName).toMatch(/^[0-9a-f-]+\.webp$/);

      const filePath = path.resolve(uploadDir, fileName);
      await fs.unlink(filePath).catch(() => {});
    });

    it("should serve receipt image authenticated via query token (?token=)", async () => {
      const { accessToken } = await getTokens();
      const uploadDir = path.resolve(env.UPLOAD_DIR);
      await fs.mkdir(uploadDir, { recursive: true });

      const testFileName = `test-receipt-${Date.now()}.png`;
      const fullPath = path.resolve(uploadDir, testFileName);
      await fs.writeFile(fullPath, Buffer.from("dummy-png-data"));

      const tenant = await prisma.tenant.create({
        data: { clientName: "Receipt Auth Tenant", contactPhone: "+998901112233" },
      });
      const bot = await prisma.bot.create({
        data: {
          tenantId: tenant.id,
          botType: "LEADCATCH",
          botTokenEnc: "dummy_enc",
          botTokenHash: "dummy_hash_receipt",
          webhookSecret: "secret_rcpt",
          adminInviteCode: "adm_rcpt_1",
        },
      });
      const receipt = await prisma.paymentReceipt.create({
        data: {
          botId: bot.id,
          submittedByTgId: 777123,
          kind: "PHOTO",
          imagePath: testFileName,
          months: 1,
          amount: 100000,
          status: "PENDING",
          prevStatus: "TRIAL",
          grantedUntil: new Date(Date.now() + 86400000 * 30),
        },
      });

      // Query with valid access token
      const okRes = await app.inject({
        method: "GET",
        url: `/api/v1/receipts/${receipt.id}/image?token=${encodeURIComponent(accessToken)}`,
      });
      expect(okRes.statusCode).toBe(200);
      expect(okRes.headers["content-type"]).toBe("image/png");

      // Query with invalid token -> 401
      const unauthRes = await app.inject({
        method: "GET",
        url: `/api/v1/receipts/${receipt.id}/image?token=invalid.jwt.token`,
      });
      expect(unauthRes.statusCode).toBe(401);

      // Logout and verify revoked accessToken fails for both ?token= and Authorization header
      await app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      const revokedQueryRes = await app.inject({
        method: "GET",
        url: `/api/v1/receipts/${receipt.id}/image?token=${encodeURIComponent(accessToken)}`,
      });
      expect(revokedQueryRes.statusCode).toBe(401);

      const revokedHeaderRes = await app.inject({
        method: "GET",
        url: `/api/v1/receipts/${receipt.id}/image`,
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      expect(revokedHeaderRes.statusCode).toBe(401);

      // Clean up file
      await fs.unlink(fullPath).catch(() => {});
    });

    it("should support webp mime type", async () => {
      const { accessToken } = await getTokens();
      const uploadDir = path.resolve(env.UPLOAD_DIR);
      await fs.mkdir(uploadDir, { recursive: true });

      const testFileName = `test-receipt-${Date.now()}.webp`;
      const fullPath = path.resolve(uploadDir, testFileName);
      await fs.writeFile(fullPath, Buffer.from("dummy-webp-data"));

      const tenant = await prisma.tenant.create({
        data: { clientName: "Webp Tenant", contactPhone: "+998901112234" },
      });
      const bot = await prisma.bot.create({
        data: {
          tenantId: tenant.id,
          botType: "QUICKBOOK",
          botTokenEnc: "dummy_enc_webp",
          botTokenHash: "dummy_hash_webp",
          webhookSecret: "secret_webp",
          adminInviteCode: "adm_rcpt_2",
        },
      });
      const receipt = await prisma.paymentReceipt.create({
        data: {
          botId: bot.id,
          submittedByTgId: 777124,
          kind: "PHOTO",
          imagePath: testFileName,
          months: 6,
          amount: 500000,
          status: "PENDING",
          prevStatus: "TRIAL",
          grantedUntil: new Date(Date.now() + 86400000 * 180),
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/receipts/${receipt.id}/image?token=${encodeURIComponent(accessToken)}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toBe("image/webp");

      await fs.unlink(fullPath).catch(() => {});
    });

    it("should reject path traversal attempts and missing files with 404", async () => {
      const { accessToken } = await getTokens();

      const tenant = await prisma.tenant.create({
        data: { clientName: "Traversal Tenant", contactPhone: "+998901112235" },
      });
      const bot = await prisma.bot.create({
        data: {
          tenantId: tenant.id,
          botType: "LEADCATCH",
          botTokenEnc: "dummy_enc_trav",
          botTokenHash: "dummy_hash_trav",
          webhookSecret: "secret_trav",
          adminInviteCode: "adm_rcpt_3",
        },
      });
      const maliciousReceipt = await prisma.paymentReceipt.create({
        data: {
          botId: bot.id,
          submittedByTgId: 777125,
          kind: "PHOTO",
          imagePath: "../../package.json",
          months: 1,
          amount: 100000,
          status: "PENDING",
          prevStatus: "TRIAL",
          grantedUntil: new Date(Date.now() + 86400000 * 30),
        },
      });

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/receipts/${maliciousReceipt.id}/image?token=${encodeURIComponent(accessToken)}`,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ ok: false, error: "Receipt image file not found on disk" });
    });
  });

  describe("CRIT-06: BotPool & LruCache eviction cleanup", () => {
    it("LruCache should invoke onEvict callback when capacity exceeded", () => {
      const evicted: Array<{ key: string; value: number }> = [];
      const cache = new LruCache<string, number>(2, (key, value) => {
        evicted.push({ key, value });
      });

      cache.set("a", 1);
      cache.set("b", 2);
      expect(cache.size).toBe(2);
      expect(evicted.length).toBe(0);

      // Inserting 3rd entry evicts oldest "a"
      cache.set("c", 3);
      expect(cache.size).toBe(2);
      expect(evicted.length).toBe(1);
      expect(evicted[0]).toEqual({ key: "a", value: 1 });
    });

    it("BotPool should not leak metadata and tokens when LRU evicts", () => {
      const pool = new BotPool({
        capacity: 1,
        encryptionKey: env.TOKEN_ENCRYPTION_KEY,
        transport,
        redis,
        sessionTtlSec: 60,
        logger,
        prisma,
      });

      const bot1: ResolvedBot = {
        id: "bot_111",
        tenantId: "t1",
        botType: "LEADCATCH",
        botTokenEnc: encryptSecret("111111:token_one", env.TOKEN_ENCRYPTION_KEY),
        botTokenHash: "hash_token_1",
        webhookSecret: "s1",
        botUsername: "bot_111",
        adminInviteCode: "adm_111",
        settings: {},
        subscriptionStatus: "TRIAL",
        paidUntil: null,
        trialEndsAt: new Date().toISOString(),
      };

      const bot2: ResolvedBot = {
        id: "bot_222",
        tenantId: "t2",
        botType: "QUICKBOOK",
        botTokenEnc: encryptSecret("222222:token_two", env.TOKEN_ENCRYPTION_KEY),
        botTokenHash: "hash_token_2",
        webhookSecret: "s2",
        botUsername: "bot_222",
        adminInviteCode: "adm_222",
        settings: {},
        subscriptionStatus: "TRIAL",
        paidUntil: null,
        trialEndsAt: new Date().toISOString(),
      };

      pool.getOrCreateBot(bot1);
      expect(pool.size).toBe(1);
      expect(pool.getLatestMeta("bot_111")).toBeDefined();

      // Creating second bot with capacity 1 triggers eviction of bot_111
      pool.getOrCreateBot(bot2);
      expect(pool.size).toBe(1);
      expect(pool.getLatestMeta("bot_111")).toBeUndefined();
      expect(pool.getLatestMeta("bot_222")).toBeDefined();
    });
  });

  describe("CRIT-03: Webhook recovery in scheduler", () => {
    it("should register recovery tick and run recoverPending on scheduler tick", async () => {
      const resolver = new TenantResolver({ prisma, redis, cacheTtlSec: 600, logger });
      const pool = new BotPool({
        capacity: 10,
        encryptionKey: env.TOKEN_ENCRYPTION_KEY,
        transport,
        redis,
        sessionTtlSec: 60,
        logger,
        prisma,
        tenantResolver: resolver,
      });
      const deduplicator = new UpdateDeduplicator(redis, 60, logger);
      const inboxService = new WebhookInboxService({
        prisma,
        redis,
        botPool: pool,
        tenantResolver: resolver,
        deduplicator,
        logger,
      });

      let recoverCalls = 0;
      const originalRecover = inboxService.recoverPending.bind(inboxService);
      inboxService.recoverPending = async (batchSize?: number) => {
        recoverCalls++;
        return originalRecover(batchSize);
      };

      const scheduler = new BackgroundWorkerScheduler({
        prisma,
        redis,
        transport,
        logger,
        inboxService,
        recoveryIntervalMs: 50,
        subscriptionIntervalMs: 10_000,
        reminderIntervalMs: 10_000,
        runImmediately: true,
      });

      scheduler.start();
      expect(scheduler.running).toBe(true);

      // Trigger recovery tick explicitly
      await scheduler.triggerRecoveryTick();
      expect(recoverCalls).toBeGreaterThanOrEqual(1);

      await scheduler.stop();
      expect(scheduler.running).toBe(false);
    });
  });
});
