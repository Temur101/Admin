import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import {
  ExtendSubscriptionRequestSchema,
  ReduceSubscriptionRequestSchema,
  GrantTrialRequestSchema,
} from "@lcqb/contracts";
import { authenticateAdmin } from "./auth.js";
import type { TenantResolver } from "../gateway/tenant-resolver.js";

interface BotParams {
  id: string;
}

export function registerBotsSubscriptionRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  tenantResolver?: TenantResolver,
): void {
  // POST /api/v1/bots/:id/extend - Manual subscription extension
  app.post<{ Params: BotParams }>(
    "/api/v1/bots/:id/extend",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id } = req.params;
      const parsed = ExtendSubscriptionRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: "Некорректное количество дней для продления (от 1 до 3650).",
        });
      }
      const { days } = parsed.data;

      const txResult = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sub:${id}`}));`;
        const sub = await tx.subscription.findUnique({
          where: { botId: id },
          include: { bot: { select: { id: true, botTokenHash: true } } },
        });
        if (!sub) {
          return null;
        }

        const now = Date.now();
        const currentEnd = Math.max(
          now,
          sub.paidUntil ? sub.paidUntil.getTime() : sub.trialEndsAt.getTime(),
        );
        const newPaidUntil = new Date(currentEnd + days * 86400 * 1000);

        const updated = await tx.subscription.update({
          where: { botId: id },
          data: {
            paidUntil: newPaidUntil,
            status: "ACTIVE",
            failedReceiptAttempts: 0,
          },
        });

        return { updated, bot: sub.bot };
      });

      if (!txResult) {
        return reply.code(404).send({ ok: false, error: "Subscription not found" });
      }

      await tenantResolver?.invalidate(txResult.bot.botTokenHash, txResult.bot.id);

      return reply.send({
        ok: true,
        subscription: {
          status: txResult.updated.status,
          trialEndsAt: txResult.updated.trialEndsAt.toISOString(),
          paidUntil: txResult.updated.paidUntil?.toISOString() ?? null,
        },
      });
    },
  );

  // POST /api/v1/bots/:id/reduce - Manual subscription reduction
  app.post<{ Params: BotParams }>(
    "/api/v1/bots/:id/reduce",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id } = req.params;
      const parsed = ReduceSubscriptionRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: "Некорректное количество дней для сокращения (от 1 до 3650).",
        });
      }
      const { days } = parsed.data;

      const txResult = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sub:${id}`}));`;
        const sub = await tx.subscription.findUnique({
          where: { botId: id },
          include: { bot: { select: { id: true, botTokenHash: true } } },
        });
        if (!sub) {
          return { kind: "not_found" as const };
        }

        const now = Date.now();
        if (sub.status === "TRIAL") {
          const target = sub.trialEndsAt.getTime() - days * 86400 * 1000;
          const isExpired = target <= now;
          const updated = await tx.subscription.update({
            where: { botId: id },
            data: {
              trialEndsAt: new Date(target),
              status: isExpired ? "EXPIRED" : "TRIAL",
            },
          });
          return { kind: "ok" as const, updated, bot: sub.bot };
        }

        if (!sub.paidUntil) {
          return { kind: "no_paid_until" as const };
        }

        const target = sub.paidUntil.getTime() - days * 86400 * 1000;
        const isExpired = target <= now;
        const updated = await tx.subscription.update({
          where: { botId: id },
          data: {
            paidUntil: new Date(target),
            status: isExpired ? "EXPIRED" : "ACTIVE",
          },
        });

        return { kind: "ok" as const, updated, bot: sub.bot };
      });

      if (txResult.kind === "not_found") {
        return reply.code(404).send({ ok: false, error: "Subscription not found" });
      }
      if (txResult.kind === "no_paid_until") {
        return reply
          .code(400)
          .send({ ok: false, error: "Нечего уменьшать: у бота нет оплаченного периода" });
      }

      await tenantResolver?.invalidate(txResult.bot.botTokenHash, txResult.bot.id);

      return reply.send({
        ok: true,
        subscription: {
          status: txResult.updated.status,
          trialEndsAt: txResult.updated.trialEndsAt.toISOString(),
          paidUntil: txResult.updated.paidUntil?.toISOString() ?? null,
        },
      });
    },
  );

  // POST /api/v1/bots/:id/trial - Grant trial period
  app.post<{ Params: BotParams }>(
    "/api/v1/bots/:id/trial",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id } = req.params;
      const parsed = GrantTrialRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: "Некорректное количество дней для пробного периода (от 1 до 365).",
        });
      }
      const { days } = parsed.data;

      const txResult = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`sub:${id}`}));`;
        const sub = await tx.subscription.findUnique({
          where: { botId: id },
          include: { bot: { select: { id: true, botTokenHash: true } } },
        });
        if (!sub) {
          return { kind: "not_found" as const };
        }

        const now = Date.now();
        if (sub.status === "ACTIVE" && sub.paidUntil && sub.paidUntil.getTime() > now) {
          return { kind: "conflict" as const };
        }

        const newTrialEndsAt = new Date(now + days * 86400 * 1000);
        const updated = await tx.subscription.update({
          where: { botId: id },
          data: {
            status: "TRIAL",
            trialEndsAt: newTrialEndsAt,
            paidUntil: null,
            failedReceiptAttempts: 0,
          },
        });

        return { kind: "ok" as const, updated, bot: sub.bot };
      });

      if (txResult.kind === "not_found") {
        return reply.code(404).send({ ok: false, error: "Subscription not found" });
      }
      if (txResult.kind === "conflict") {
        return reply
          .code(409)
          .send({ ok: false, error: "У бота есть активная оплаченная подписка" });
      }

      await tenantResolver?.invalidate(txResult.bot.botTokenHash, txResult.bot.id);

      return reply.send({
        ok: true,
        subscription: {
          status: txResult.updated.status,
          trialEndsAt: txResult.updated.trialEndsAt.toISOString(),
          paidUntil: null,
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
      const sub = await prisma.subscription.findUnique({
        where: { botId: id },
        include: { bot: { select: { id: true, botTokenHash: true } } },
      });
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

      await tenantResolver?.invalidate(sub.bot.botTokenHash, sub.bot.id);

      return reply.send({
        ok: true,
        status: updated.status,
      });
    },
  );
}
