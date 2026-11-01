import type { Prisma, PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { lockBotRow } from "./effective-settings.js";
import { overlayChanges } from "./setting-schedule.js";
type Raw = Record<string, unknown>;

export async function applyDueInTx(
  tx: Prisma.TransactionClient,
  botId: string,
  now: Date,
): Promise<{ applied: number; tokenHash?: string }> {
  const due = await tx.botSettingChange.findMany({
    where: { botId, status: "PENDING", effectiveAt: { lte: now } },
    orderBy: { effectiveAt: "asc" },
  });
  if (due.length === 0) return { applied: 0 };
  const bot = await tx.bot.findUniqueOrThrow({
    where: { id: botId },
    select: { settings: true, botTokenHash: true },
  });
  const settings = (bot.settings ?? {}) as Raw;
  const flat =
    settings.quickbook && typeof settings.quickbook === "object" ? settings.quickbook : settings;
  const services = Array.isArray((flat as Raw).services) ? ((flat as Raw).services as Raw[]) : [];
  const live = due.filter(
    (c) => c.kind === "MIN_LEAD" || services.some((s) => s.id === c.targetId),
  );
  const dead = due.filter((c) => !live.includes(c));
  if (live.length > 0) {
    await tx.bot.update({
      where: { id: botId },
      data: { settings: overlayChanges(settings, live) as Prisma.InputJsonValue },
    });
    await tx.botSettingChange.updateMany({
      where: { id: { in: live.map((c) => c.id) } },
      data: { status: "APPLIED", resolvedAt: now, resolution: "applied" },
    });
  }
  if (dead.length > 0) {
    await tx.botSettingChange.updateMany({
      where: { id: { in: dead.map((c) => c.id) } },
      data: { status: "CANCELLED", resolvedAt: now, resolution: "service removed" },
    });
  }
  return { applied: live.length, tokenHash: bot.botTokenHash };
}

export interface ApplyDueOptions {
  now?: Date;
  redis?: Redis;
  botId?: string;
  tenantResolver?: { invalidate: (botTokenHash: string, botId?: string) => unknown };
}

export async function applyDueChanges(
  prisma: PrismaClient,
  opts: ApplyDueOptions = {},
): Promise<number> {
  if (!prisma.botSettingChange?.findMany) return 0;
  const now = opts.now ?? new Date();
  const rows = await prisma.botSettingChange.findMany({
    where: {
      ...(opts.botId ? { botId: opts.botId } : {}),
      status: "PENDING",
      effectiveAt: { lte: now },
    },
    select: { botId: true },
    distinct: ["botId"],
  });
  let total = 0;
  for (const { botId } of rows) {
    const res = await prisma.$transaction(async (tx) => {
      if (!(await lockBotRow(tx, botId))) return { applied: 0 };
      return applyDueInTx(tx, botId, now);
    });
    total += res.applied;
    if (res.applied > 0) {
      if (opts.tenantResolver && res.tokenHash) {
        await Promise.resolve(opts.tenantResolver.invalidate(res.tokenHash, botId)).catch(() => {});
      } else if (opts.redis) {
        await opts.redis
          .del(`bot:id:${botId}`, ...(res.tokenHash ? [`bot:hash:${res.tokenHash}`] : []))
          .catch(() => {});
      }
    }
  }
  return total;
}
