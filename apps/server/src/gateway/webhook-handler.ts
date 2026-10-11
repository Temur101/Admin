import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Bot } from "grammy";
import { safeEqual } from "../core/crypto.js";
import type { Logger } from "../core/logger.js";
import type { BotPool } from "./bot-pool.js";
import type { UpdateDeduplicator } from "./deduplicator.js";
import type { TenantResolver } from "./tenant-resolver.js";
import type { PlatformBotContext } from "./types.js";
import type { WebhookInboxService } from "./inbox-service.js";

type TelegramUpdatePayload = Parameters<Bot<PlatformBotContext>["handleUpdate"]>[0];

export interface WebhookGatewayOptions {
  tenantResolver: TenantResolver;
  botPool: BotPool;
  deduplicator: UpdateDeduplicator;
  inboxService?: WebhookInboxService;
  logger: Logger;
  maxInflight?: number;
  onUpdateHandled?: (botId: string, updateId: number, err?: Error) => void;
}

interface WebhookParams {
  botTokenHash: string;
}

const HASH_REGEX = /^[0-9a-f]{64}$/i;

export function registerWebhookGateway(
  app: FastifyInstance,
  options: WebhookGatewayOptions,
): void {
  const { tenantResolver, botPool, deduplicator, inboxService, logger } = options;
  const maxInflight = options.maxInflight ?? 500;
  let inflightCount = 0;

  app.post(
    "/api/v1/tg/webhook/:botTokenHash",
    async (
      req: FastifyRequest<{ Params: WebhookParams }>,
      reply: FastifyReply,
    ) => {
      const { botTokenHash } = req.params;

      // 1. Validate hash format
      if (!HASH_REGEX.test(botTokenHash)) {
        return reply.code(400).send({ ok: false, error: "Invalid botTokenHash format" });
      }

      // 2. Validate secret token header presence
      const secretHeader = req.headers["x-telegram-bot-api-secret-token"];
      if (typeof secretHeader !== "string" || !secretHeader) {
        return reply.code(401).send({ ok: false, error: "Missing secret token header" });
      }

      // 3. Check inflight concurrency limit BEFORE ANY STATE MUTATION / DEDUPLICATION
      if (inflightCount >= maxInflight) {
        logger.warn({ inflightCount, maxInflight }, "Webhook inflight capacity exceeded");
        return reply.code(429).send({ ok: false, error: "Server busy" });
      }

      // 4. Resolve bot via L1 Redis / L2 Postgres
      const bot = await tenantResolver.resolve(botTokenHash);
      if (!bot) {
        return reply.code(404).send({ ok: false, error: "Bot not found" });
      }

      // 5. Validate secret token (timing-safe)
      if (!safeEqual(secretHeader, bot.webhookSecret)) {
        return reply.code(401).send({ ok: false, error: "Invalid secret token" });
      }

      // 6. Validate body format
      const body = req.body as Record<string, unknown> | null;
      if (!body || typeof body.update_id !== "number") {
        return reply.code(400).send({ ok: false, error: "Invalid Telegram update payload" });
      }
      const updateId = body.update_id;

      // 7. Check fast L1 Redis deduplicator
      const isDuplicateL1 = await deduplicator.isDuplicate(bot.id, updateId);
      if (isDuplicateL1) {
        return reply.code(200).send({ ok: true, duplicate: true });
      }

      // 8. Atomically persist in persistent PostgreSQL WebhookInbox
      let inboxId: string | undefined;
      if (inboxService) {
        try {
          const enqueueRes = await inboxService.enqueue(bot.id, updateId, body);
          if (enqueueRes.status === "ALREADY_COMPLETED" || enqueueRes.status === "DUPLICATE") {
            return reply.code(200).send({ ok: true, duplicate: true });
          }
          inboxId = enqueueRes.inboxId;
        } catch (err) {
          logger.error(
            { err: (err as Error).message, botId: bot.id, updateId },
            "Failed to persist update to WebhookInbox in PostgreSQL",
          );
          return reply.code(503).send({ ok: false, error: "Database unavailable" });
        }
      } else {
        // Fallback for isolated tests without inboxService
        const isDuplicate = await deduplicator.checkAndSet(bot.id, updateId);
        if (isDuplicate) {
          return reply.code(200).send({ ok: true, duplicate: true });
        }
      }

      // 9. Respond HTTP 200 immediately (< 50ms) ONLY AFTER persistence succeeds!
      inflightCount++;
      void reply.code(200).send({ ok: true });

      // 10. Asynchronously handle update
      setImmediate(async () => {
        let handlingError: Error | undefined;
        try {
          if (inboxService && inboxId) {
            await inboxService.processItem(inboxId, bot, body as unknown as TelegramUpdatePayload);
          } else {
            await botPool.handleUpdate(bot, body as unknown as TelegramUpdatePayload);
            await deduplicator.markSeen(bot.id, updateId);
          }
        } catch (err) {
          handlingError = err as Error;
          logger.error(
            { err: handlingError.message, botId: bot.id, updateId },
            "Error handling Telegram update",
          );
        } finally {
          inflightCount--;
          if (options.onUpdateHandled) {
            options.onUpdateHandled(bot.id, updateId, handlingError);
          }
        }
      });
    },
  );
}
