import { MIN_LEAD_MINUTES_FLOOR } from "@lcqb/contracts";
import type { PrismaClient } from "@prisma/client";
import { loadEffectiveConfig, lockBotRow, scheduleChangeInTx } from "./setting-changes.js";

/** Recheck under the same lock as owner edits; cancelled history must not disable the baseline. */
export async function ensureInitialMinLead(prisma: PrismaClient, now?: Date): Promise<number> {
  if (!prisma.botSettingChange?.findFirst) return 0;
  const bots = await prisma.bot.findMany({ where: { botType: "QUICKBOOK" }, select: { id: true } });
  let created = 0;
  for (const bot of bots) {
    const scheduled = await prisma.$transaction(async (tx) => {
      if (!(await lockBotRow(tx, bot.id))) return false;
      const at = now ?? new Date();
      const config = await loadEffectiveConfig(tx, bot.id, at);
      if (config?.minLeadMinutes != null) return false;
      const pending = await tx.botSettingChange.findFirst({
        where: { botId: bot.id, kind: "MIN_LEAD", status: "PENDING" },
        select: { id: true },
      });
      if (pending) return false;
      const res = await scheduleChangeInTx(tx, {
        botId: bot.id,
        kind: "MIN_LEAD",
        newValue: MIN_LEAD_MINUTES_FLOOR,
        author: {},
        now: at,
      });
      return res.ok && !res.unchanged;
    });
    if (scheduled) created++;
  }
  return created;
}
