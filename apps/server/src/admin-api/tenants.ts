import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { CreateTenantRequestSchema } from "@lcqb/contracts";
import { authenticateAdmin } from "./auth.js";

export function registerTenantRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
): void {
  // List tenants
  app.get(
    "/api/v1/tenants",
    { preHandler: [authenticateAdmin] },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const tenants = await prisma.tenant.findMany({
        orderBy: { createdAt: "desc" },
        include: {
          bots: {
            select: {
              id: true,
              botType: true,
              botUsername: true,
              isActive: true,
              subscription: {
                select: {
                  status: true,
                  trialEndsAt: true,
                  paidUntil: true,
                },
              },
            },
          },
        },
      });

      const formatted = tenants.map((t) => ({
        id: t.id,
        clientName: t.clientName,
        contactPhone: t.contactPhone,
        status: t.status,
        createdAt: t.createdAt.toISOString(),
        botsCount: t.bots.length,
        bots: t.bots.map((b) => ({
          id: b.id,
          botType: b.botType,
          botUsername: b.botUsername,
          isActive: b.isActive,
          subscriptionStatus: b.subscription?.status ?? "TRIAL",
          paidUntil: b.subscription?.paidUntil?.toISOString() ?? null,
          trialEndsAt: b.subscription?.trialEndsAt.toISOString() ?? null,
        })),
      }));

      return reply.code(200).send({ ok: true, tenants: formatted });
    },
  );

  // Create tenant
  app.post(
    "/api/v1/tenants",
    { preHandler: [authenticateAdmin] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = CreateTenantRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ ok: false, error: "Invalid tenant data", details: parsed.error.format() });
      }

      const { clientName, contactPhone } = parsed.data;
      const tenant = await prisma.tenant.create({
        data: {
          clientName,
          contactPhone,
          status: "ACTIVE",
        },
      });

      return reply.code(201).send({
        ok: true,
        tenant: {
          id: tenant.id,
          clientName: tenant.clientName,
          contactPhone: tenant.contactPhone,
          status: tenant.status,
          createdAt: tenant.createdAt.toISOString(),
        },
      });
    },
  );

  // Deactivate tenant
  app.delete<{ Params: { id: string } }>(
    "/api/v1/tenants/:id",
    { preHandler: [authenticateAdmin] },
    async (req, reply) => {
      const { id } = req.params;

      const tenant = await prisma.tenant.findUnique({
        where: { id },
      });

      if (!tenant) {
        return reply.code(404).send({ ok: false, error: "Tenant not found" });
      }

      await prisma.tenant.update({
        where: { id },
        data: { status: "SUSPENDED" },
      });

      return reply.code(200).send({ ok: true, message: "Tenant deactivated" });
    },
  );
}
