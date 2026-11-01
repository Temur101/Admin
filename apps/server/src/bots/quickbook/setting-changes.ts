import { loadEffectiveConfig, lockBotRow } from "./effective-settings.js";
import { applyDueInTx } from "./setting-change-activation.js";
export { loadEffectiveConfig, loadEffectiveSettings, lockBotRow } from "./effective-settings.js";
export { applyDueChanges } from "./setting-change-activation.js";
export { applyDueInTx };
import type { Prisma, PrismaClient, BotSettingChange, SettingChangeKind } from "@prisma/client";
import { MAX_PRICE_UZS, MIN_LEAD_MINUTES_FLOOR, type QuickBookConfig } from "@lcqb/contracts";
import { tashkentDateString } from "./booking-horizon.js";
import {
  addDaysToDateString,
  dateStartAt,
  findNextWorkingDate,
  MAX_LOOKAHEAD_DAYS,
} from "./setting-schedule.js";

type Db = PrismaClient | Prisma.TransactionClient;

export interface ChangeAuthor {
  tgId?: bigint | number | null;
  adminId?: string | null;
}

export type SettingChangeError =
  "INVALID_VALUE" | "SERVICE_NOT_FOUND" | "NO_WORKING_DAY" | "BOT_NOT_FOUND";

export interface SchedulePlan {
  config: QuickBookConfig;
  current: number | null;
  effectiveDate: string;
}

export interface ScheduleParams {
  botId: string;
  kind: SettingChangeKind;
  targetId?: string;
  newValue: number;
  author: ChangeAuthor;
  now?: Date;
  promisedDate?: string;
  config?: QuickBookConfig;
}

export type PlanResult =
  | { ok: true; plan: SchedulePlan; unchanged: false }
  | { ok: true; unchanged: true; current: number | null }
  | { ok: false; error: SettingChangeError };

export type ScheduleResult =
  | { ok: true; unchanged: false; change: BotSettingChange; plan: SchedulePlan }
  | { ok: true; unchanged: true; current: number | null }
  | { ok: false; error: SettingChangeError };

export function validateChangeValue(kind: SettingChangeKind, value: number): boolean {
  if (!Number.isInteger(value)) return false;
  return kind === "MIN_LEAD"
    ? value >= MIN_LEAD_MINUTES_FLOOR && value <= 10080
    : value >= 0 && value <= MAX_PRICE_UZS;
}

export async function planSettingChange(db: Db, p: ScheduleParams): Promise<PlanResult> {
  const now = p.now ?? new Date();
  const targetId = p.kind === "MIN_LEAD" ? "" : (p.targetId ?? "");
  if (!validateChangeValue(p.kind, p.newValue)) return { ok: false, error: "INVALID_VALUE" };
  const config = p.config ?? (await loadEffectiveConfig(db, p.botId, now));
  if (!config) return { ok: false, error: "NO_WORKING_DAY" };

  let current: number | null;
  if (p.kind === "MIN_LEAD") {
    current = config.minLeadMinutes ?? null;
  } else {
    const service = config.services.find((s) => s.id === targetId);
    if (!service) return { ok: false, error: "SERVICE_NOT_FOUND" };
    current = service.priceUzs;
  }
  if (current === p.newValue) return { ok: true, unchanged: true, current };

  const today = tashkentDateString(now);
  if (p.promisedDate && p.promisedDate > today) {
    return { ok: true, unchanged: false, plan: { config, current, effectiveDate: p.promisedDate } };
  }
  const blocks = await db.timeBlock.findMany({
    where: {
      botId: p.botId,
      endsAt: { gt: dateStartAt(addDaysToDateString(today, 1)) },
      startsAt: { lt: dateStartAt(addDaysToDateString(today, MAX_LOOKAHEAD_DAYS + 1)) },
    },
    select: { resourceId: true, startsAt: true, endsAt: true },
  });
  const effectiveDate = findNextWorkingDate(
    config,
    p.kind === "MIN_LEAD" ? null : targetId,
    blocks,
    now,
  );
  if (!effectiveDate) return { ok: false, error: "NO_WORKING_DAY" };
  return { ok: true, unchanged: false, plan: { config, current, effectiveDate } };
}

function resolvedBy(author: ChangeAuthor) {
  return {
    resolvedByTgId: author.tgId != null ? BigInt(author.tgId) : null,
    resolvedByAdminId: author.adminId ?? null,
  };
}

