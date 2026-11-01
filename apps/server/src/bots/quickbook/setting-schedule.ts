import type { QuickBookConfig } from "@lcqb/contracts";
import { tashkentDateString } from "./booking-horizon.js";
import { minutesToUtcDate, parseTashkentDate, parseTimeToMinutes } from "./slot-generator.js";

export const MAX_LOOKAHEAD_DAYS = 90;

export interface ClosureBlock {
  resourceId: string;
  startsAt: Date;
  endsAt: Date;
}

export interface OverlayChange {
  kind: "MIN_LEAD" | "SERVICE_PRICE";
  targetId: string;
  newValue: number;
  effectiveAt: Date;
}

/** Calendar arithmetic on YYYY-MM-DD strings (month/year rollover safe). */
export function addDaysToDateString(dateStr: string, days: number): string {
  const [y = 1970, m = 1, d = 1] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 00:00 Asia/Tashkent of the given date. */
export function dateStartAt(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00+05:00`);
}

export function formatDateDmy(dateStr: string): string {
  const [y, m, d] = dateStr.split("-");
  return `${d}.${m}.${y}`;
}

function coversWorkday(
  blocks: ClosureBlock[],
  resourceId: string,
  dateStr: string,
  startMin: number,
  endMin: number,
): boolean {
  const { year, month, day } = parseTashkentDate(dateStr);
  const from = minutesToUtcDate(year, month, day, startMin).getTime();
  const to = minutesToUtcDate(year, month, day, endMin).getTime();
  const intervals = blocks
    .filter((b) => b.resourceId === "all" || b.resourceId === resourceId)
    .map((b) => [Math.max(b.startsAt.getTime(), from), Math.min(b.endsAt.getTime(), to)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let cursor = from;
  for (const [a, b] of intervals) {
    if (a > cursor) return false;
    cursor = Math.max(cursor, b);
  }
  return cursor >= to;
}

/**
 * A date is working when at least one master serving the service (or any service when
 * serviceId is null) works that weekday and is not fully closed for the whole shift.
 * Ordinary bookings never turn a working day into a day off.
 */
export function isWorkingDate(
  config: QuickBookConfig,
  serviceId: string | null,
  blocks: ClosureBlock[],
  dateStr: string,
): boolean {
  const { dayOfWeek } = parseTashkentDate(dateStr);
  const serviceIds = serviceId ? [serviceId] : config.services.map((s) => s.id);
  return config.resources.some((r) => {
    if (!r.workDays.includes(dayOfWeek)) return false;
    const serves = serviceIds.some(
      (id) => !r.serviceIds || r.serviceIds.length === 0 || r.serviceIds.includes(id),
    );
    if (!serves) return false;
    const start = parseTimeToMinutes(r.workHours.start);
    const end = parseTimeToMinutes(r.workHours.end);
    if (end <= start) return false;
    return !coversWorkday(blocks, r.id, dateStr, start, end);
  });
}

/** Closest date strictly after today (Asia/Tashkent) that is a working date, or null. */
export function findNextWorkingDate(
  config: QuickBookConfig,
  serviceId: string | null,
  blocks: ClosureBlock[],
  now: Date,
): string | null {
  if (serviceId && !config.services.some((s) => s.id === serviceId)) return null;
  const today = tashkentDateString(now);
  for (let i = 1; i <= MAX_LOOKAHEAD_DAYS; i++) {
    const candidate = addDaysToDateString(today, i);
    if (isWorkingDate(config, serviceId, blocks, candidate)) return candidate;
  }
  return null;
}

type Raw = Record<string, unknown>;
const isRecord = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);

/** Pure overlay of due changes on raw bot settings; touches only the affected fields. */
export function overlayChanges(settings: Raw, changes: OverlayChange[]): Raw {
  if (changes.length === 0) return settings;
  const nested = isRecord(settings.quickbook);
  const base: Raw = nested ? { ...(settings.quickbook as Raw) } : { ...settings };
  const ordered = [...changes].sort((a, b) => a.effectiveAt.getTime() - b.effectiveAt.getTime());
  for (const change of ordered) {
    if (change.kind === "MIN_LEAD") {
      base.minLeadMinutes = change.newValue;
    } else if (Array.isArray(base.services)) {
      base.services = base.services.map((s) =>
        isRecord(s) && s.id === change.targetId ? { ...s, priceUzs: change.newValue } : s,
      );
    }
  }
  return nested ? { ...settings, quickbook: base } : base;
}
