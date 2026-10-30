import { getQuickBookConfig } from "./config-resolver.js";
import type { Booking, PrismaClient, TimeBlock } from "@prisma/client";

export interface CreateTimeBlockParams {
  botId: string;
  resourceId: string; // "all" or specific staff ID
  startsAt: Date;
  endsAt: Date;
  reason?: string | null;
  createdByTgId?: number | bigint | null;
  confirmConflicts?: boolean;
}

export class TimeBlockConflictError extends Error {
  constructor(readonly bookings: Booking[]) {
    super("CONFLICTS_DETECTED");
  }
}

export interface ListTimeBlocksParams {
  botId: string;
  resourceId?: string;
  from?: Date;
  to?: Date;
}

export async function createTimeBlock(
  prisma: PrismaClient,
  params: CreateTimeBlockParams,
): Promise<TimeBlock> {
  const { botId, resourceId, startsAt, endsAt, reason, createdByTgId } = params;
  if (
    !Number.isFinite(startsAt.getTime()) ||
    !Number.isFinite(endsAt.getTime()) ||
    startsAt >= endsAt
  ) {
    throw new Error("INVALID_TIME_RANGE: startsAt must be before endsAt");
  }

  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`calendar:${botId}`}));`;
      const bot = await tx.bot.findUnique({ where: { id: botId } });
      const config = getQuickBookConfig(bot?.settings as Record<string, unknown> | undefined);
      if (!bot || (resourceId !== "all" && !config.resources.some((r) => r.id === resourceId)))
        throw new Error("RESOURCE_NOT_FOUND");
      const bookings = await tx.booking.findMany({
        where: {
          botId,
          ...(resourceId !== "all" ? { staffId: resourceId } : {}),
          status: { in: ["PENDING", "CONFIRMED"] },
          slotTime: { lt: endsAt },
          endTime: { gt: startsAt },
        },
      });
      if (bookings.length && !params.confirmConflicts) throw new TimeBlockConflictError(bookings);
      return tx.timeBlock.create({
        data: {
          botId,
          resourceId,
          startsAt,
          endsAt,
          reason: reason?.trim() || null,
          createdByTgId: createdByTgId != null ? BigInt(createdByTgId) : null,
        },
      });
    },
    { maxWait: 15000, timeout: 20000 },
  );
}

export async function deleteTimeBlock(
  prisma: PrismaClient,
  params: { botId: string; blockId: string },
): Promise<{ success: boolean; error?: string }> {
  const { botId, blockId } = params;
  const block = await prisma.timeBlock.findUnique({
    where: { id: blockId },
  });
  if (!block || block.botId !== botId) {
    return { success: false, error: "NOT_FOUND" };
  }

  await prisma.timeBlock.delete({ where: { id: blockId } });
  return { success: true };
}

export async function listTimeBlocks(
  prisma: PrismaClient,
  params: ListTimeBlocksParams,
): Promise<TimeBlock[]> {
  const { botId, resourceId, from, to } = params;

  return prisma.timeBlock.findMany({
    where: {
      botId,
      ...(resourceId ? { resourceId: { in: [resourceId, "all"] } } : {}),
      ...(from ? { endsAt: { gt: from } } : {}),
      ...(to ? { startsAt: { lt: to } } : {}),
    },
    orderBy: { startsAt: "asc" },
  });
}
