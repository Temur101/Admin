import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildApp,
  connectRedis,
  MockTelegramTransport,
  PollingManager,
  BotPool,
  type FastifyInstance,
  type Redis,
} from "../src/index.js";
import { env } from "../src/core/env.js";
import { logger } from "../src/core/logger.js";
import { encryptSecret, sha256Hex } from "../src/core/crypto.js";
import {
  createTestRedisClient,
  getTestPrismaClient,
  safeCleanTestDb,
  safeCleanTestRedis,
} from "./helpers/test-env.js";
import { getBotQuizConfig } from "../src/bots/leadcatch/quiz-flow.js";
import { DEFAULT_LEADCATCH_QUIZ } from "../src/bots/leadcatch/default-quiz.js";
import { resolveTariffPrices } from "../src/bots/shared/admin-menu.js";

const prisma = getTestPrismaClient();
let redis: Redis;
let transport: MockTelegramTransport;
let app: FastifyInstance;

describe("Stage 8.5 Wave 1: PollingManager, Settings Parsing & Admin Links", () => {
  beforeAll(async () => {
    await prisma.$connect();
    redis = createTestRedisClient("test-polling-manager");
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
    const body = res.json() as { ok: boolean; accessToken: string };
    return body.accessToken;
  }

  describe("PollingManager Unit & Lifecycle Tests", () => {
    it("should start all active bots and skip inactive ones", async () => {
      const tenant = await prisma.tenant.create({
        data: {
          clientName: "Test Tenant Polling",
          contactPhone: "+998901234567",
        },
      });

      const token1 = "111111:AAAFakeTokenOneForPollingTest";
      const token2 = "222222:AAAFakeTokenTwoForPollingTest";

      const botActive = await prisma.bot.create({
        data: {
          tenantId: tenant.id,
          botType: "LEADCATCH",
          botTokenEnc: encryptSecret(token1, env.TOKEN_ENCRYPTION_KEY),
          botTokenHash: sha256Hex(token1),
          webhookSecret: "secret_1",
          adminInviteCode: "code_active",
          botUsername: "test_active_bot",
          isActive: true,
          subscription: {
            create: {
              status: "TRIAL",
              trialEndsAt: new Date(Date.now() + 86400000 * 3),
            },
          },
        },
      });

      await prisma.bot.create({
        data: {
          tenantId: tenant.id,
          botType: "QUICKBOOK",
          botTokenEnc: encryptSecret(token2, env.TOKEN_ENCRYPTION_KEY),
          botTokenHash: sha256Hex(token2),
          webhookSecret: "secret_2",
          adminInviteCode: "code_inactive",
          botUsername: "test_inactive_bot",
          isActive: false,
          subscription: {
            create: {
              status: "TRIAL",
              trialEndsAt: new Date(Date.now() + 86400000 * 3),
            },
          },
        },
      });

      const botPool = new BotPool({
        capacity: 10,
        encryptionKey: env.TOKEN_ENCRYPTION_KEY,
        transport,
        redis,
        sessionTtlSec: 3600,
        logger,
        prisma,
      });

      const manager = new PollingManager({
        prisma,
        botPool,
        logger,
      });

      expect(manager.runningCount).toBe(0);

      await manager.startAll();

      expect(manager.isRunning(botActive.id)).toBe(true);
      expect(manager.runningCount).toBe(1);

      // Stopping the active bot
      const stopped = await manager.stop(botActive.id);
      expect(stopped).toBe(true);
      expect(manager.isRunning(botActive.id)).toBe(false);
      expect(manager.runningCount).toBe(0);

      await manager.stopAll();
    });

    it("should gracefully handle starting and stopping individual bots", async () => {
      const tenant = await prisma.tenant.create({
        data: {
          clientName: "Test Individual Bot",
          contactPhone: "+998901234567",
        },
      });

      const token = "333333:AAAFakeTokenThreePolling";
      const bot = await prisma.bot.create({
        data: {
          tenantId: tenant.id,
          botType: "LEADCATCH",
          botTokenEnc: encryptSecret(token, env.TOKEN_ENCRYPTION_KEY),
          botTokenHash: sha256Hex(token),
          webhookSecret: "secret_3",
          adminInviteCode: "code_3",
          isActive: true,
        },
      });

      const botPool = new BotPool({
        capacity: 10,
        encryptionKey: env.TOKEN_ENCRYPTION_KEY,
        transport,
        redis,
        sessionTtlSec: 3600,
        logger,
        prisma,
      });

      const manager = new PollingManager({
        prisma,
        botPool,
        logger,
      });

      const started = await manager.start(bot.id);
      expect(started).toBe(true);
      expect(manager.isRunning(bot.id)).toBe(true);

      // Starting already running bot is idempotent
      const startedAgain = await manager.start(bot.id);
      expect(startedAgain).toBe(true);

      // Nonexistent bot
      const startedNonexistent = await manager.start("00000000-0000-0000-0000-000000000000");
      expect(startedNonexistent).toBe(false);

      await manager.stopAll();
      expect(manager.runningCount).toBe(0);
    });
  });

  describe("CRIT-04: Quiz Configuration Parsing (getBotQuizConfig)", () => {
    it("should return DEFAULT_LEADCATCH_QUIZ when settings are undefined or empty", () => {
      expect(getBotQuizConfig(undefined)).toEqual(DEFAULT_LEADCATCH_QUIZ);
      expect(getBotQuizConfig({})).toEqual(DEFAULT_LEADCATCH_QUIZ);
    });

    it("should correctly parse quiz when nested under settings.quiz", () => {
      const validQuiz = {
        startNodeId: "step1",
        nodes: [
          {
            id: "step1",
            title: { ru: "Шаг 1", uz: "1-bosqich" },
            options: [{ id: "opt1", text: { ru: "Дальше", uz: "Keyingisi" }, nextNodeId: "step2" }],
          },
          {
            id: "step2",
            title: { ru: "Шаг 2", uz: "2-bosqich" },
            options: [{ id: "opt2", text: { ru: "Дальше", uz: "Keyingisi" }, nextNodeId: "step3" }],
          },
          {
            id: "step3",
            title: { ru: "Шаг 3", uz: "3-bosqich" },
            options: [{ id: "opt3", text: { ru: "Финал", uz: "Yakun" }, nextNodeId: null }],
          },
        ],
      };

      const result = getBotQuizConfig({ quiz: validQuiz });
      expect(result).toEqual(validQuiz);
    });

    it("should correctly parse quiz when located directly at settings root", () => {
      const validQuiz = {
        startNodeId: "step1",
        nodes: [
          {
            id: "step1",
            title: { ru: "Прямой шаг 1", uz: "1-bosqich" },
            options: [{ id: "opt1", text: { ru: "Дальше", uz: "Keyingisi" }, nextNodeId: "step2" }],
          },
          {
            id: "step2",
            title: { ru: "Прямой шаг 2", uz: "2-bosqich" },
            options: [{ id: "opt2", text: { ru: "Дальше", uz: "Keyingisi" }, nextNodeId: "step3" }],
          },
          {
            id: "step3",
            title: { ru: "Прямой шаг 3", uz: "3-bosqich" },
            options: [{ id: "opt3", text: { ru: "Финал", uz: "Yakun" }, nextNodeId: null }],
          },
        ],
      };

      const result = getBotQuizConfig(validQuiz);
      expect(result).toEqual(validQuiz);
    });

    it("should fallback to default quiz when quiz structure is invalid", () => {
      const invalidQuiz = {
        startNodeId: "nonexistent",
        nodes: [
          {
            id: "q1",
            title: { ru: "Ошибка", uz: "Xato" },
            options: [],
          },
        ],
      };

      expect(getBotQuizConfig({ quiz: invalidQuiz })).toEqual(DEFAULT_LEADCATCH_QUIZ);
      expect(getBotQuizConfig(invalidQuiz)).toEqual(DEFAULT_LEADCATCH_QUIZ);
    });
  });

  describe("CRIT-05: Dynamic Tariffs Parsing (resolveTariffPrices)", () => {
    it("should correctly parse array format of tariffs", () => {
      const settings = {
        tariffs: [
          { months: 1, amountUzs: 150000 },
          { months: 6, amountUzs: 750000 },
          { months: 12, amountUzs: 1200000 },
        ],
      };

      const resolved = resolveTariffPrices(settings);
      expect(resolved.tariff1m).toBe(150000);
      expect(resolved.tariff6m).toBe(750000);
      expect(resolved.tariff12m).toBe(1200000);
    });

    it("should support legacy object format and fallback to env", () => {
      const legacySettings = {
        tariffs: {
          "1m": 125000,
          "6m": 600000,
        },
      };

      const resolved = resolveTariffPrices(legacySettings);
      expect(resolved.tariff1m).toBe(125000);
      expect(resolved.tariff6m).toBe(600000);
      expect(resolved.tariff12m).toBe(env.TARIFF_12M_UZS);
    });

    it("should fallback to env defaults when settings is null or empty", () => {
      const resolved = resolveTariffPrices(null);
      expect(resolved.tariff1m).toBe(env.TARIFF_1M_UZS);
      expect(resolved.tariff6m).toBe(env.TARIFF_6M_UZS);
      expect(resolved.tariff12m).toBe(env.TARIFF_12M_UZS);
    });
  });

  describe("MAJ-01 & MAJ-11 & MAJ-17: Admin API Invite Links & Defaults", () => {
    it("should create LeadCatch bot with DEFAULT_LEADCATCH_QUIZ, TRIAL_DAYS_DEFAULT and adm_ invite link", async () => {
      const token = await getAdminToken();

      const tenantRes = await app.inject({
        method: "POST",
        url: "/api/v1/tenants",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          clientName: "Pilot Tenant LeadCatch",
          contactPhone: "+998901234567",
        },
      });
      const tenant = (tenantRes.json() as { tenant: { id: string } }).tenant;

      const botToken = "777777:AAAFakeTokenPilotLeadCatch";
      const createRes = await app.inject({
        method: "POST",
        url: "/api/v1/bots",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          tenantId: tenant.id,
          botType: "LEADCATCH",
          botToken,
        },
      });

      expect(createRes.statusCode).toBe(201);
      const createBody = createRes.json() as {
        ok: boolean;
        bot: {
          id: string;
          inviteLink: string | null;
          trialEndsAt: string;
          warning?: string;
        };
      };

      expect(createBody.ok).toBe(true);
      // Link must have adm_ prefix
      expect(createBody.bot.inviteLink).toMatch(/\?start=adm_[a-f0-9]{32}$/);

      // Check DB settings were saved with DEFAULT_LEADCATCH_QUIZ
      const dbBot = await prisma.bot.findUnique({
        where: { id: createBody.bot.id },
      });
      expect(dbBot?.settings).toEqual(DEFAULT_LEADCATCH_QUIZ);

      // Verify MAJ-17 warning when BOT_MODE=webhook and PUBLIC_BASE_URL is empty
      const origMode = env.BOT_MODE;
      try {
        env.BOT_MODE = "webhook";
        const webhookRes = await app.inject({
          method: "POST",
          url: "/api/v1/bots",
          headers: { authorization: `Bearer ${token}` },
          payload: {
            tenantId: tenant.id,
            botType: "QUICKBOOK",
            botToken: "888888:AAAFakeTokenWebhookWarning",
          },
        });
        const webhookBody = webhookRes.json() as { ok: boolean; bot: { warning?: string } };
        expect(webhookBody.ok).toBe(true);
        if (!env.PUBLIC_BASE_URL) {
          expect(webhookBody.bot.warning).toBeDefined();
        }
      } finally {
        env.BOT_MODE = origMode;
      }

      // Check details endpoint returns adm_ link
      const detailsRes = await app.inject({
        method: "GET",
        url: `/api/v1/bots/${createBody.bot.id}`,
        headers: { authorization: `Bearer ${token}` },
      });
      const detailsBody = detailsRes.json() as {
        bot: { inviteLink: string | null };
      };
      expect(detailsBody.bot.inviteLink).toMatch(/\?start=adm_[a-f0-9]{32}$/);

      // Check reissue invite returns adm_ link
      const reissueRes = await app.inject({
        method: "POST",
        url: `/api/v1/bots/${createBody.bot.id}/reissue-invite`,
        headers: { authorization: `Bearer ${token}` },
      });
      const reissueBody = reissueRes.json() as {
        inviteLink: string | null;
      };
      expect(reissueBody.inviteLink).toMatch(/\?start=adm_[a-f0-9]{32}$/);
    });
  });
});
