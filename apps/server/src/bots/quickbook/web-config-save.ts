import { createHash } from "node:crypto";
import type { BotSettingChange, Prisma, PrismaClient } from "@prisma/client";
import type { QuickBookConfig } from "@lcqb/contracts";
import { tashkentDateString } from "./booking-horizon.js";
import { getQuickBookConfig } from "./config-resolver.js";
import {
  applyDueInTx,
  cancelServicePriceChanges,
  listPendingChanges,
  loadEffectiveSettings,
  lockBotRow,
  scheduleChangeInTx,
  type ChangeAuthor,
  type SettingChangeError,
} from "./setting-changes.js";

type Db = PrismaClient | Prisma.TransactionClient;
type Raw = Record<string, unknown>;

/** Fingerprint of the current values + pending changes; lets web forms detect stale edits. */
export function settingsRevision(config: QuickBookConfig, pending: BotSettingChange[]): string {
  const material = JSON.stringify(
    canonical({
      config,
      pending: pending.map((c) => [c.id, c.status, c.newValue, c.effectiveAt.toISOString()]).sort(),
    }),
  );
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, canonical(v)]),
    );
  return value;
}

export type WebSaveResult =
  | { ok: true; settings: QuickBookConfig; scheduled: BotSettingChange[] }
  | { ok: false; error: SettingChangeError | "STALE_SETTINGS" };

/**
 * Web admin full-config save. Current min lead and existing service prices are never overwritten
 * directly: an explicit difference becomes a delayed pending change (same rules as Telegram),
 * omitted values keep the stored ones, removed services drop their pending price change.
 */
export async function saveWebQuickBookConfig(
  prisma: PrismaClient,
  p: {
    botId: string;
    incoming: QuickBookConfig;
    adminId: string | null;
    revision?: string;
    now?: Date;
  },
): Promise<WebSaveResult> {
  const now = p.now ?? new Date();
  const author: ChangeAuthor = { adminId: p.adminId };
  return prisma
    .$transaction(async (tx): Promise<WebSaveResult> => {
      if (!(await lockBotRow(tx, p.botId))) return { ok: false, error: "BOT_NOT_FOUND" };
      await applyDueInTx(tx, p.botId, now);
      const bot = await tx.bot.findUniqueOrThrow({
        where: { id: p.botId },
        select: { settings: true },
      });
      const current = getQuickBookConfig((bot.settings ?? {}) as Raw);
      const pendingBefore = await listPendingChanges(tx, p.botId);
      if (!p.revision || p.revision !== settingsRevision(current, pendingBefore)) {
        return { ok: false, error: "STALE_SETTINGS" };
      }

      const hasCurrent = current.services.length > 0;
      const next: QuickBookConfig = { ...p.incoming };
      const requests: {
        kind: "MIN_LEAD" | "SERVICE_PRICE";
        targetId?: string;
        newValue: number;
      }[] = [];

      if (!hasCurrent) {
        next.minLeadMinutes = p.incoming.minLeadMinutes ?? current.minLeadMinutes;
      } else {
        const wanted = p.incoming.minLeadMinutes;
        if (wanted !== undefined && wanted !== current.minLeadMinutes) {
          requests.push({ kind: "MIN_LEAD", newValue: wanted });
        }
        next.minLeadMinutes = current.minLeadMinutes;
        next.services = p.incoming.services.map((svc) => {
          const existing = current.services.find((s) => s.id === svc.id);
          if (!existing) return svc;
          if (existing.priceUzs !== svc.priceUzs) {
            requests.push({ kind: "SERVICE_PRICE", targetId: svc.id, newValue: svc.priceUzs });
          }
          return { ...svc, priceUzs: existing.priceUzs };
        });
        const kept = new Set(p.incoming.services.map((s) => s.id));
        await cancelServicePriceChanges(
          tx,
          p.botId,
          current.services.filter((s) => !kept.has(s.id)).map((s) => s.id),
          author,
          now,
        );
      }

      await tx.bot.update({
        where: { id: p.botId },
        data: { settings: next as unknown as Prisma.InputJsonValue },
      });

      const scheduled: BotSettingChange[] = [];
      for (const req of requests) {
        const res = await scheduleChangeInTx(tx, {
          botId: p.botId,
          author,
          now,
          config: next,
          ...req,
        });
        if (!res.ok) throw new WebSaveRollback(res.error);
        if (!res.unchanged) scheduled.push(res.change);
      }
      return { ok: true, settings: next, scheduled };
    })
    .catch((err: unknown) => {
      if (err instanceof WebSaveRollback) return { ok: false, error: err.code } as const;
      throw err;
    });
}

class WebSaveRollback extends Error {
  constructor(public readonly code: SettingChangeError) {
    super(code);
  }
}

/**
 * Whole-config replacement (template apply / reset): keeps the stored minimum lead, drops
 * pending price changes because the service list is replaced. Runs in the caller's transaction.
 */
export async function replaceConfigInTx(
  tx: Prisma.TransactionClient,
  botId: string,
  replacement: Raw,
  author: ChangeAuthor,
  now = new Date(),
): Promise<Raw> {
  await lockBotRow(tx, botId);
  await applyDueInTx(tx, botId, now);
  const bot = await tx.bot.findUniqueOrThrow({ where: { id: botId }, select: { settings: true } });
  const raw = (bot.settings ?? {}) as Raw;
  const lead = ((raw.quickbook as Raw | undefined) ?? raw).minLeadMinutes;
  const next: Raw = { ...replacement };
  if (typeof lead === "number") next.minLeadMinutes = lead;
  const pendingPrices = await tx.botSettingChange.findMany({
    where: { botId, kind: "SERVICE_PRICE", status: "PENDING" },
    select: { targetId: true },
  });
  await cancelServicePriceChanges(
    tx,
    botId,
    pendingPrices.map((c) => c.targetId),
    author,
    now,
  );
  await tx.bot.update({ where: { id: botId }, data: { settings: next as Prisma.InputJsonValue } });
  return next;
}

export function describeChange(c: BotSettingChange) {
  return {
    id: c.id,
    kind: c.kind,
    targetId: c.targetId,
    oldValue: c.oldValue,
    newValue: c.newValue,
    effectiveAt: c.effectiveAt.toISOString(),
    effectiveDate: tashkentDateString(c.effectiveAt),
    status: c.status,
    createdAt: c.createdAt.toISOString(),
  };
}

/** Pending changes (future-dated only) + revision token, matching the post-activation state. */
export async function quickBookSettingsView(db: Db, botId: string, now = new Date()) {
  const settings = await loadEffectiveSettings(db, botId, now);
  const config = getQuickBookConfig(settings ?? {});
  const pending = (await listPendingChanges(db, botId)).filter((c) => c.effectiveAt > now);
  return {
    ...(settings ? { settings } : {}),
    pendingChanges: pending.map(describeChange),
    settingsRevision: settingsRevision(config, pending),
  };
}
