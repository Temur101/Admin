import type { QuickBookConfig } from "@lcqb/contracts";
const DAY_MS = 86400000;
const TASHKENT_OFFSET_MS = 5 * 3600000;
/** Horizon means N local calendar dates, including today; the upper bound is exclusive. */
export function bookingWindow(config: QuickBookConfig, now = new Date()) {
  const local = new Date(now.getTime() + TASHKENT_OFFSET_MS);
  const start =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - TASHKENT_OFFSET_MS;
  return { start, end: start + config.bookingHorizonDays * DAY_MS };
}
export function tashkentDateString(date: Date): string {
  return new Date(date.getTime() + TASHKENT_OFFSET_MS).toISOString().slice(0, 10);
}
export function isBookingDateAllowed(
  dateStr: string,
  config: QuickBookConfig,
  now = new Date(),
): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const date = new Date(`${dateStr}T00:00:00+05:00`);
  if (!Number.isFinite(date.getTime()) || tashkentDateString(date) !== dateStr) return false;
  const { start, end } = bookingWindow(config, now);
  return date.getTime() >= start && date.getTime() < end;
}
