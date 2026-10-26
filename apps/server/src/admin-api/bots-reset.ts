import type { FastifyInstance } from "fastify";
import type { Bot } from "grammy";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import {
  createEmptyQuickBookConfig,
  createEmptyQuizConfig,
  type ResourceType,
} from "@lcqb/contracts";
import { authenticateAdmin } from "./auth.js";
import { decryptSecret } from "../core/crypto.js";
import { env } from "../core/env.js";
import type { TenantResolver } from "../gateway/tenant-resolver.js";
import type { Logger } from "../core/logger.js";
import type { PollingManager } from "../gateway/polling-manager.js";

interface BotParams {
  id: string;
}

export interface BotResetOptions {
  tenantResolver?: TenantResolver;
  logger?: Logger;
  getBotInstance?: (token: string, botId?: string) => Bot;
  pollingManager?: PollingManager;
}

export function registerBotsResetRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  redis?: Redis,
  options?: BotResetOptions,
): void {
  // POST /api/v1/bots/:id/reset - Reset bot configuration and dialog sessions
  app.post<{ Params: BotParams }>(
    "/api/v1/bots/:id/reset",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id } = req.params;
      const bot = await prisma.bot.findUnique({ where: { id } });
      if (!bot) {
        return reply.code(404).send({ ok: false, error: "Bot not found" });
      }

      if (options?.pollingManager) {
        await options.pollingManager.stop(id);
      }

      if (options?.getBotInstance) {
        try {
          const token = decryptSecret(bot.botTokenEnc, env.TOKEN_ENCRYPTION_KEY);
          const tgBot = options.getBotInstance(token, id);
          await tgBot.api.deleteWebhook({ drop_pending_updates: true });
        } catch (err) {
          options?.logger?.warn({ err, botId: id }, "Could not delete webhook during bot reset");
        }
      }

      let emptyConfig: unknown;
      if (bot.botType === "QUICKBOOK") {
        const currentSettings = bot.settings as { resourceType?: ResourceType } | null;
        emptyConfig = createEmptyQuickBookConfig(currentSettings?.resourceType);
      } else {
        emptyConfig = createEmptyQuizConfig();
      }

      await prisma.bot.update({
        where: { id },
        data: {
          settings: emptyConfig as Prisma.InputJsonValue,
          isActive: false,
        },
      });

      let clearedSessions = 0;
      let warning: string | undefined;

      if (redis) {
        try {
          let cursor = "0";
          const pattern = `sess:${id}:*`;
          do {
            const [nextCursor, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 200);
            cursor = nextCursor;
            if (keys.length > 0) {
              await redis.unlink(...keys);
              clearedSessions += keys.length;
            }
          } while (cursor !== "0");
        } catch (err) {
          options?.logger?.warn({ err, botId: id }, "Failed to clear Redis sessions during reset");
          warning = "Не удалось очистить некоторые активные сессии в Redis.";
        }
      }

      options?.tenantResolver?.invalidate(bot.botTokenHash, bot.id);

      return reply.send({
        ok: true,
        clearedSessions,
        ...(warning ? { warning } : {}),
      });
    },
  );
}
