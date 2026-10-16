import { activateBot } from "./bot-activation.js";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import type { Bot } from "grammy";
import type { PrismaClient } from "@prisma/client";
import { authenticateAdmin } from "./auth.js";
import { decryptSecret } from "../core/crypto.js";
import { env } from "../core/env.js";
import type { TenantResolver } from "../gateway/tenant-resolver.js";
import type { Logger } from "../core/logger.js";
import type { PollingManager } from "../gateway/polling-manager.js";

interface BotParams {
  id: string;
}

interface BotQuery {
  purge?: string;
}

export function registerBotsLifecycleRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  tenantResolver?: TenantResolver,
  logger?: Logger,
  getBotInstance?: (token: string, botId?: string) => Bot,
  pollingManager?: PollingManager,
): void {
  // POST /api/v1/bots/:id/suspend - Deactivate bot (Preserves leads, bookings, receipts)
  app.post<{ Params: BotParams }>(
    "/api/v1/bots/:id/suspend",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id } = req.params;
      const bot = await prisma.bot.findUnique({ where: { id } });
      if (!bot) {
        return reply.code(404).send({ ok: false, error: "Bot not found" });
      }

      if (pollingManager) {
        await pollingManager.stop(id);
      }

      if (getBotInstance) {
        try {
          const token = decryptSecret(bot.botTokenEnc, env.TOKEN_ENCRYPTION_KEY);
          const tgBot = getBotInstance(token, id);
          await tgBot.api.deleteWebhook({ drop_pending_updates: false });
        } catch (err) {
          logger?.warn({ err, botId: id }, "Could not delete webhook during suspension");
        }
      }

      await prisma.bot.update({
        where: { id },
        data: { isActive: false },
      });

      tenantResolver?.invalidate(bot.botTokenHash, bot.id);

      return reply.send({
        ok: true,
        status: "suspended",
        message: "Bot suspended successfully. Data preserved.",
      });
    },
  );

  // POST /api/v1/bots/:id/resume - Resume bot
  app.post<{ Params: BotParams }>(
    "/api/v1/bots/:id/resume",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id } = req.params;
      const bot = await prisma.bot.findUnique({ where: { id } });
      if (!bot) {
        return reply.code(404).send({ ok: false, error: "Bot not found" });
      }

      let webhookWarning: string | null;
      if (!getBotInstance)
        return reply.code(503).send({ ok: false, error: "Проверка Telegram недоступна." });
      try {
        webhookWarning = await activateBot(prisma, bot, {
          mode: env.BOT_MODE,
          publicBaseUrl: env.PUBLIC_BASE_URL,
          pollingManager,
          getTelegramBot: (record) =>
            getBotInstance(decryptSecret(record.botTokenEnc, env.TOKEN_ENCRYPTION_KEY), record.id),
          invalidate: (record) => tenantResolver?.invalidate(record.botTokenHash, record.id),
        });
      } catch {
        return reply.code(502).send({ ok: false, error: "Не удалось возобновить работу бота." });
      }

      return reply.send({
        ok: true,
        status: "active",
        message: "Bot resumed successfully.",
        ...(webhookWarning ? { warning: webhookWarning } : {}),
      });
    },
  );

  // DELETE /api/v1/bots/:id - Permanent destruction ONLY with ?purge=true
  app.delete<{ Params: BotParams; Querystring: BotQuery }>(
    "/api/v1/bots/:id",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id } = req.params;
      const { purge } = req.query;

      if (purge !== "true") {
        return reply.code(400).send({
          ok: false,
          error:
            "Bot deactivation does not delete data. Use /suspend to deactivate safely, or pass ?purge=true to permanently delete all data.",
        });
      }

      const bot = await prisma.bot.findUnique({ where: { id } });
      if (!bot) {
        return reply.code(404).send({ ok: false, error: "Bot not found" });
      }

      if (pollingManager) {
        await pollingManager.stop(id);
      }

      if (getBotInstance) {
        try {
          const token = decryptSecret(bot.botTokenEnc, env.TOKEN_ENCRYPTION_KEY);
          const tgBot = getBotInstance(token, id);
          await tgBot.api.deleteWebhook({ drop_pending_updates: true });
        } catch (err) {
          logger?.warn({ err, botId: id }, "Could not delete webhook during bot purge");
        }
      }

      await prisma.bot.delete({ where: { id } });
      tenantResolver?.invalidate(bot.botTokenHash, bot.id);

      return reply.send({
        ok: true,
        message: "Bot and all associated data permanently deleted.",
      });
    },
  );

  // POST /api/v1/bots/:id/reissue-invite - Reissue admin invite code
  app.post<{ Params: BotParams }>(
    "/api/v1/bots/:id/reissue-invite",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id } = req.params;
      const newCode = randomBytes(16).toString("hex");

      const bot = await prisma.bot.update({
        where: { id },
        data: { adminInviteCode: newCode },
      });

      tenantResolver?.invalidate(bot.botTokenHash, bot.id);

      return reply.send({
        ok: true,
        adminInviteCode: newCode,
        inviteLink: bot.botUsername ? `https://t.me/${bot.botUsername}?start=adm_${newCode}` : null,
      });
    },
  );
}
