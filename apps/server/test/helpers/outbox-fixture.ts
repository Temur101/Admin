import type { Prisma, PrismaClient, NotificationDelivery } from "@prisma/client";

/** In-memory DB boundary for quiz-only unit tests; real transaction/lease tests use PostgreSQL. */
export function attachOutboxFixture(prisma: PrismaClient): void {
  const rows = new Map<string, NotificationDelivery>();
  const recipient = { tgId: -1n, isAdmin: true, receivesLeads: true };
  const findUser = prisma.botUser?.findUnique?.bind(prisma.botUser);
  Object.assign(prisma, {
    $transaction: async (run: (tx: Prisma.TransactionClient) => Promise<unknown>) => run(prisma as unknown as Prisma.TransactionClient),
    botUser: { ...prisma.botUser, findMany: async () => [recipient], findUnique: async (query: { where: { botId_tgId: { tgId: bigint } } }) => query.where.botId_tgId.tgId === recipient.tgId ? recipient : findUser?.(query as Parameters<PrismaClient["botUser"]["findUnique"]>[0]) },
    notificationDelivery: {
      createMany: async ({ data }: { data: Prisma.NotificationDeliveryCreateManyInput[] }) => {
        for (const item of data) {
          const key = `${item.eventKey}:${item.recipientTgId}`;
          if (!rows.has(key)) rows.set(key, { ...item, id: key, attempts: 0, status: "PENDING", availableAt: new Date(), createdAt: new Date(), lockedUntil: null, leaseToken: null, lastError: null, deliveredAt: null } as NotificationDelivery);
        }
        return { count: data.length };
      },
      findMany: async ({ where }: { where: { eventKey?: string; availableAt?: { lte: Date }; attempts: { gte?: number } } }) => where.attempts.gte != null ? [] : [...rows.values()].filter(r => (!where.eventKey || where.eventKey === r.eventKey) && r.status === "PENDING" && (!where.availableAt || r.availableAt <= where.availableAt.lte)),
      updateMany: async ({ where, data }: { where: { id: string; status?: string; leaseToken?: string; OR?: unknown }; data: Omit<Partial<NotificationDelivery>, "attempts"> & { attempts?: number | { increment: number } } }) => {
        const row = rows.get(where.id);
        if (!row || (where.status && row.status !== where.status) || (where.leaseToken && row.leaseToken !== where.leaseToken) || (where.OR && row.status !== "PENDING")) return { count: 0 };
        const attempts = typeof data.attempts === "object" ? row.attempts + data.attempts.increment : row.attempts;
        Object.assign(row, data, { attempts }); return { count: 1 };
      },
    },
  });
}
