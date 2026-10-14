import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { UpdatePlatformSettingsRequestSchema } from "@lcqb/contracts";
import { authenticateAdmin } from "./auth.js";
import { encryptSecret } from "../core/crypto.js";
import { env } from "../core/env.js";
import { notifyPlatformOwner } from "../core/platform-notifier.js";

export function registerSettingsRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
): void {
  // GET /api/v1/settings - Get platform settings
  app.get(
    "/api/v1/settings",
    { preHandler: [authenticateAdmin] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      let settings = await prisma.platformSettings.findUnique({ where: { id: 1 } });
      if (!settings) {
        settings = await prisma.platformSettings.create({
          data: {
            id: 1,
            paymentDetails: "8600 0000 0000 0000 (Uzcard)",
            tariffs: [
              { months: 1, priceUzs: 150000 },
              { months: 3, priceUzs: 400000 },
              { months: 12, priceUzs: 1400000 },
            ],
            supportContact: "@support",
            paymentInstructions: "Пришлите скриншот чека об оплате прямо в этот чат.",
          },
        });
      }

      return reply.send({
        ok: true,
        settings: {
          id: settings.id,
          paymentDetails: settings.paymentDetails,
          tariffs: settings.tariffs,
          supportContact: settings.supportContact,
          hasAlertBotToken: !!settings.alertBotTokenEnc,
          alertChatId: settings.alertChatId ?? null,
          alertBotUsername: settings.alertBotUsername,
          paymentInstructions: settings.paymentInstructions,
          maintenanceMode: settings.maintenanceMode,
          updatedAt: settings.updatedAt.toISOString(),
        },
      });
    },
  );

  // PUT /api/v1/settings - Update platform settings
  app.put(
    "/api/v1/settings",
    { preHandler: [authenticateAdmin] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = UpdatePlatformSettingsRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: "Invalid settings format",
          issues: parsed.error.issues,
        });
      }

      const {
        paymentDetails,
        tariffs,
        supportContact,
        alertBotToken,
        alertChatId,
        alertBotUsername,
        paymentInstructions,
        maintenanceMode,
      } = parsed.data;

      const updateData: Record<string, unknown> = {};

      if (paymentDetails !== undefined) updateData.paymentDetails = paymentDetails;
      if (tariffs !== undefined) updateData.tariffs = tariffs;
      if (supportContact !== undefined) updateData.supportContact = supportContact;
      if (paymentInstructions !== undefined) updateData.paymentInstructions = paymentInstructions;
      if (maintenanceMode !== undefined) updateData.maintenanceMode = maintenanceMode;
      if (alertBotUsername !== undefined) updateData.alertBotUsername = alertBotUsername;

      if (alertBotToken) {
        updateData.alertBotTokenEnc = encryptSecret(
          alertBotToken,
          env.TOKEN_ENCRYPTION_KEY,
        );
      }

      if (alertChatId !== undefined) {
        updateData.alertChatId = alertChatId ? String(alertChatId).trim() : null;
      }

      const updated = await prisma.platformSettings.upsert({
        where: { id: 1 },
        create: {
          id: 1,
          paymentDetails: paymentDetails ?? "8600 0000 0000 0000",
          tariffs: tariffs ?? [
            { months: 1, priceUzs: 150000 },
            { months: 3, priceUzs: 400000 },
          ],
          supportContact: supportContact ?? "@support",
          paymentInstructions: paymentInstructions ?? "Пришлите чек об оплате.",
          maintenanceMode: maintenanceMode ?? false,
          ...(updateData as object),
        },
        update: updateData,
      });

      return reply.send({
        ok: true,
        settings: {
          id: updated.id,
          paymentDetails: updated.paymentDetails,
          tariffs: updated.tariffs,
          supportContact: updated.supportContact,
          hasAlertBotToken: !!updated.alertBotTokenEnc,
          alertChatId: updated.alertChatId ?? null,
          alertBotUsername: updated.alertBotUsername,
          paymentInstructions: updated.paymentInstructions,
          maintenanceMode: updated.maintenanceMode,
          updatedAt: updated.updatedAt.toISOString(),
        },
      });
    },
  );

  // POST /api/v1/settings/test-alert - Send test notification to platform alert channel
  app.post(
    "/api/v1/settings/test-alert",
    { preHandler: [authenticateAdmin] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const sent = await notifyPlatformOwner(
        {
          type: "NEW_RECEIPT",
          botName: "@test_bot",
          clientName: "Тестовый клиент",
          phone: "+998901234567",
          tariffMonths: 1,
          amountUzs: 150000,
          receiptId: "test-receipt-id",
        },
        { prisma },
      );

      return reply.send({
        ok: true,
        dispatched: sent,
        message: sent
          ? "Test alert sent to Telegram channel/admin"
          : "Alert bot not configured or sending failed. Check ALERT_BOT_TOKEN and ALERT_CHAT_ID.",
      });
    },
  );
}