export async function scheduleChangeInTx(
  tx: Prisma.TransactionClient,
  p: ScheduleParams,
): Promise<ScheduleResult> {
  const now = p.now ?? new Date();
  const targetId = p.kind === "MIN_LEAD" ? "" : (p.targetId ?? "");
  const planned = await planSettingChange(tx, p);
  const existing = await tx.botSettingChange.findFirst({
    where: { botId: p.botId, kind: p.kind, targetId, status: "PENDING" },
  });
  if (!planned.ok) return planned;
  if (planned.unchanged) {
    if (existing) {
      await tx.botSettingChange.update({
        where: { id: existing.id },
        data: {
          status: "CANCELLED",
          resolvedAt: now,
          resolution: "reverted to current value",
          ...resolvedBy(p.author),
        },
      });
    }
    return planned;
  }
  const { plan } = planned;
  const effectiveAt = dateStartAt(plan.effectiveDate);
  if (
    existing &&
    existing.newValue === p.newValue &&
    existing.effectiveAt.getTime() === effectiveAt.getTime()
  ) {
    return { ok: true, unchanged: false, change: existing, plan };
  }
  if (existing) {
    await tx.botSettingChange.update({
      where: { id: existing.id },
      data: {
        status: "REPLACED",
        resolvedAt: now,
        resolution: "replaced",
        ...resolvedBy(p.author),
      },
    });
  }
  const change = await tx.botSettingChange.create({
    data: {
      botId: p.botId,
      kind: p.kind,
      targetId,
      oldValue: plan.current,
      newValue: p.newValue,
      effectiveAt,
      createdByTgId: p.author.tgId != null ? BigInt(p.author.tgId) : null,
      createdByAdminId: p.author.adminId ?? null,
    },
  });
  return { ok: true, unchanged: false, change, plan };
}

export async function scheduleSettingChange(
  prisma: PrismaClient,
  p: ScheduleParams,
): Promise<ScheduleResult> {
  return prisma.$transaction(async (tx) => {
    if (!(await lockBotRow(tx, p.botId))) return { ok: false, error: "BOT_NOT_FOUND" } as const;
    await applyDueInTx(tx, p.botId, p.now ?? new Date());
    return scheduleChangeInTx(tx, p);
  });
}

export async function cancelPendingChange(
  prisma: PrismaClient,
  p: { botId: string; changeId: string; author: ChangeAuthor; now?: Date },
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    if (!(await lockBotRow(tx, p.botId))) return false;
    const now = p.now ?? new Date();
    await applyDueInTx(tx, p.botId, now);
    const change = await tx.botSettingChange.findFirst({
      where: { id: p.changeId, botId: p.botId, status: "PENDING", effectiveAt: { gt: now } },
    });
    if (!change) return false;
    const config = await loadEffectiveConfig(tx, p.botId, now);
    const needsBaseline = change.kind === "MIN_LEAD" && config?.minLeadMinutes == null;
    if (needsBaseline && change.newValue === MIN_LEAD_MINUTES_FLOOR) return false;
    await tx.botSettingChange.update({
      where: { id: change.id },
      data: {
        status: "CANCELLED",
        resolvedAt: now,
        resolution: "cancelled",
        ...resolvedBy(p.author),
      },
    });
    if (needsBaseline)
      await scheduleChangeInTx(tx, {
        botId: p.botId,
        kind: "MIN_LEAD",
        newValue: MIN_LEAD_MINUTES_FLOOR,
        author: p.author,
        now,
        promisedDate: tashkentDateString(change.effectiveAt),
      });
    return true;
  });
}

export async function cancelServicePriceChanges(
  tx: Prisma.TransactionClient,
  botId: string,
  serviceIds: string[],
  author: ChangeAuthor,
  now = new Date(),
): Promise<void> {
  if (serviceIds.length === 0) return;
  await tx.botSettingChange.updateMany({
    where: { botId, kind: "SERVICE_PRICE", status: "PENDING", targetId: { in: serviceIds } },
    data: {
      status: "CANCELLED",
      resolvedAt: now,
      resolution: "service removed",
      ...resolvedBy(author),
    },
  });
}

export function listPendingChanges(db: Db, botId: string): Promise<BotSettingChange[]> {
  return db.botSettingChange.findMany({
    where: { botId, status: "PENDING" },
    orderBy: [{ effectiveAt: "asc" }, { createdAt: "asc" }],
  });
}
