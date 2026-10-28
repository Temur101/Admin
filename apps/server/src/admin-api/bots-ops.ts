import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import type { Bot } from "grammy";
import type { LeadStatus, PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { authenticateAdmin } from "./auth.js";
import { decryptSecret } from "../core/crypto.js";
import { env } from "../core/env.js";
import { checkBotConnection } from "./bot-connection.js";
import { revokeBotAdminRights } from "../bots/shared/permissions.js";
import type { PollingManager } from "../gateway/polling-manager.js";
import type { TenantResolver } from "../gateway/tenant-resolver.js";

interface BotParams {
  id: string;
}

interface AdminParams {
  id: string;
  tgId: string;
}

interface LeadsQuery {
  status?: string;
}

const VALID_LEAD_STATUSES: LeadStatus[] = ["NEW", "IN_PROGRESS", "DONE", "REJECTED"];

export function registerBotsOpsRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  tenantResolver?: TenantResolver,
  getBotInstance?: (token: string, botId?: string) => Bot,
  pollingManager?: PollingManager,
  redis?: Redis,
): void {
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
          role: a.role ?? "OWNER",
          receivesLeads: a.receivesLeads,
          unreachableAt: a.unreachableAt?.toISOString() ?? null,
          lang: a.lang,
          createdAt: a.createdAt.toISOString(),
        })),
      });
    },
  );

  app.delete<{ Params: AdminParams }>(
    "/api/v1/bots/:id/admins/:tgId",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id, tgId } = req.params;
      try {
        const tgIdBig = BigInt(tgId);
        await revokeBotAdminRights(prisma, {
          botId: id,
          tgId: tgIdBig,
          redis,
        });
        return reply.send({ ok: true, message: "Admin role revoked" });
      } catch {
        return reply.code(404).send({ ok: false, error: "Admin not found" });
      }
    },
  );

  app.get<{ Params: BotParams; Querystring: LeadsQuery }>(
    "/api/v1/bots/:id/leads",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id } = req.params;
      const statusParam = req.query.status as LeadStatus | undefined;
      const statusFilter =
        statusParam && VALID_LEAD_STATUSES.includes(statusParam) ? statusParam : undefined;

      const [leads, admins] = await Promise.all([
        prisma.lead.findMany({
          where: {
            botId: id,
            ...(statusFilter ? { status: statusFilter } : {}),
          },
          orderBy: { createdAt: "desc" },
          take: 100,
        }),
        prisma.botUser.findMany({
          where: { botId: id, isAdmin: true },
        }),
      ]);

      const adminMap = new Map(
        admins.map((a) => [
          a.tgId.toString(),
          a.firstName ?? (a.username ? `@${a.username}` : a.tgId.toString()),
        ]),
      );

      return reply.send({
        ok: true,
        leads: leads.map((l) => ({
          id: l.id,
          customerTgId: l.customerTgId.toString(),
          customerName: l.customerName,
          customerUsername: l.customerUsername,
          phoneRaw: l.phoneRaw,
          phoneVerified: l.phoneVerified,
          status: l.status,
          assigneeTgId: l.assigneeTgId?.toString() ?? null,
          assigneeName: l.assigneeTgId
            ? (adminMap.get(l.assigneeTgId.toString()) ?? l.assigneeTgId.toString())
            : null,
          assignedAt: l.assignedAt?.toISOString() ?? null,
          statusChangedAt: l.statusChangedAt?.toISOString() ?? null,
          answers: l.answers,
          createdAt: l.createdAt.toISOString(),
        })),
      });
    },
  );

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

      const connection = await checkBotConnection(bot, {
        mode: env.BOT_MODE,
        publicBaseUrl: env.PUBLIC_BASE_URL,
        pollingManager,
        getTelegramBot: getBotInstance
          ? () => getBotInstance(decryptSecret(bot.botTokenEnc, env.TOKEN_ENCRYPTION_KEY), id)
          : undefined,
      });
      return reply.send({
        ok: true,
        health: {
          botId: bot.id,
          isActive: bot.isActive,
          healthStatus: bot.healthStatus,
          lastErrorCode: bot.lastErrorCode,
          lastErrorMsg: bot.lastErrorMsg,
          lastErrorAt: bot.lastErrorAt?.toISOString() ?? null,
          subscriptionStatus: bot.subscription?.status ?? "UNKNOWN",
          failedInboxCount,
          connection,
        },
      });
    },
  );

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
