import type { PrismaClient, TimeBlock } from "@prisma/client";

export interface CreateTimeBlockParams {
  botId: string;
  resourceId: string; // "all" or specific staff ID
  startsAt: Date;
  endsAt: Date;
  reason?: string | null;
  createdByTgId?: number | bigint | null;
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
  if (startsAt >= endsAt) {
    throw new Error("INVALID_TIME_RANGE: startsAt must be before endsAt");
  }

  return prisma.timeBlock.create({
    data: {
      botId,
      resourceId,
      startsAt,
      endsAt,
      reason: reason?.trim() || null,
      createdByTgId: createdByTgId != null ? BigInt(createdByTgId) : null,
    },
  });
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
