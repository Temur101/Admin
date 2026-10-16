import { registerBotSetupRoutes } from "./bots-setup.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { Bot } from "grammy";
import type { PrismaClient } from "@prisma/client";
import { CreateBotRequestSchema } from "@lcqb/contracts";
import { authenticateAdmin } from "./auth.js";
import { decryptSecret, encryptSecret, sha256Hex } from "../core/crypto.js";
import { env } from "../core/env.js";
import { notifyPlatformOwner } from "../core/platform-notifier.js";
import type { TenantResolver } from "../gateway/tenant-resolver.js";
import type { Logger } from "../core/logger.js";
import type { TelegramTransport } from "../adapters/telegram/transport.js";
import type { PollingManager } from "../gateway/polling-manager.js";
import { InitialBotSettingsError, resolveInitialBotSettings } from "./initial-bot-settings.js";
import { registerBotsOpsRoutes } from "./bots-ops.js";
import { registerBotsLifecycleRoutes } from "./bots-lifecycle.js";

interface BotParams {
  id: string;
}

export function registerBotsRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  tenantResolver?: TenantResolver,
  logger?: Logger,
  transport?: TelegramTransport,
  pollingManager?: PollingManager,
): void {
  function getBotInstance(token: string, botId = "api-bot"): Bot {
    const b = new Bot(token, { client: { timeoutSeconds: 5 } });
    const transformer = transport?.transformerFor(botId);
    if (transformer) b.api.config.use(transformer);
    return b;
  }

  // GET /api/v1/bots - List bots with stats
  app.get(
    "/api/v1/bots",
    { preHandler: [authenticateAdmin] },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const bots = await prisma.bot.findMany({
        include: {
          tenant: { select: { id: true, clientName: true } },
          subscription: true,
          _count: {
            select: {
              leads: true,
              bookings: true,
              users: true,
              receipts: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      return reply.send({
        ok: true,
        bots: bots.map((b) => ({
          id: b.id,
          tenantId: b.tenantId,
          tenantName: b.tenant.clientName,
          botType: b.botType,
          botUsername: b.botUsername,
          isActive: b.isActive,
          adminInviteCode: b.adminInviteCode,
          createdAt: b.createdAt.toISOString(),
          subscription: b.subscription
            ? {
                status: b.subscription.status,
                trialEndsAt: b.subscription.trialEndsAt.toISOString(),
                paidUntil: b.subscription.paidUntil?.toISOString() ?? null,
              }
            : null,
          stats: {
            leadsCount: b._count.leads,
            bookingsCount: b._count.bookings,
            usersCount: b._count.users,
            receiptsCount: b._count.receipts,
          },
        })),
      });
    },
  );

  // GET /api/v1/bots/:id - Bot details
  app.get<{ Params: BotParams }>(
    "/api/v1/bots/:id",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id } = req.params;
      const bot = await prisma.bot.findUnique({
        where: { id },
        include: {
          tenant: true,
          subscription: true,
          users: { where: { isAdmin: true } },
          _count: {
            select: { leads: true, bookings: true, users: true, receipts: true },
          },
        },
      });

      if (!bot) {
        return reply.code(404).send({ ok: false, error: "Bot not found" });
      }

      return reply.send({
        ok: true,
        bot: {
          id: bot.id,
          tenantId: bot.tenantId,
          tenant: bot.tenant,
          tenantName: bot.tenant.clientName,
          botType: bot.botType,
          botUsername: bot.botUsername,
          isActive: bot.isActive,
          adminInviteCode: bot.adminInviteCode,
          inviteLink: bot.botUsername
            ? `https://t.me/${bot.botUsername}?start=adm_${bot.adminInviteCode}`
            : null,
          settings: bot.settings,
          createdAt: bot.createdAt.toISOString(),
          subscription: bot.subscription
            ? {
                status: bot.subscription.status,
                trialEndsAt: bot.subscription.trialEndsAt.toISOString(),
                paidUntil: bot.subscription.paidUntil?.toISOString() ?? null,
              }
            : null,
          admins: bot.users.map((u) => ({
            tgId: u.tgId.toString(),
            firstName: u.firstName,
            username: u.username,
            createdAt: u.createdAt.toISOString(),
          })),
          stats: {
            leadsCount: bot._count.leads,
            bookingsCount: bot._count.bookings,
            usersCount: bot._count.users,
            receiptsCount: bot._count.receipts,
          },
        },
      });
    },
  );

  // POST /api/v1/bots - Register and connect bot
  app.post(
    "/api/v1/bots",
    { preHandler: [authenticateAdmin] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateBotRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ ok: false, error: "Invalid bot data", issues: parsed.error.issues });
      }

      const { tenantId, botType, botToken, startPaused } = parsed.data;
      let initialSettings;
      try {
        initialSettings = resolveInitialBotSettings(parsed.data);
      } catch (error) {
        if (error instanceof InitialBotSettingsError)
          return reply.code(error.statusCode).send({ ok: false, error: error.message });
        throw error;
      }

      const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
      if (!tenant) {
        return reply.code(404).send({ ok: false, error: "Tenant not found" });
      }

      let botUsername: string | null = null;
      try {
        const tgBot = getBotInstance(botToken, "token-verify");
        const me = await tgBot.api.getMe();
        botUsername = me.username ?? null;
      } catch {
        return reply.code(400).send({
          ok: false,
          error: "Invalid Telegram bot token or Telegram unreachable",
        });
      }

      const botTokenHash = sha256Hex(botToken);
      const existing = await prisma.bot.findUnique({ where: { botTokenHash } });
      if (existing) {
        return reply.code(409).send({ ok: false, error: "Bot token is already registered" });
      }

      const botTokenEnc = encryptSecret(botToken, env.TOKEN_ENCRYPTION_KEY);
      const webhookSecret = randomBytes(32).toString("hex");
      const adminInviteCode = randomBytes(16).toString("hex");

      const trialDays = env.TRIAL_DAYS_DEFAULT;
      const trialEndsAt = new Date(Date.now() + trialDays * 86400 * 1000);

      const bot = await prisma.$transaction(async (tx) => {
        const createdBot = await tx.bot.create({
          data: {
            tenantId,
            botType,
            botTokenEnc,
            botTokenHash,
            webhookSecret,
            botUsername,
            adminInviteCode,
            settings: initialSettings,
            isActive: !startPaused,
          },
        });

        await tx.subscription.create({
          data: {
            botId: createdBot.id,
            status: "TRIAL",
            trialEndsAt,
          },
        });

        return createdBot;
      });

      let webhookWarning: string | null = null;
      if (bot.isActive && env.BOT_MODE === "polling") {
        if (pollingManager) {
          await pollingManager.start(bot.id);
        }
      } else if (bot.isActive) {
        if (!env.PUBLIC_BASE_URL) {
          webhookWarning = "PUBLIC_BASE_URL is empty; Telegram webhook registration skipped";
          logger?.warn({ botId: bot.id }, webhookWarning);
        } else {
          try {
            const tgBot = getBotInstance(botToken, bot.id);
            const webhookUrl = `${env.PUBLIC_BASE_URL}/api/v1/tg/webhook/${botTokenHash}`;
            await tgBot.api.setWebhook(webhookUrl, {
              secret_token: webhookSecret,
              drop_pending_updates: false,
            });
          } catch (err) {
            logger?.error(
              { err, botId: bot.id },
              "Failed to set webhook in Telegram during bot creation",
            );
            webhookWarning = err instanceof Error ? err.message : String(err);
          }
        }
      }

      await notifyPlatformOwner(
        {
          type: "BOT_REGISTERED",
          botType,
          clientName: tenant.clientName,
          botUsername: botUsername ?? bot.id,
          botId: bot.id,
        },
        { prisma },
      ).catch(() => {});

      return reply.code(201).send({
        ok: true,
        bot: {
          id: bot.id,
          tenantId: bot.tenantId,
          botType: bot.botType,
          botUsername: bot.botUsername,
          isActive: bot.isActive,
          adminInviteCode: bot.adminInviteCode,
          inviteLink: botUsername
            ? `https://t.me/${botUsername}?start=adm_${adminInviteCode}`
            : null,
          trialEndsAt: trialEndsAt.toISOString(),
          ...(webhookWarning ? { warning: webhookWarning } : {}),
        },
      });
    },
  );

  // Register bot lifecycle routes (suspend, resume, purge, reissue-invite)
  registerBotsLifecycleRoutes(app, prisma, tenantResolver, logger, getBotInstance, pollingManager);

  // Register operations and diagnostic routes (admins, extend, unblock, health, webhooks)
  registerBotsOpsRoutes(app, prisma, tenantResolver, getBotInstance, pollingManager);
  registerBotSetupRoutes(app, prisma, {
    mode: env.BOT_MODE,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    pollingManager,
    getTelegramBot: (bot) =>
      getBotInstance(decryptSecret(bot.botTokenEnc, env.TOKEN_ENCRYPTION_KEY), bot.id),
    invalidate: (bot) => tenantResolver?.invalidate(bot.botTokenHash, bot.id),
  });
}
