import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import sensible from "@fastify/sensible";
import { env, type Env } from "./core/env.js";
import { prisma } from "./core/prisma.js";
import { logger } from "./core/logger.js";
import { connectRedis, createRedisClient, type Redis } from "./core/redis.js";
import {
  createTelegramTransport,
  type TelegramTransport,
} from "./adapters/telegram/index.js";
import {
  BotPool,
  TenantResolver,
  UpdateDeduplicator,
  registerWebhookGateway,
} from "./gateway/index.js";

export { prisma };
export { logger };
export { env, type Env };
export * from "./core/crypto.js";
export * from "./core/lru.js";
export * from "./core/redis.js";
export * from "./adapters/telegram/index.js";
export * from "./adapters/telegram/transport.js";
export * from "./adapters/telegram/mock-transport.js";
export * from "./gateway/index.js";
export * from "./bots/shared/i18n.js";
export * from "./bots/shared/masking.js";
export * from "./bots/shared/subscription.js";
export * from "./bots/shared/notification.js";
export * from "./bots/shared/user-service.js";
export * from "./bots/shared/admin-menu.js";
export * from "./bots/shared/phone.js";
export * from "./bots/shared/payment-service.js";
export * from "./bots/shared/receipt-storage.js";
export * from "./bots/leadcatch/index.js";
export * from "./bots/quickbook/index.js";
export * from "./workers/subscription-worker.js";
export * from "./workers/booking-reminder-worker.js";

import type { PrismaClient } from "@prisma/client";

export interface AppOptions {
  prisma?: PrismaClient;
  redis?: Redis;
  transport?: TelegramTransport;
  onUpdateHandled?: (botId: string, updateId: number, err?: Error) => void;
}

export async function buildApp(opts?: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
    },
  });

  await app.register(sensible);
  await app.register(cors, {
    origin: [env.ADMIN_ORIGIN],
    credentials: true,
  });

  const appPrisma = opts?.prisma ?? prisma;
  const appRedis = opts?.redis ?? createRedisClient({ url: env.REDIS_URL, logger });
  const ownsRedis = !opts?.redis;
  if (ownsRedis) {
    try {
      await connectRedis(appRedis);
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        "Redis connection failed or deferred during startup",
      );
    }
  }

  const transport = opts?.transport ?? createTelegramTransport(env.USE_MOCK_TELEGRAM);

  const tenantResolver = new TenantResolver({
    prisma: appPrisma,
    redis: appRedis,
    cacheTtlSec: env.BOT_RESOLVE_CACHE_TTL_SEC,
    logger,
  });

  const deduplicator = new UpdateDeduplicator(
    appRedis,
    env.UPDATE_DEDUP_TTL_SEC,
    logger,
  );

  const botPool = new BotPool({
    capacity: env.BOT_INSTANCE_CACHE_SIZE,
    encryptionKey: env.TOKEN_ENCRYPTION_KEY,
    transport,
    redis: appRedis,
    sessionTtlSec: env.SESSION_TTL_SEC,
    logger,
    prisma: appPrisma,
  });

  registerWebhookGateway(app, {
    tenantResolver,
    botPool,
    deduplicator,
    logger,
    maxInflight: env.WEBHOOK_MAX_INFLIGHT,
    onUpdateHandled: opts?.onUpdateHandled,
  });

  app.get("/health", async () => {
    return {
      status: "ok" as const,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  });

  app.addHook("onClose", async () => {
    if (ownsRedis && appRedis.status !== "end") {
      await appRedis.quit().catch(() => {});
    }
  });

  return app;
}

async function start() {
  const app = await buildApp();
  try {
    await app.listen({ host: env.HOST, port: env.PORT });
    app.log.info(`🚀 Server running on http://${env.HOST}:${env.PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== "test") {
  void start();
}
