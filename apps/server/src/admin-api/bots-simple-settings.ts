import { bookingSetupIssues } from "@lcqb/contracts/validation";
import type { TenantResolver } from "../gateway/tenant-resolver.js";
import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { z } from "zod";
import { authenticateAdmin } from "./auth.js";
import {
  createTimeBlock,
  deleteTimeBlock,
  listTimeBlocks,
  TimeBlockConflictError,
} from "../bots/quickbook/time-block-service.js";
import { findAffectedBookings } from "../bots/quickbook/conflict-checker.js";
import { getQuickBookConfig } from "../bots/quickbook/config-resolver.js";
import type { QuickBookConfig } from "@lcqb/contracts";

const SimpleSettingsSchema = z.object({
  prices: z
    .array(
      z.object({
        serviceId: z.string().min(1),
        priceUzs: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  welcomeMessage: z
    .object({
      ru: z.string().optional(),
      uz: z.string().optional(),
    })
    .optional(),
  workHours: z
    .object({
      resourceId: z.string().optional(),
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
      workDays: z.array(z.number().int().min(0).max(6)).optional(),
    })
    .optional(),
  confirmConflicts: z.boolean().optional(),
});

const CreateTimeBlockSchema = z.object({
  resourceId: z.string().min(1),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  reason: z.string().max(255).optional(),
  confirmConflicts: z.boolean().optional(),
});

interface BotParams {
  id: string;
}

interface BlockParams {
  id: string;
  blockId: string;
}

export function registerBotsSimpleSettingsRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  redis?: Redis,
  tenantResolver?: TenantResolver,
): void {
  // PATCH /api/v1/bots/:id/simple-settings
  app.patch<{ Params: BotParams }>(
    "/api/v1/bots/:id/simple-settings",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id } = req.params;
      const parsed = SimpleSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "VALIDATION_ERROR", details: parsed.error.issues });
      }

      const bot = await prisma.bot.findUnique({ where: { id } });
      if (!bot) {
        return reply.status(404).send({ error: "Bot not found" });
      }

      const { prices, welcomeMessage, workHours, confirmConflicts } = parsed.data;
      const currentSettings = (bot.settings ?? {}) as Record<string, unknown>;

      if (bot.botType === "QUICKBOOK") {
        const config: QuickBookConfig = getQuickBookConfig(currentSettings);

        // Apply price updates
        if (prices && prices.length > 0) {
          for (const p of prices) {
            const s = config.services.find((item) => item.id === p.serviceId);
            if (!s) return reply.code(400).send({ error: "SERVICE_NOT_FOUND" });
            s.priceUzs = p.priceUzs;
          }
        }

        // Apply welcome message
        if (welcomeMessage) {
          config.customTexts = config.customTexts ?? {};
          config.customTexts.welcome = {
            ru: welcomeMessage.ru ?? config.customTexts.welcome?.ru ?? "",
            uz: welcomeMessage.uz ?? config.customTexts.welcome?.uz ?? "",
          };
        }

        // Apply work hours & check conflicts
        if (workHours) {
          const targetResources = workHours.resourceId
            ? config.resources.filter((r) => r.id === workHours.resourceId)
            : config.resources;

          if (!targetResources.length) return reply.code(400).send({ error: "RESOURCE_NOT_FOUND" });
          for (const res of targetResources) {
            res.workHours = { start: workHours.start, end: workHours.end };
            if (workHours.workDays) {
              res.workDays = workHours.workDays;
            }
          }

          const issues = bookingSetupIssues(config);
          if (issues.length)
            return reply.code(400).send({ error: "VALIDATION_ERROR", details: issues });
          const conflictCheck = await findAffectedBookings({
            botId: id,
            prisma,
            newSettings: config,
          });

          if (conflictCheck.hasConflicts && !confirmConflicts) {
            return reply.status(409).send({
              error: "CONFLICTS_DETECTED",
              affectedCount: conflictCheck.affectedCount,
              affectedBookings: conflictCheck.affectedBookings,
            });
          }
        }

        const issues = bookingSetupIssues(config);
        if (issues.length)
          return reply.code(400).send({ error: "VALIDATION_ERROR", details: issues });
        await prisma.bot.update({
          where: { id },
          data: { settings: config as unknown as object },
        });
      } else {
        // LEADCATCH
        if (welcomeMessage) {
          const merged = { ...currentSettings, welcomeMessage };
          await prisma.bot.update({
            where: { id },
            data: { settings: merged as unknown as object },
          });
        }
      }

      // Record audit log
      const adminId = (req.user as { adminId?: string })?.adminId ?? null;
      await prisma.botSettingsLog.create({
        data: {
          botId: id,
          changedByAdminId: adminId,
          changes: parsed.data as unknown as object,
        },
      });

      // Invalidate Redis caches
      if (tenantResolver) await tenantResolver.invalidate(bot.botTokenHash, id);
      else if (redis) await redis.del(`bot:hash:${bot.botTokenHash}`, `bot:id:${id}`);

      return reply.send({ ok: true });
    },
  );

  // GET /api/v1/bots/:id/time-blocks
  app.get<{ Params: BotParams; Querystring: { resourceId?: string; from?: string; to?: string } }>(
    "/api/v1/bots/:id/time-blocks",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id } = req.params;
      const { resourceId, from, to } = req.query;

      const blocks = await listTimeBlocks(prisma, {
        botId: id,
        resourceId,
        from: from ? new Date(from) : undefined,
        to: to ? new Date(to) : undefined,
      });

      return reply.send({ timeBlocks: blocks });
    },
  );

  // POST /api/v1/bots/:id/time-blocks
  app.post<{ Params: BotParams }>(
    "/api/v1/bots/:id/time-blocks",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id } = req.params;
      const parsed = CreateTimeBlockSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: "VALIDATION_ERROR", details: parsed.error.issues });
      }

      const { resourceId, startsAt, endsAt, reason, confirmConflicts } = parsed.data;
      const startDate = new Date(startsAt);
      const endDate = new Date(endsAt);

      if (startDate >= endDate) {
        return reply.status(400).send({ error: "startsAt must be before endsAt" });
      }

      try {
        const block = await createTimeBlock(prisma, {
          botId: id,
          resourceId,
          startsAt: startDate,
          endsAt: endDate,
          reason,
          confirmConflicts,
        });
        return reply.status(201).send({ ok: true, timeBlock: block });
      } catch (error) {
        if (error instanceof TimeBlockConflictError)
          return reply
            .code(409)
            .send({
              error: "CONFLICTS_DETECTED",
              affectedCount: error.bookings.length,
              affectedBookings: error.bookings,
            });
        if ((error as Error).message === "RESOURCE_NOT_FOUND")
          return reply.code(400).send({ error: "RESOURCE_NOT_FOUND" });
        throw error;
      }
    },
  );

  // DELETE /api/v1/bots/:id/time-blocks/:blockId
  app.delete<{ Params: BlockParams }>(
    "/api/v1/bots/:id/time-blocks/:blockId",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id, blockId } = req.params;
      const res = await deleteTimeBlock(prisma, { botId: id, blockId });
      if (!res.success) {
        return reply.status(404).send({ error: "TimeBlock not found" });
      }
      return reply.send({ ok: true });
    },
  );
}
