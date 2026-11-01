import type { Prisma, PrismaClient } from "@prisma/client";
import type { QuickBookConfig } from "@lcqb/contracts";
import { getQuickBookConfig } from "./config-resolver.js";
import { overlayChanges } from "./setting-schedule.js";
type Db = PrismaClient | Prisma.TransactionClient;
type Raw = Record<string, unknown>;

export async function lockBotRow(tx: Prisma.TransactionClient, botId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM "Bot" WHERE id = ${botId}::uuid FOR UPDATE`;
  return rows.length > 0;
}

export async function loadEffectiveSettings(
  db: Db,
  botId: string,
  now = new Date(),
): Promise<Raw | null> {
  const bot = await db.bot.findUnique({
    where: { id: botId },
    select: {
      settings: true,
      settingChanges: {
        where: { status: "PENDING", effectiveAt: { lte: now } },
        orderBy: { effectiveAt: "asc" },
      },
    },
  });
  return bot ? overlayChanges((bot.settings ?? {}) as Raw, bot.settingChanges) : null;
}

export async function loadEffectiveConfig(
  db: Db,
  botId: string,
  now = new Date(),
): Promise<QuickBookConfig | null> {
  const settings = await loadEffectiveSettings(db, botId, now);
  if (!settings) return null;
  const config = getQuickBookConfig(settings);
  return config.services.length > 0 ? config : null;
}
