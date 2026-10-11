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
  WebhookInboxService,
  registerWebhookGateway,
} from "./gateway/index.js";
import {
  BackgroundWorkerScheduler,
  type SchedulerOptions,
} from "./workers/scheduler.js";

export { prisma };
export { logger };
export { env, type Env };
export type { FastifyInstance };
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
export * from "./workers/scheduler.js";

import type { PrismaClient } from "@prisma/client";

export interface AppOptions {
  prisma?: PrismaClient;
  redis?: Redis;
  transport?: TelegramTransport;
  enableScheduler?: boolean;
  schedulerOptions?: Partial<SchedulerOptions>;
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
  const defaultRedisUrl =
    process.env.NODE_ENV === "test" && env.TEST_REDIS_URL
      ? env.TEST_REDIS_URL
      : env.REDIS_URL;
  const appRedis = opts?.redis ?? createRedisClient({ url: defaultRedisUrl, logger });
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
    tenantResolver,
  });

  tenantResolver.setOnInvalidate((botTokenHash, botId) => {
    botPool.invalidateMeta(botTokenHash, botId);
  });

  const inboxService = new WebhookInboxService({
    prisma: appPrisma,
    redis: appRedis,
    botPool,
    tenantResolver,
    deduplicator,
    logger,
  });

  registerWebhookGateway(app, {
    tenantResolver,
    botPool,
    deduplicator,
    inboxService,
    logger,
    maxInflight: env.WEBHOOK_MAX_INFLIGHT,
    onUpdateHandled: opts?.onUpdateHandled,
  });

  // Background workers scheduler
  const scheduler = new BackgroundWorkerScheduler({
    prisma: appPrisma,
    redis: appRedis,
    transport,
    logger,
    subscriptionIntervalMs: opts?.schedulerOptions?.subscriptionIntervalMs,
    reminderIntervalMs: opts?.schedulerOptions?.reminderIntervalMs,
    runImmediately: opts?.schedulerOptions?.runImmediately,
  });

  const shouldStartScheduler = opts?.enableScheduler ?? (process.env.NODE_ENV !== "test");
  if (shouldStartScheduler) {
    scheduler.start();
  }

  app.decorate("scheduler", scheduler);

  // Health checks:
  // Liveness probe
  app.get("/health/live", async () => {
    return {
      status: "ok" as const,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  });

  const checkReadiness = async () => {
    let dbStatus: "connected" | "error" = "connected";
    let redisStatus: "connected" | "error" = "connected";
    let healthy = true;

    try {
      await appPrisma.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = "error";
      healthy = false;
    }

    try {
      const pingRes = await appRedis.ping();
      if (pingRes !== "PONG") {
        redisStatus = "error";
        healthy = false;
      }
    } catch {
      redisStatus = "error";
      healthy = false;
    }

    return { healthy, dbStatus, redisStatus };
  };

  // Readiness probe
  app.get("/health/ready", async (_req, reply) => {
    const { healthy, dbStatus, redisStatus } = await checkReadiness();
    if (!healthy) {
      return reply.status(503).send({
        status: "unhealthy" as const,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        dependencies: {
          database: dbStatus,
          redis: redisStatus,
        },
      });
    }

    return {
      status: "ok" as const,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      dependencies: {
        database: dbStatus,
        redis: redisStatus,
      },
    };
  });

  // Standard health endpoint
  app.get("/health", async (_req, reply) => {
    const { healthy, dbStatus, redisStatus } = await checkReadiness();
    if (!healthy) {
      return reply.status(503).send({
        status: "unhealthy" as const,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        dependencies: {
          database: dbStatus,
          redis: redisStatus,
        },
      });
    }

    return {
      status: "ok" as const,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      dependencies: {
        database: dbStatus,
        redis: redisStatus,
      },
    };
  });

  app.addHook("onClose", async () => {
    await scheduler.stop();
    if (ownsRedis && appRedis.status !== "end") {
      await appRedis.quit().catch(() => {});
    }
  });

  return app;
}

async function start() {
  const app = await buildApp({ enableScheduler: true });
  try {
    await app.listen({ host: env.HOST, port: env.PORT });
    app.log.info(`🚀 Server running on http://${env.HOST}:${env.PORT}`);

    const shutdown = async (signal: string) => {
      app.log.info({ signal }, "Graceful shutdown signal received");
      try {
        await app.close();
        app.log.info("Server closed cleanly");
        process.exit(0);
      } catch (err) {
        app.log.error({ err }, "Error during graceful shutdown");
        process.exit(1);
      }
    };

    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== "test") {
  void start();
}
