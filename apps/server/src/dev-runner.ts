import { createRealTelegramTransport } from "./adapters/telegram/transport.js";
import { encryptSecret, sha256Hex } from "./core/crypto.js";
import { env } from "./core/env.js";
import { logger } from "./core/logger.js";
import { prisma } from "./core/prisma.js";
import { connectRedis, createRedisClient } from "./core/redis.js";
import { BotPool } from "./gateway/bot-pool.js";
import type { ResolvedBot } from "./gateway/types.js";

async function runDevBot() {
  const token = env.DEV_LEADCATCH_TOKEN?.trim();
  if (!token) {
    logger.error("DEV_LEADCATCH_TOKEN is not set in .env. Please set it before running dev:bot.");
    process.exit(1);
  }

  logger.info("Initializing Dev LeadCatch Bot runner...");

  // 1. Connect Postgres and Redis
  await prisma.$connect();
  const redis = createRedisClient({
    url: env.REDIS_URL,
    logger,
    name: "dev-leadcatch-runner",
  });
  await connectRedis(redis);

  // 2. Fetch real bot details from Telegram API
  const transport = createRealTelegramTransport();
  let botUsername = "leadcatch_bot";

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await res.json()) as { ok: boolean; result?: { username?: string; first_name?: string } };
    if (data.ok && data.result?.username) {
      botUsername = data.result.username;
      logger.info({ username: botUsername, name: data.result.first_name }, "Telegram getMe succeeded");
    } else {
      logger.warn({ data }, "getMe returned non-ok, using fallback username");
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "Could not reach Telegram getMe, proceeding with fallback");
  }

  // 3. Upsert test tenant
  const tenant = await prisma.tenant.upsert({
    where: { id: "00000000-0000-0000-0000-000000000001" },
    create: {
      id: "00000000-0000-0000-0000-000000000001",
      clientName: "Тестовый клиент (Dev)",
      contactPhone: "+998901234567",
    },
    update: {
      clientName: "Тестовый клиент (Dev)",
    },
  });

  const tokenHash = sha256Hex(token);
  const tokenEnc = encryptSecret(token, env.TOKEN_ENCRYPTION_KEY);
  const adminInviteCode = "dev_secret_123";

  // 4. Upsert bot in PostgreSQL
  let botRecord = await prisma.bot.findUnique({
    where: { botTokenHash: tokenHash },
    include: { subscription: true },
  });

  if (!botRecord) {
    botRecord = await prisma.bot.create({
      data: {
        tenantId: tenant.id,
        botType: "LEADCATCH",
        botTokenEnc: tokenEnc,
        botTokenHash: tokenHash,
        webhookSecret: "dev_secret",
        botUsername,
        adminInviteCode,
        subscription: {
          create: {
            status: "TRIAL",
            trialEndsAt: new Date(Date.now() + 86400000 * 7), // 7 days trial
          },
        },
      },
      include: { subscription: true },
    });
  } else {
    botRecord = await prisma.bot.update({
      where: { id: botRecord.id },
      data: {
        botUsername,
        botTokenEnc: tokenEnc,
        adminInviteCode,
      },
      include: { subscription: true },
    });
  }

  const resolved: ResolvedBot = {
    id: botRecord.id,
    tenantId: botRecord.tenantId,
    botType: botRecord.botType,
    botTokenEnc: botRecord.botTokenEnc,
    botTokenHash: botRecord.botTokenHash,
    webhookSecret: botRecord.webhookSecret,
    botUsername: botRecord.botUsername,
    adminInviteCode: botRecord.adminInviteCode,
    settings: (botRecord.settings ?? {}) as Record<string, unknown>,
    subscriptionStatus: botRecord.subscription?.status ?? "TRIAL",
    trialEndsAt: botRecord.subscription?.trialEndsAt.toISOString() ?? new Date().toISOString(),
    paidUntil: botRecord.subscription?.paidUntil?.toISOString() ?? null,
  };

  // 5. Initialize BotPool and grammY instance
  const botPool = new BotPool({
    capacity: 10,
    encryptionKey: env.TOKEN_ENCRYPTION_KEY,
    transport,
    redis,
    sessionTtlSec: 3600,
    logger,
    prisma,
  });

  const bot = botPool.getOrCreateBot(resolved);

  // 6. Delete any webhook to allow Long Polling
  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    logger.info("Deleted pending webhook and dropped updates");
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "deleteWebhook failed or not needed");
  }

  // eslint-disable-next-line no-console
  console.log("\n===========================================================");
  // eslint-disable-next-line no-console
  console.log(`🤖 LeadCatch бот успешно запущен: @${botUsername}`);
  // eslint-disable-next-line no-console
  console.log(`👉 Чтобы пройти квиз как клиент: https://t.me/${botUsername}`);
  // eslint-disable-next-line no-console
  console.log(`🔑 Чтобы войти как АДМИНИСТРАТОР: https://t.me/${botUsername}?start=adm_${adminInviteCode}`);
  // eslint-disable-next-line no-console
  console.log("===========================================================\n");

  // 7. Start Long Polling
  void bot.start({
    onStart: (info) => {
      logger.info({ info }, "Long polling started successfully");
    },
  });
}

void runDevBot();
