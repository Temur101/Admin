import type { FastifyInstance } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import * as fs from "node:fs";
import * as path from "node:path";
import { RejectReceiptRequestSchema } from "@lcqb/contracts";
import { authenticateAdmin, type AdminJwtPayload } from "./auth.js";
import { approveReceipt, rejectReceipt } from "../bots/shared/payment-service.js";
import type { TelegramTransport } from "../adapters/telegram/transport.js";
import type { Logger } from "../core/logger.js";
import { env } from "../core/env.js";

interface ReceiptParams {
  id: string;
}

interface ReceiptQuery {
  status?: string;
  botId?: string;
  token?: string;
}

export function registerReceiptsRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  redis: Redis,
  transport: TelegramTransport,
  logger: Logger,
): void {
  // GET /api/v1/receipts - List payment receipts
  app.get<{ Querystring: ReceiptQuery }>(
    "/api/v1/receipts",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { status, botId } = req.query;

      const whereClause: {
        status?: "PENDING" | "APPROVED" | "REJECTED";
        botId?: string;
      } = {};

      if (status && ["PENDING", "APPROVED", "REJECTED"].includes(status)) {
        whereClause.status = status as "PENDING" | "APPROVED" | "REJECTED";
      }

      if (botId) {
        whereClause.botId = botId;
      }

      const receipts = await prisma.paymentReceipt.findMany({
        where: whereClause,
        include: {
          bot: {
            select: {
              id: true,
              botUsername: true,
              botType: true,
              tenant: { select: { id: true, clientName: true } },
            },
          },
        },
        orderBy: { createdAt: "desc" },
      });

      return reply.send({
        ok: true,
        receipts: receipts.map((r) => ({
          id: r.id,
          botId: r.botId,
          botUsername: r.bot.botUsername,
          botType: r.bot.botType,
          tenantName: r.bot.tenant.clientName,
          submittedByTgId: r.submittedByTgId.toString(),
          kind: r.kind,
          imagePath: r.imagePath,
          textNote: r.textNote,
          months: r.months,
          amount: r.amount,
          status: r.status,
          rejectionReason: r.rejectionReason,
          grantedUntil: r.grantedUntil.toISOString(),
          createdAt: r.createdAt.toISOString(),
          reviewedAt: r.reviewedAt?.toISOString() ?? null,
        })),
      });
    },
  );

  // GET /api/v1/receipts/:id/image - Serve receipt screenshot securely
  app.get<{ Params: ReceiptParams; Querystring: ReceiptQuery }>(
    "/api/v1/receipts/:id/image",
    async (req, reply) => {
      // Validate auth via header, cookie, or query token
      try {
        if (req.query.token) {
          const decoded = app.jwt.verify<AdminJwtPayload>(req.query.token, {
            key: env.JWT_ACCESS_SECRET,
          });
          if (!decoded || decoded.tokenType !== "access") {
            return reply.code(401).send({ ok: false, error: "Unauthorized" });
          }
        } else {
          await req.jwtVerify();
          const user = req.user as AdminJwtPayload | undefined;
          if (!user || user.tokenType !== "access") {
            return reply.code(401).send({ ok: false, error: "Unauthorized" });
          }
        }
      } catch {
        return reply.code(401).send({ ok: false, error: "Unauthorized" });
      }

      const { id } = req.params;
      const receipt = await prisma.paymentReceipt.findUnique({ where: { id } });

      if (!receipt || !receipt.imagePath) {
        return reply.code(404).send({ ok: false, error: "Receipt image not found" });
      }

      const baseDir = path.resolve(env.UPLOAD_DIR);
      const fileName = path.basename(receipt.imagePath);
      const safePath = path.resolve(baseDir, fileName);

      if (!safePath.startsWith(baseDir) || !fs.existsSync(safePath)) {
        return reply.code(404).send({ ok: false, error: "Receipt image file not found on disk" });
      }

      const ext = path.extname(safePath).toLowerCase();
      const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";

      const stream = fs.createReadStream(safePath);
      return reply.type(mimeType).send(stream);
    },
  );

  // POST /api/v1/receipts/:id/approve - Approve payment receipt
  app.post<{ Params: ReceiptParams }>(
    "/api/v1/receipts/:id/approve",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id } = req.params;

      const receipt = await approveReceipt({
        prisma,
        redis,
        receiptId: id,
        transport,
        logger,
      });

      if (!receipt) {
        return reply.code(404).send({ ok: false, error: "Receipt not found" });
      }

      const sub = await prisma.subscription.findUnique({
        where: { botId: receipt.botId },
      });

      return reply.send({
        ok: true,
        receipt: {
          id: receipt.id,
          status: receipt.status,
          reviewedAt: receipt.reviewedAt?.toISOString() ?? null,
        },
        subscription: sub
          ? {
              status: sub.status,
              paidUntil: sub.paidUntil?.toISOString() ?? null,
            }
          : null,
      });
    },
  );

  // POST /api/v1/receipts/:id/reject - Reject payment receipt
  app.post<{ Params: ReceiptParams }>(
    "/api/v1/receipts/:id/reject",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id } = req.params;
      const parsed = RejectReceiptRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: "Rejection reason is required",
          issues: parsed.error.issues,
        });
      }

      const receipt = await rejectReceipt({
        prisma,
        redis,
        receiptId: id,
        reason: parsed.data.reason,
        transport,
        logger,
      });

      if (!receipt) {
        return reply.code(404).send({ ok: false, error: "Receipt not found" });
      }

      const sub = await prisma.subscription.findUnique({
        where: { botId: receipt.botId },
      });

      return reply.send({
        ok: true,
        receipt: {
          id: receipt.id,
          status: receipt.status,
          rejectionReason: receipt.rejectionReason,
          reviewedAt: receipt.reviewedAt?.toISOString() ?? null,
        },
        subscription: sub
          ? {
              status: sub.status,
              paidUntil: sub.paidUntil?.toISOString() ?? null,
              failedAttempts: sub.failedReceiptAttempts,
            }
          : null,
      });
    },
  );
}
