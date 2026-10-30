import { connectRedis, createRedisClient } from "../../src/core/redis.js";
import { encryptSecret, sha256Hex } from "../../src/core/crypto.js";
import { env } from "../../src/core/env.js";
import { logger } from "../../src/core/logger.js";
import { BotPool } from "../../src/gateway/bot-pool.js";
import { TenantResolver } from "../../src/gateway/tenant-resolver.js";
import { MockTelegramTransport } from "../../src/adapters/telegram/mock-transport.js";
import type { PlatformBotSession } from "../../src/gateway/types.js";
import { getTestPrismaClient, safeCleanTestDb, safeCleanTestRedis } from "./test-env.js";
import type { QuickBookConfig } from "@lcqb/contracts";

export const readinessConfig: QuickBookConfig = {
  resourceType: "STAFF", resourceLabel: { ru: "Мастер", uz: "Usta" },
  services: [{ id: "haircut", name: { ru: "Стрижка", uz: "Soch" }, durationMin: 30, priceUzs: 50000 }],
  resources: [{ id: "master1", name: { ru: "Мастер", uz: "Usta" }, workDays: [0, 1, 2, 3, 4, 5, 6], workHours: { start: "00:00", end: "23:59" } }],
  slotIntervalMin: 30, bookingHorizonDays: 14, timezone: "Asia/Tashkent",
};
export const actors = { owner: 1001, staff: 1002, client: 1003, other: 1004 };

export async function readinessFixture() {
  const prisma = getTestPrismaClient();
  const redis = createRedisClient({ url: env.TEST_REDIS_URL, logger });
  await connectRedis(redis);
  await safeCleanTestDb(prisma);
  await safeCleanTestRedis(redis);
  const transport = new MockTelegramTransport();
  const tenant = await prisma.tenant.create({ data: { clientName: "Readiness fixture", contactPhone: "+998901234567" } });
  const token = "123456789:readiness-fixture-token";
  const bot = await prisma.bot.create({ data: {
    tenantId: tenant.id, botType: "QUICKBOOK", botTokenEnc: encryptSecret(token, env.TOKEN_ENCRYPTION_KEY), botTokenHash: sha256Hex(token), webhookSecret: "test-only", settings: readinessConfig,
    subscription: { create: { status: "ACTIVE", trialEndsAt: new Date(Date.now() + 86400000), paidUntil: new Date(Date.now() + 30 * 86400000) } },
  } });
  await prisma.botUser.createMany({ data: [
    { botId: bot.id, tgId: actors.owner, isAdmin: true, role: "OWNER", lang: "RU" },
    { botId: bot.id, tgId: actors.staff, isAdmin: true, role: "STAFF", lang: "RU" },
    { botId: bot.id, tgId: actors.client, isAdmin: false, lang: "RU" },
  ] });
  const resolver = new TenantResolver({ prisma, redis, logger, cacheTtlSec: 600 });
  const pool = new BotPool({ prisma, redis, logger, transport, encryptionKey: env.TOKEN_ENCRYPTION_KEY, capacity: 10, sessionTtlSec: 3600, tenantResolver: resolver });
  let seq = 10000;
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const slot = (time = "12:00") => new Date(`${tomorrow}T${time}:00+05:00`);
  async function callback(user: number, data: string) {
    await pool.handleUpdate((await resolver.resolveById(bot.id))!, { update_id: ++seq, callback_query: {
      id: String(seq), from: { id: user, is_bot: false, first_name: "Fixture" }, chat_instance: "test", data,
      message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: user, type: "private", first_name: "Fixture" }, text: "Fixture" },
    } });
  }
  async function message(user: number, text: string) {
    await pool.handleUpdate((await resolver.resolveById(bot.id))!, { update_id: ++seq, message: {
      message_id: seq, date: Math.floor(Date.now() / 1000), from: { id: user, is_bot: false, first_name: "Fixture" }, chat: { id: user, type: "private", first_name: "Fixture" }, text,
    } });
  }
  const setSession = (user: number, value: PlatformBotSession) => redis.set(`sess:${bot.id}:${user}`, JSON.stringify(value));
  const session = async (user: number): Promise<PlatformBotSession> => JSON.parse(await redis.get(`sess:${bot.id}:${user}`) ?? "{}");
  const buttons = () => transport.callsOf("sendMessage").at(-1)?.payload.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] } | undefined;
  const booking = (user = actors.client) => prisma.booking.create({ data: {
    botId: bot.id, customerTgId: user, customerName: "Fixture", customerPhone: "+998901234567", serviceId: "haircut", serviceName: "Стрижка", staffId: "master1", durationMin: 30, slotTime: slot(), status: "CONFIRMED",
  } });
  return { prisma, redis, transport, bot, resolver, pool, tomorrow, slot, callback, message, setSession, session, buttons, booking,
    close: async () => { await redis.quit(); await prisma.$disconnect(); },
  };
}
