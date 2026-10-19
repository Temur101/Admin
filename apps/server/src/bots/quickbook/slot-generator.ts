import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import type { QuickBookConfig } from "@lcqb/contracts";
import { isBookingDateAllowed } from "./booking-horizon.js";
import { isSlotLocked } from "./slot-lock.js";

export interface TimeSlot {
  slotTime: Date;
  slotTimeIso: string;
  timeLabel: string; // "10:00", "14:30" in Tashkent time
  staffId: string;
  staffName: string;
  durationMin: number;
}

export interface GenerateSlotsOptions {
  botId: string;
  config: QuickBookConfig;
  serviceId: string;
  staffId?: string; // If omitted, generates for all eligible staff
  dateStr: string; // "YYYY-MM-DD"
  prisma: PrismaClient;
  redis?: Redis;
  now?: Date;
  lang?: "RU" | "UZ";
}

/**
 * Parses YYYY-MM-DD in Tashkent time (UTC+5) and returns day-of-week and start/end UTC dates.
 */
export function parseTashkentDate(dateStr: string): {
  dayOfWeek: number; // 0=Sun, 1=Mon, ..., 6=Sat
  year: number;
  month: number;
  day: number;
  dayStartUtc: Date;
  dayEndUtc: Date;
} {
  const parts = dateStr.split("-").map(Number);
  const year = parts[0] ?? 2026;
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;

  // Tashkent is UTC+5
  const dayStartUtc = new Date(Date.UTC(year, month - 1, day, 0 - 5, 0, 0, 0));
  const dayEndUtc = new Date(Date.UTC(year, month - 1, day, 24 - 5, 0, 0, 0));

  // Determine day of week at 12:00 UTC
  const midDay = new Date(Date.UTC(year, month - 1, day, 12 - 5, 0, 0, 0));
  const dayOfWeek = midDay.getUTCDay();

  return { dayOfWeek, year, month, day, dayStartUtc, dayEndUtc };
}

/**
 * Converts minutes from start of day (e.g. 600 = 10:00) to UTC Date for a given Tashkent date.
 */
export function minutesToUtcDate(year: number, month: number, day: number, minutes: number): Date {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  // Tashkent is UTC+5, so UTC hour = hours - 5
  return new Date(Date.UTC(year, month - 1, day, hours - 5, mins, 0, 0));
}

export function parseTimeToMinutes(timeStr: string): number {
  const [h, m] = timeStr.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function formatMinutesToLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Generates available booking time slots for a given date, service and resource.
 */
export async function generateAvailableSlots(opts: GenerateSlotsOptions): Promise<TimeSlot[]> {
  const { botId, config, serviceId, staffId, dateStr, prisma, redis } = opts;
  const now = opts.now ?? new Date();
  const lang = opts.lang ?? "RU";
  if (!isBookingDateAllowed(dateStr, config, now)) return [];

  const service = config.services.find((s) => s.id === serviceId);
  if (!service) return [];

  const { dayOfWeek, year, month, day, dayStartUtc, dayEndUtc } = parseTashkentDate(dateStr);

  // Filter resources
  let resources = config.resources;
  if (staffId && staffId !== "any") {
    resources = resources.filter((r) => r.id === staffId);
  }
  // Filter by serviceIds if defined
  resources = resources.filter(
    (r) => !r.serviceIds || r.serviceIds.length === 0 || r.serviceIds.includes(serviceId),
  );

  if (resources.length === 0) return [];

  // Query existing bookings for this bot on this day
  const existingBookings = await prisma.booking.findMany({
    where: {
      botId,
      slotTime: {
        gte: dayStartUtc,
        lt: dayEndUtc,
      },
      status: { in: ["PENDING", "CONFIRMED"] },
    },
    select: {
      staffId: true,
      slotTime: true,
      endTime: true,
      durationMin: true,
    },
  });

  const slots: TimeSlot[] = [];
  const intervalMin = config.slotIntervalMin ?? 30;

  // Calculate now in Tashkent timestamp
  const nowMs = now.getTime();

  for (const res of resources) {
    // Check work day
    if (!res.workDays.includes(dayOfWeek)) {
      continue;
    }

    const workStartMin = parseTimeToMinutes(res.workHours.start);
    const workEndMin = parseTimeToMinutes(res.workHours.end);

    const breakStartMin = res.breakHours ? parseTimeToMinutes(res.breakHours.start) : null;
    const breakEndMin = res.breakHours ? parseTimeToMinutes(res.breakHours.end) : null;

    // Generate candidate start minutes
    for (let m = workStartMin; m + service.durationMin <= workEndMin; m += intervalMin) {
      const slotEndMin = m + service.durationMin;

      // Check break overlap: [m, slotEndMin) overlaps [breakStartMin, breakEndMin)
      if (
        breakStartMin !== null &&
        breakEndMin !== null &&
        m < breakEndMin &&
        slotEndMin > breakStartMin
      ) {
        continue;
      }

      const slotStartUtc = minutesToUtcDate(year, month, day, m);
      const slotStartMs = slotStartUtc.getTime();
      const slotEndMs = slotStartMs + service.durationMin * 60 * 1000;

      // Check if slot is in the past (must be strictly in the future)
      if (slotStartMs <= nowMs) {
        continue;
      }

      // Check overlap with existing bookings
      const hasBookingConflict = existingBookings.some((b) => {
        if (b.staffId !== res.id) return false;
        const bStartMs = b.slotTime.getTime();
        const bEndMs = b.endTime ? b.endTime.getTime() : bStartMs + b.durationMin * 60 * 1000;
        return slotStartMs < bEndMs && slotEndMs > bStartMs;
      });

      if (hasBookingConflict) {
        continue;
      }

      // Check Redis lock if redis client is provided
      if (redis) {
        const locked = await isSlotLocked(
          redis,
          botId,
          res.id,
          slotStartUtc,
          service.durationMin,
          intervalMin,
        );
        if (locked) {
          continue;
        }
      }

      const staffName = lang === "UZ" ? res.name.uz : res.name.ru;

      slots.push({
        slotTime: slotStartUtc,
        slotTimeIso: slotStartUtc.toISOString(),
        timeLabel: formatMinutesToLabel(m),
        staffId: res.id,
        staffName,
        durationMin: service.durationMin,
      });
    }
  }

  // Sort slots chronologically
  slots.sort((a, b) => a.slotTime.getTime() - b.slotTime.getTime());

  return slots;
}

/**
 * Finds alternative available slots on the same or next days if the desired slot is taken.
 */
export async function getAlternativeSlots(
  opts: GenerateSlotsOptions,
  limit = 3,
): Promise<TimeSlot[]> {
  const alternatives: TimeSlot[] = [];
  const { dateStr } = opts;
  const now = opts.now ?? new Date();
  const parts = dateStr.split("-").map(Number);
  const baseDate = new Date(Date.UTC(parts[0] ?? 2026, (parts[1] ?? 1) - 1, parts[2] ?? 1));

  // Look ahead up to 5 days
  for (let dayOffset = 0; dayOffset < 5; dayOffset++) {
    const nextDate = new Date(baseDate.getTime() + dayOffset * 86400000);
    const nextDateStr = nextDate.toISOString().slice(0, 10);

    if (!isBookingDateAllowed(nextDateStr, opts.config, now)) continue;
    const slots = await generateAvailableSlots({
      ...opts,
      dateStr: nextDateStr,
      now,
    });

    for (const slot of slots) {
      alternatives.push(slot);
      if (alternatives.length >= limit) {
        return alternatives;
      }
    }
  }

  return alternatives;
}
