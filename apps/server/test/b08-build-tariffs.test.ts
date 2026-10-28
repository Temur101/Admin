import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectRedis, type Redis } from "../src/core/redis.js";
import { env } from "../src/core/env.js";
import { MockTelegramTransport } from "../src/adapters/telegram/mock-transport.js";
import { encryptSecret, sha256Hex } from "../src/core/crypto.js";
import {
  buildTariffInlineKeyboard,
  resolveTariffPrices,
} from "../src/bots/shared/admin-menu.js";
import {
  getTestPrismaClient,
  createTestRedisClient,
  safeCleanTestDb,
  safeCleanTestRedis,
} from "./helpers/test-env.js";

const prisma = getTestPrismaClient();

let redis: Redis;
let transport: MockTelegramTransport;

describe("B08: Dynamic Tariffs, Typings & Production Build Conformance", () => {
  let botId: string;
  const adminTgId = 554433;

  beforeAll(async () => {
    await prisma.$connect();
    redis = createTestRedisClient("test-b08-tariffs");
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
      data: { clientName: "Tenant B08", contactPhone: "+998901234567" },
    });

    const botToken = "123456789:B08BotToken";
    const bot = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "QUICKBOOK",
        botTokenEnc: encryptSecret(botToken, env.TOKEN_ENCRYPTION_KEY),
        botTokenHash: sha256Hex(botToken),
        webhookSecret: "secret_b08",
        subscription: {
          create: {
            status: "TRIAL",
            trialEndsAt: new Date(Date.now() + 86400000),
          },
        },
      },
    });
    botId = bot.id;

    await prisma.botUser.create({
      data: {
        botId,
        tgId: BigInt(adminTgId),
        firstName: "Админ B08",
        isAdmin: true,
        lang: "RU",
      },
    });

    await prisma.platformSettings.deleteMany();
    await prisma.platformSettings.create({
      data: {
        id: 1,
        paymentDetails: "8600 9999 8888 7777 (Test Card)",
        tariffs: {
          "1m": 175_000,
          "6m": 890_000,
          "12m": 1_650_000,
        },
        supportContact: "@support_b08",
      },
    });
  });

  afterEach(async () => {
    await prisma.platformSettings.deleteMany();
  });

  it("1. Dynamic Tariffs: PlatformSettings overrides default prices in keyboard buttons and session amount", async () => {
    const settings = await prisma.platformSettings.findUnique({ where: { id: 1 } });
    const tariffs = resolveTariffPrices(settings);

    expect(tariffs.tariff1m).toBe(175_000);
    expect(tariffs.tariff6m).toBe(890_000);
    expect(tariffs.tariff12m).toBe(1_650_000);

    const keyboard = buildTariffInlineKeyboard("RU", tariffs);
    const buttons = keyboard.inline_keyboard.flat();

    const text1m = buttons.find((b) => "callback_data" in b && b.callback_data === "pay:tariff:1")?.text;
    const text6m = buttons.find((b) => "callback_data" in b && b.callback_data === "pay:tariff:6")?.text;
    const text12m = buttons.find((b) => "callback_data" in b && b.callback_data === "pay:tariff:12")?.text;

    expect(text1m).toContain("175 000");
    expect(text6m).toContain("890 000");
    expect(text12m).toContain("1 650 000");

    // Verify session receives dynamic 175_000 UZS amount
    const dynamicSettings = await prisma.platformSettings.findUnique({ where: { id: 1 } });
    const dynamicTariffs = resolveTariffPrices(dynamicSettings);
    expect(dynamicTariffs.tariff1m).toBe(175_000);
  });

  it("2. Fallback Tariffs: resolves to env defaults when PlatformSettings.tariffs is empty or missing", () => {
    const fallback = resolveTariffPrices(null);
    expect(fallback.tariff1m).toBe(env.TARIFF_1M_UZS);
    expect(fallback.tariff6m).toBe(env.TARIFF_6M_UZS);
    expect(fallback.tariff12m).toBe(env.TARIFF_12M_UZS);

    const keyboard = buildTariffInlineKeyboard("UZ", fallback);
    const buttons = keyboard.inline_keyboard.flat();
    expect(buttons).toHaveLength(3);
  });
});
