import type { FastifyInstance } from "fastify";
import fastifyJwt from "@fastify/jwt";
import fastifyCookie from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { env } from "../core/env.js";
import type { Logger } from "../core/logger.js";
import type { TelegramTransport } from "../adapters/telegram/transport.js";
import type { TenantResolver } from "../gateway/tenant-resolver.js";
import type { PollingManager } from "../gateway/polling-manager.js";

import {
  registerAuthRoutes,
  ensureSuperAdmin,
  hashPassword,
  verifyPassword,
  authenticateAdmin,
} from "./auth.js";
import { registerTenantRoutes } from "./tenants.js";
import { registerBotsRoutes } from "./bots.js";
import { registerTemplatesRoutes } from "./templates.js";
import { registerBookingsRoutes } from "./bookings.js";
import { registerReceiptsRoutes } from "./receipts.js";
import { registerSettingsRoutes } from "./settings.js";
import { registerAnalyticsRoutes } from "./analytics.js";

export { ensureSuperAdmin, hashPassword, verifyPassword, authenticateAdmin };

export interface AdminApiOptions {
  prisma: PrismaClient;
  redis: Redis;
  transport: TelegramTransport;
  tenantResolver?: TenantResolver;
  logger: Logger;
  pollingManager?: PollingManager;
}

export async function registerAdminApi(
  app: FastifyInstance,
  options: AdminApiOptions,
): Promise<void> {
  const { prisma, redis, transport, tenantResolver, logger, pollingManager } = options;

  // 1. Register security plugins if not already present
  if (!app.hasPlugin("@fastify/jwt") && !app.jwt) {
    await app.register(fastifyJwt, {
      secret: env.JWT_ACCESS_SECRET,
    });
  }

  if (!app.hasPlugin("@fastify/cookie")) {
    await app.register(fastifyCookie);
  }

  if (!app.hasPlugin("@fastify/rate-limit")) {
    await app.register(fastifyRateLimit, {
      global: false,
    });
  }

  // 2. Ensure initial platform superadmin account exists
  await ensureSuperAdmin(prisma, logger);

  // 3. Register route modules under /api/v1/*
  registerAuthRoutes(app, prisma);
  registerTenantRoutes(app, prisma);
  registerBotsRoutes(app, prisma, tenantResolver, logger, transport, pollingManager);
  registerTemplatesRoutes(app, prisma, tenantResolver);
  registerBookingsRoutes(app, prisma, redis, transport, logger);
  registerReceiptsRoutes(app, prisma, redis, transport, logger);
  registerSettingsRoutes(app, prisma);
  registerAnalyticsRoutes(app, prisma);

  logger.info("Admin REST API successfully registered under /api/v1/*");
}
