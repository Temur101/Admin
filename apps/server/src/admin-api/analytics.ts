import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { authenticateAdmin } from "./auth.js";

export function registerAnalyticsRoutes(
  app: FastifyInstance,
  prisma: PrismaClient,
): void {
  // GET /api/v1/analytics/dashboard - Platform KPI metrics and normalized MRR
  app.get(
    "/api/v1/analytics/dashboard",
    { preHandler: [authenticateAdmin] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      // Counts
      const [
        tenantsTotal,
        botsTotal,
        activeBotsTotal,
        trialBotsTotal,
        leadsTotal,
        bookingsTotal,
        pendingReceiptsTotal,
      ] = await Promise.all([
        prisma.tenant.count(),
        prisma.bot.count(),
        prisma.bot.count({ where: { isActive: true } }),
        prisma.subscription.count({ where: { status: "TRIAL" } }),
        prisma.lead.count(),
        prisma.booking.count(),
        prisma.paymentReceipt.count({ where: { status: "PENDING" } }),
      ]);

      // 1. Normalized MRR Calculation (Clarification 3):
      // Only active recurring subscriptions, normalized to 1 month (amount / months).
      // One-time setup fees are excluded.
      const activeSubscriptions = await prisma.subscription.findMany({
        where: {
          status: "ACTIVE",
          paidUntil: { gte: now },
        },
        include: {
          bot: {
            include: {
              receipts: {
                where: { status: "APPROVED" },
                orderBy: { reviewedAt: "desc" },
                take: 1,
              },
            },
          },
        },
      });

      let normalizedMrr = 0;
      const defaultMonthlyRate = 150000; // Standard single month tariff fallback

      for (const sub of activeSubscriptions) {
        const lastReceipt = sub.bot.receipts[0];
        if (lastReceipt && lastReceipt.months > 0) {
          const monthlyShare = Math.round(lastReceipt.amount / lastReceipt.months);
          normalizedMrr += monthlyShare;
        } else {
          normalizedMrr += defaultMonthlyRate;
        }
      }

      // 2. Cash Collected (Accounted separately from MRR):
      const approvedReceiptsTotal = await prisma.paymentReceipt.aggregate({
        _sum: { amount: true },
        where: { status: "APPROVED" },
      });

      const approvedReceiptsThisMonth = await prisma.paymentReceipt.aggregate({
        _sum: { amount: true },
        where: {
          status: "APPROVED",
          reviewedAt: { gte: startOfMonth },
        },
      });

      // 3. Recent leads and bookings
      const recentLeads = await prisma.lead.findMany({
        take: 5,
        orderBy: { createdAt: "desc" },
        include: { bot: { select: { botUsername: true } } },
      });

      const recentBookings = await prisma.booking.findMany({
        take: 5,
        orderBy: { createdAt: "desc" },
        include: { bot: { select: { botUsername: true } } },
      });

      // 4. Bots breakdown and expiring subscriptions for Dashboard
      const allBots = await prisma.bot.findMany({
        take: 20,
        orderBy: { createdAt: "desc" },
        include: {
          tenant: { select: { clientName: true } },
          subscription: { select: { status: true, paidUntil: true } },
          _count: { select: { leads: true, bookings: true } },
        },
      });

      const threeDaysAhead = new Date(Date.now() + 3 * 24 * 3600 * 1000);
      const expiringIn3DaysCount = await prisma.subscription.count({
        where: {
          status: { in: ["ACTIVE", "TRIAL"] },
          paidUntil: { lte: threeDaysAhead, gte: now },
        },
      });

      return reply.send({
        ok: true,
        metrics: {
          // Recurring normalized metrics
          normalizedMrr,
          mrrUzs: normalizedMrr,
          activeSubscriptionsCount: activeSubscriptions.length,
          activePayingBots: activeSubscriptions.length,

          // Cash receipts accounted separately
          cashCollectedTotal: approvedReceiptsTotal._sum.amount ?? 0,
          cashCollectedTotalUzs: approvedReceiptsTotal._sum.amount ?? 0,
          cashCollectedThisMonth: approvedReceiptsThisMonth._sum.amount ?? 0,
          cashCollectedThisMonthUzs: approvedReceiptsThisMonth._sum.amount ?? 0,

          // System entities
          tenantsTotal,
          botsTotal,
          totalBots: botsTotal,
          activeBotsTotal,
          trialBotsTotal,
          trialBots: trialBotsTotal,
          leadsTotal,
          totalLeadsCount: leadsTotal,
          bookingsTotal,
          totalBookingsCount: bookingsTotal,
          pendingReceiptsTotal,
          pendingReceiptsCount: pendingReceiptsTotal,
          expiringIn3DaysCount,
          inboxErrors24hCount: 0,
          botsBreakdown: allBots.map((b) => ({
            id: b.id,
            botUsername: b.botUsername,
            botType: b.botType,
            tenantName: b.tenant.clientName,
            leadsCount: b._count.leads,
            bookingsCount: b._count.bookings,
            status: b.subscription?.status ?? (b.isActive ? "ACTIVE" : "EXPIRED"),
          })),
        },
        recentActivity: {
          leads: recentLeads.map((l) => ({
            id: l.id,
            botUsername: l.bot.botUsername,
            customerName: l.customerName,
            customerPhone: l.phoneRaw,
            createdAt: l.createdAt.toISOString(),
          })),
          bookings: recentBookings.map((b) => ({
            id: b.id,
            botUsername: b.bot.botUsername,
            customerName: b.customerName,
            customerPhone: b.customerPhone,
            serviceName: b.serviceName,
            slotTime: b.slotTime.toISOString(),
            source: b.source,
            status: b.status,
            createdAt: b.createdAt.toISOString(),
          })),
        },
      });
    },
  );
}
