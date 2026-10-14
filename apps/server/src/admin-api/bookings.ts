import type { FastifyInstance } from "fastify";
import type { PrismaClient, Booking } from "@prisma/client";
import type { Redis } from "ioredis";
import {
  ManualBookingRequestSchema,
  QuickBookConfigSchema,
} from "@lcqb/contracts";
import { authenticateAdmin } from "./auth.js";
import { cancelBooking, createBooking } from "../bots/quickbook/booking-service.js";
import type { TelegramTransport } from "../adapters/telegram/transport.js";
import type { Logger } from "../core/logger.js";

interface BotParams {
  id: string;
}

interface BookingParams {
  id: string;
  bookingId: string;
}

interface BookingQuery {
  status?: string;
  from?: string;
  to?: string;
}

function serializeBooking(b: Booking) {
  return {
    id: b.id,
    botId: b.botId,
    staffId: b.staffId,
    serviceId: b.serviceId,
    serviceName: b.serviceName,
    customerTgId: b.customerTgId ? b.customerTgId.toString() : null,
    customerName: b.customerName ?? "",
    customerPhone: b.customerPhone,
    slotTime: b.slotTime.toISOString(),
    endTime: b.endTime ? b.endTime.toISOString() : null,
    source: b.source,
    status: b.status,
    reminderSent: b.reminderSent,
    createdAt: b.createdAt.toISOString(),
  };
}

export function registerBookingsRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
  redis: Redis,
  transport: TelegramTransport,
  logger: Logger,
): void {
  // GET /api/v1/bots/:id/bookings - List bookings
  app.get<{ Params: BotParams; Querystring: BookingQuery }>(
    "/api/v1/bots/:id/bookings",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id } = req.params;
      const { status, from, to } = req.query;

      const bot = await prisma.bot.findUnique({ where: { id } });
      if (!bot) {
        return reply.code(404).send({ ok: false, error: "Bot not found" });
      }

      const whereClause: {
        botId: string;
        status?: "PENDING" | "CONFIRMED" | "CANCELLED";
        slotTime?: { gte?: Date; lte?: Date };
      } = { botId: id };

      if (status && ["PENDING", "CONFIRMED", "CANCELLED"].includes(status)) {
        whereClause.status = status as "PENDING" | "CONFIRMED" | "CANCELLED";
      }

      if (from || to) {
        whereClause.slotTime = {};
        if (from) whereClause.slotTime.gte = new Date(from);
        if (to) whereClause.slotTime.lte = new Date(to);
      }

      const bookings = await prisma.booking.findMany({
        where: whereClause,
        orderBy: { slotTime: "asc" },
      });

      return reply.send({
        ok: true,
        bookings: bookings.map(serializeBooking),
      });
    },
  );

  // POST /api/v1/bots/:id/bookings - Create manual booking (phone / in-person)
  app.post<{ Params: BotParams }>(
    "/api/v1/bots/:id/bookings",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id } = req.params;
      const parsed = ManualBookingRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({
          ok: false,
          error: "Invalid booking data",
          issues: parsed.error.issues,
        });
      }

      const bot = await prisma.bot.findUnique({ where: { id } });
      if (!bot) {
        return reply.code(404).send({ ok: false, error: "Bot not found" });
      }

      if (bot.botType !== "QUICKBOOK") {
        return reply.code(400).send({
          ok: false,
          error: "Manual bookings are only supported for QuickBook bots",
        });
      }

      const configParsed = QuickBookConfigSchema.safeParse(bot.settings);
      if (!configParsed.success) {
        return reply.code(500).send({
          ok: false,
          error: "Invalid bot QuickBook configuration in database",
        });
      }

      const { serviceId, staffId, slotTime, customerName, customerPhone } = parsed.data;

      const result = await createBooking({
        prisma,
        redis,
        transport,
        logger,
        botId: bot.id,
        customerTgId: null, // Clarification 1: Explicitly null for manual bookings
        customerName,
        customerPhone,
        serviceId,
        staffId,
        slotTime: new Date(slotTime),
        config: configParsed.data,
        source: "MANUAL",
      });

      if (!result.success) {
        if (result.error === "SLOT_TAKEN") {
          return reply.code(409).send({
            ok: false,
            error: "SLOT_TAKEN",
            message: "Slot is already booked",
            alternativeSlots: result.alternativeSlots,
          });
        }

        return reply.code(400).send({
          ok: false,
          error: result.error,
          message: `Booking could not be created: ${result.error}`,
          alternativeSlots: "alternativeSlots" in result ? result.alternativeSlots : undefined,
        });
      }

      return reply.code(201).send({
        ok: true,
        booking: serializeBooking(result.booking),
      });
    },
  );

  // DELETE /api/v1/bots/:id/bookings/:bookingId - Cancel booking
  app.delete<{ Params: BookingParams }>(
    "/api/v1/bots/:id/bookings/:bookingId",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id, bookingId } = req.params;

      const result = await cancelBooking(prisma, redis, {
        bookingId,
        botId: id,
        isAdmin: true,
      });

      if (!result.success) {
        return reply.code(404).send({
          ok: false,
          error: result.error,
        });
      }

      return reply.send({
        ok: true,
        booking: serializeBooking(result.booking),
        alreadyCancelled: result.alreadyCancelled,
      });
    },
  );
}
