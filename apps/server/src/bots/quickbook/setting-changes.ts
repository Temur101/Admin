import type { Prisma, PrismaClient, BotSettingChange, SettingChangeKind } from "@prisma/client";
import type { Redis } from "ioredis";
import { MAX_PRICE_UZS, MIN_LEAD_MINUTES_FLOOR, type QuickBookConfig } from "@lcqb/contracts";
import { tashkentDateString } from "./booking-horizon.js";
import { getQuickBookConfig } from "./config-resolver.js";
import {
  addDaysToDateString,
  dateStartAt,
  findNextWorkingDate,
  MAX_LOOKAHEAD_DAYS,
  overlayChanges,
} from "./setting-schedule.js";

type Db = PrismaClient | Prisma.TransactionClient;
type Raw = Record<string, unknown>;

export interface ChangeAuthor {
  tgId?: bigint | number | null;
  adminId?: string | null;
}

export type SettingChangeError = "INVALID_VALUE" | "SERVICE_NOT_FOUND" | "NO_WORKING_DAY" | "BOT_NOT_FOUND";

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

export async function lockBotRow(tx: Prisma.TransactionClient, botId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Bot" WHERE id = ${botId}::uuid FOR UPDATE`;
  return rows.length > 0;
}

export async function loadEffectiveSettings(db: Db, botId: string, now = new Date()): Promise<Raw | null> {
  const bot = await db.bot.findUnique({
    where: { id: botId },
    select: {
      settings: true,
      settingChanges: { where: { status: "PENDING", effectiveAt: { lte: now } }, orderBy: { effectiveAt: "asc" } },
    },
  });
  return bot ? overlayChanges((bot.settings ?? {}) as Raw, bot.settingChanges) : null;
}

export async function loadEffectiveConfig(db: Db, botId: string, now = new Date()): Promise<QuickBookConfig | null> {
  const settings = await loadEffectiveSettings(db, botId, now);
  if (!settings) return null;
  const config = getQuickBookConfig(settings);
  return config.services.length > 0 ? config : null;
}

export async function refreshConfigValues(
  db: Db,
  botId: string,
  config: QuickBookConfig,
  now = new Date(),
): Promise<QuickBookConfig> {
  if (!db.bot?.findUnique) return config;
  const fresh = await loadEffectiveConfig(db, botId, now);
  if (!fresh) return config;
  return {
    ...config,
    minLeadMinutes: fresh.minLeadMinutes,
    services: config.services.map((s) => {
      const f = fresh.services.find((x) => x.id === s.id);
      return f ? { ...s, priceUzs: f.priceUzs } : s;
    }),
  };
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
  const effectiveDate = findNextWorkingDate(config, p.kind === "MIN_LEAD" ? null : targetId, blocks, now);
  if (!effectiveDate) return { ok: false, error: "NO_WORKING_DAY" };
  return { ok: true, unchanged: false, plan: { config, current, effectiveDate } };
}

function resolvedBy(author: ChangeAuthor) {
  return {
    resolvedByTgId: author.tgId != null ? BigInt(author.tgId) : null,
    resolvedByAdminId: author.adminId ?? null,
  };
}

export async function scheduleChangeInTx(tx: Prisma.TransactionClient, p: ScheduleParams): Promise<ScheduleResult> {
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
        data: { status: "CANCELLED", resolvedAt: now, resolution: "reverted to current value", ...resolvedBy(p.author) },
      });
    }
    return planned;
  }
  const { plan } = planned;
  const effectiveAt = dateStartAt(plan.effectiveDate);
  if (existing && existing.newValue === p.newValue && existing.effectiveAt.getTime() === effectiveAt.getTime()) {
    return { ok: true, unchanged: false, change: existing, plan };
  }
  if (existing) {
    await tx.botSettingChange.update({
      where: { id: existing.id },
      data: { status: "REPLACED", resolvedAt: now, resolution: "replaced", ...resolvedBy(p.author) },
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

export async function scheduleSettingChange(prisma: PrismaClient, p: ScheduleParams): Promise<ScheduleResult> {
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
  const res = await prisma.botSettingChange.updateMany({
    where: { id: p.changeId, botId: p.botId, status: "PENDING" },
    data: { status: "CANCELLED", resolvedAt: p.now ?? new Date(), resolution: "cancelled", ...resolvedBy(p.author) },
  });
  return res.count > 0;
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
    data: { status: "CANCELLED", resolvedAt: now, resolution: "service removed", ...resolvedBy(author) },
  });
}

export function listPendingChanges(db: Db, botId: string): Promise<BotSettingChange[]> {
  return db.botSettingChange.findMany({
    where: { botId, status: "PENDING" },
    orderBy: [{ effectiveAt: "asc" }, { createdAt: "asc" }],
  });
}

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
  const bot = await tx.bot.findUniqueOrThrow({ where: { id: botId }, select: { settings: true, botTokenHash: true } });
  const settings = (bot.settings ?? {}) as Raw;
  const flat = settings.quickbook && typeof settings.quickbook === "object" ? settings.quickbook : settings;
  const services = Array.isArray((flat as Raw).services) ? ((flat as Raw).services as Raw[]) : [];
  const live = due.filter((c) => c.kind === "MIN_LEAD" || services.some((s) => s.id === c.targetId));
  const dead = due.filter((c) => !live.includes(c));
  if (live.length > 0) {
    await tx.bot.update({ where: { id: botId }, data: { settings: overlayChanges(settings, live) as Prisma.InputJsonValue } });
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

export async function applyDueChanges(prisma: PrismaClient, opts: ApplyDueOptions = {}): Promise<number> {
  if (!prisma.botSettingChange?.findMany) return 0;
  const now = opts.now ?? new Date();
  const rows = await prisma.botSettingChange.findMany({
    where: { ...(opts.botId ? { botId: opts.botId } : {}), status: "PENDING", effectiveAt: { lte: now } },
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
        await opts.redis.del(`bot:id:${botId}`, ...(res.tokenHash ? [`bot:hash:${res.tokenHash}`] : [])).catch(() => {});
      }
    }
  }
  return total;
}

export async function ensureInitialMinLead(prisma: PrismaClient, now = new Date()): Promise<number> {
  if (!prisma.botSettingChange?.findFirst) return 0;
  const bots = await prisma.bot.findMany({ where: { botType: "QUICKBOOK" }, select: { id: true, settings: true } });
  let created = 0;
  for (const bot of bots) {
    const settings = (bot.settings ?? {}) as Raw;
    const flat = (settings.quickbook as Raw | undefined) ?? settings;
    if (typeof flat.minLeadMinutes === "number") continue;
    const history = await prisma.botSettingChange.findFirst({ where: { botId: bot.id, kind: "MIN_LEAD" }, select: { id: true } });
    if (history) continue;
    try {
      const res = await scheduleSettingChange(prisma, {
        botId: bot.id,
        kind: "MIN_LEAD",
        newValue: MIN_LEAD_MINUTES_FLOOR,
        author: {},
        now,
      });
      if (res.ok && !res.unchanged) created++;
    } catch {
      // concurrent initialisation lost the race on the pending unique index
    }
  }
  return created;
}
