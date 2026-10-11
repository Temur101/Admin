import { createRealTelegramTransport, type TelegramTransport } from "./adapters/telegram/transport.js";
import { encryptSecret, sha256Hex } from "./core/crypto.js";
import { env } from "./core/env.js";
import { logger } from "./core/logger.js";
import { prisma } from "./core/prisma.js";
import { connectRedis, createRedisClient, type Redis } from "./core/redis.js";
import { BotPool } from "./gateway/bot-pool.js";
import type { ResolvedBot } from "./gateway/types.js";
import type { BotType } from "@prisma/client";

interface LaunchOptions {
  token: string;
  botType: BotType;
  defaultUsername: string;
  adminInviteCode: string;
  botPool: BotPool;
  transport: TelegramTransport;
  tenantId: string;
}

async function setupAndStartBot(opts: LaunchOptions): Promise<string> {
  const { token, botType, defaultUsername, adminInviteCode, botPool, tenantId } = opts;

  let botUsername = defaultUsername;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await res.json()) as { ok: boolean; result?: { username?: string; first_name?: string } };
    if (data.ok && data.result?.username) {
      botUsername = data.result.username;
      logger.info({ username: botUsername, botType }, "Telegram getMe succeeded");
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message, botType }, "getMe failed, using fallback username");
  }

  const tokenHash = sha256Hex(token);
  const tokenEnc = encryptSecret(token, env.TOKEN_ENCRYPTION_KEY);

  let botRecord = await prisma.bot.findUnique({
    where: { botTokenHash: tokenHash },
    include: { subscription: true },
  });

  if (!botRecord) {
    botRecord = await prisma.bot.create({
      data: {
        tenantId,
        botType,
        botTokenEnc: tokenEnc,
        botTokenHash: tokenHash,
        webhookSecret: `secret_${botType.toLowerCase()}`,
        botUsername,
        adminInviteCode,
        subscription: {
          create: {
            status: "TRIAL",
            trialEndsAt: new Date(Date.now() + 86400000 * 7),
          },
        },
      },
      include: { subscription: true },
    });
  } else {
    botRecord = await prisma.bot.update({
      where: { id: botRecord.id },
      data: {
        botType,
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

  const bot = botPool.getOrCreateBot(resolved);

  try {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "deleteWebhook failed or not needed");
  }

  void bot.start({
    onStart: () => {
      logger.info({ username: botUsername, botType }, "Long polling started successfully");
    },
  });

  return botUsername;
}

async function runDevBots() {
  const lcToken = env.DEV_LEADCATCH_TOKEN?.trim();
  const qbToken = env.DEV_QUICKBOOK_TOKEN?.trim();

  if (!lcToken && !qbToken) {
    logger.error("Neither DEV_LEADCATCH_TOKEN nor DEV_QUICKBOOK_TOKEN is set in .env.");
    process.exit(1);
  }

  await prisma.$connect();
  const redis: Redis = createRedisClient({
    url: env.REDIS_URL,
    logger,
    name: "dev-bots-runner",
  });
  await connectRedis(redis);

  const transport = createRealTelegramTransport();

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

  const botPool = new BotPool({
    capacity: 10,
    encryptionKey: env.TOKEN_ENCRYPTION_KEY,
    transport,
    redis,
    sessionTtlSec: 3600,
    logger,
    prisma,
  });

  // eslint-disable-next-line no-console
  console.log("\n===========================================================");

  if (lcToken) {
    const lcCode = "leadcatch_adm_123";
    const lcUsername = await setupAndStartBot({
      token: lcToken,
      botType: "LEADCATCH",
      defaultUsername: "leadcatch_bot",
      adminInviteCode: lcCode,
      botPool,
      transport,
      tenantId: tenant.id,
    });
    // eslint-disable-next-line no-console
    console.log(`🤖 [LEADCATCH] бот запущен: @${lcUsername}`);
    // eslint-disable-next-line no-console
    console.log(`👉 Клиентский вход: https://t.me/${lcUsername}`);
    // eslint-disable-next-line no-console
    console.log(`🔑 Админский вход:  https://t.me/${lcUsername}?start=adm_${lcCode}\n`);
  }

  if (qbToken) {
    const qbCode = "quickbook_adm_123";
    const qbUsername = await setupAndStartBot({
      token: qbToken,
      botType: "QUICKBOOK",
      defaultUsername: "quickbook_bot",
      adminInviteCode: qbCode,
      botPool,
      transport,
      tenantId: tenant.id,
    });
    // eslint-disable-next-line no-console
    console.log(`📅 [QUICKBOOK] бот запущен: @${qbUsername}`);
    // eslint-disable-next-line no-console
    console.log(`👉 Клиентский вход (бронь): https://t.me/${qbUsername}`);
    // eslint-disable-next-line no-console
    console.log(`🔑 Админский вход:          https://t.me/${qbUsername}?start=adm_${qbCode}`);
  }

  // eslint-disable-next-line no-console
  console.log("===========================================================\n");
}

void runDevBots();
