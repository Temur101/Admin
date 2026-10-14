import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import type { Bot } from "grammy";
import type { PrismaClient } from "@prisma/client";
import { ExtendSubscriptionRequestSchema } from "@lcqb/contracts";
import { authenticateAdmin } from "./auth.js";
import { decryptSecret } from "../core/crypto.js";
import { env } from "../core/env.js";
import type { TenantResolver } from "../gateway/tenant-resolver.js";

interface BotParams {
  id: string;
}

interface AdminParams {
  id: string;
  tgId: string;
}

export function registerBotsOpsRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  tenantResolver?: TenantResolver,
  getBotInstance?: (token: string, botId?: string) => Bot,
): void {
  // GET /api/v1/bots/:id/admins - List bot administrators
  app.get<{ Params: BotParams }>(
    "/api/v1/bots/:id/admins",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id } = req.params;
      const admins = await prisma.botUser.findMany({
        where: { botId: id, isAdmin: true },
        orderBy: { createdAt: "asc" },
      });

      return reply.send({
        ok: true,
        admins: admins.map((a) => ({
          tgId: a.tgId.toString(),
          firstName: a.firstName,
          username: a.username,
          lang: a.lang,
          createdAt: a.createdAt.toISOString(),
        })),
      });
    },
  );

  // DELETE /api/v1/bots/:id/admins/:tgId - Revoke admin rights
  app.delete<{ Params: AdminParams }>(
    "/api/v1/bots/:id/admins/:tgId",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id, tgId } = req.params;
      try {
        const tgIdBig = BigInt(tgId);
        await prisma.botUser.update({
          where: { botId_tgId: { botId: id, tgId: tgIdBig } },
          data: { isAdmin: false },
        });

        return reply.send({ ok: true, message: "Admin role revoked" });
      } catch {
        return reply.code(404).send({ ok: false, error: "Admin not found" });
      }
    },
  );

  // POST /api/v1/bots/:id/extend - Manual subscription extension
  app.post<{ Params: BotParams }>(
    "/api/v1/bots/:id/extend",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id } = req.params;
      const parsed = ExtendSubscriptionRequestSchema.safeParse(req.body ?? {});
      const days = parsed.success ? parsed.data.days : 30;

      const sub = await prisma.subscription.findUnique({ where: { botId: id } });
      if (!sub) {
        return reply.code(404).send({ ok: false, error: "Subscription not found" });
      }

      const now = Date.now();
      const currentEnd = Math.max(
        now,
        sub.paidUntil ? sub.paidUntil.getTime() : sub.trialEndsAt.getTime(),
      );
      const newPaidUntil = new Date(currentEnd + days * 86400 * 1000);

      const updated = await prisma.subscription.update({
        where: { botId: id },
        data: {
          paidUntil: newPaidUntil,
          status: "ACTIVE",
          failedReceiptAttempts: 0,
        },
      });

      return reply.send({
        ok: true,
        subscription: {
          status: updated.status,
          paidUntil: updated.paidUntil?.toISOString() ?? null,
        },
      });
    },
  );

  // POST /api/v1/bots/:id/unblock - Unblock subscription
  app.post<{ Params: BotParams }>(
    "/api/v1/bots/:id/unblock",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id } = req.params;
      const sub = await prisma.subscription.findUnique({ where: { botId: id } });
      if (!sub) {
        return reply.code(404).send({ ok: false, error: "Subscription not found" });
      }

      const updated = await prisma.subscription.update({
        where: { botId: id },
        data: {
          status: "ACTIVE",
          failedReceiptAttempts: 0,
        },
      });

      return reply.send({
        ok: true,
        status: updated.status,
      });
    },
  );

  // GET /api/v1/bots/:id/webhook-info - Telegram webhook diagnostics
  app.get<{ Params: BotParams }>(
    "/api/v1/bots/:id/webhook-info",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id } = req.params;
      const bot = await prisma.bot.findUnique({ where: { id } });
      if (!bot) {
        return reply.code(404).send({ ok: false, error: "Bot not found" });
      }

      if (!getBotInstance) {
        return reply.code(500).send({ ok: false, error: "Bot instance provider not available" });
      }

      try {
        const token = decryptSecret(bot.botTokenEnc, env.TOKEN_ENCRYPTION_KEY);
        const tgBot = getBotInstance(token, id);
        const info = await tgBot.api.getWebhookInfo();
        return reply.send({ ok: true, webhookInfo: info });
      } catch (err) {
        return reply.code(502).send({
          ok: false,
          error: "Failed to fetch webhook info from Telegram",
          details: err instanceof Error ? err.message : String(err),
        });
      }
    },
  );

  // POST /api/v1/bots/:id/sync-webhook - Rotate secret and re-set webhook
  app.post<{ Params: BotParams }>(
    "/api/v1/bots/:id/sync-webhook",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id } = req.params;
      const bot = await prisma.bot.findUnique({ where: { id } });
      if (!bot) {
        return reply.code(404).send({ ok: false, error: "Bot not found" });
      }

      if (!getBotInstance) {
        return reply.code(500).send({ ok: false, error: "Bot instance provider not available" });
      }

      const newSecret = randomBytes(32).toString("hex");
      try {
        const token = decryptSecret(bot.botTokenEnc, env.TOKEN_ENCRYPTION_KEY);
        const tgBot = getBotInstance(token, id);
        const webhookUrl = `${env.PUBLIC_BASE_URL}/api/v1/tg/webhook/${bot.botTokenHash}`;
        await tgBot.api.setWebhook(webhookUrl, {
          secret_token: newSecret,
          drop_pending_updates: false,
        });
      } catch (err) {
        return reply.code(502).send({
          ok: false,
          error: "Failed to update webhook in Telegram",
          details: err instanceof Error ? err.message : String(err),
        });
      }

      await prisma.bot.update({
        where: { id },
        data: { webhookSecret: newSecret },
      });

      tenantResolver?.invalidate(bot.botTokenHash, bot.id);

      return reply.send({ ok: true, webhookSecret: newSecret });
    },
  );

  // GET /api/v1/bots/:id/health - Health check per bot
  app.get<{ Params: BotParams }>(
    "/api/v1/bots/:id/health",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id } = req.params;
      const bot = await prisma.bot.findUnique({
        where: { id },
        include: { subscription: true },
      });

      if (!bot) {
        return reply.code(404).send({ ok: false, error: "Bot not found" });
      }

      const failedInboxCount = await prisma.webhookInbox.count({
        where: { botId: id, status: "FAILED" },
      });

      return reply.send({
        ok: true,
        health: {
          botId: bot.id,
          isActive: bot.isActive,
          subscriptionStatus: bot.subscription?.status ?? "UNKNOWN",
          failedInboxCount,
        },
      });
    },
  );

  // GET /api/v1/system/inbox-errors - System-wide inbox failures
  app.get(
    "/api/v1/system/inbox-errors",
    { preHandler: [authenticateAdmin] },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const errors = await prisma.webhookInbox.findMany({
        where: { status: "FAILED" },
        include: {
          bot: { select: { botUsername: true, botType: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 50,
      });

      return reply.send({
        ok: true,
        errors: errors.map((e) => ({
          id: e.id,
          botId: e.botId,
          botUsername: e.bot.botUsername,
          botType: e.bot.botType,
          updateId: e.updateId.toString(),
          attempts: e.attempts,
          lastError: e.lastError,
          createdAt: e.createdAt.toISOString(),
        })),
      });
    },
  );
}
