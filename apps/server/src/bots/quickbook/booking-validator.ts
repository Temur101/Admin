import type { QuickBookConfig, QuickBookResource, QuickBookService } from "@lcqb/contracts";
import { bookingWindow } from "./booking-horizon.js";
import { parseTimeToMinutes } from "./slot-generator.js";

/**
 * Extracts Tashkent local time components (UTC+5) for scheduling and break checks.
 */
export function getTashkentTimeParts(date: Date): {
  year: number;
  month: number;
  day: number;
  dayOfWeek: number;
  minutesOfDay: number;
  dateStr: string;
} {
  const tashkentMs = date.getTime() + 5 * 3600 * 1000;
  const d = new Date(tashkentMs);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const dayOfWeek = d.getUTCDay();
  const minutesOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
  const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { year, month, day, dayOfWeek, minutesOfDay, dateStr };
}

/**
 * Validates slot eligibility: service-resource compatibility, past date,
 * booking horizon, resource working days, working hours, and break intervals.
 */
export function validateBookingSlotEligibility(params: {
  config: QuickBookConfig;
  service: QuickBookService;
  staff: QuickBookResource;
  slotDate: Date;
  now?: Date;
}):
  | { valid: true }
  | {
      valid: false;
      error:
        | "SERVICE_NOT_SUPPORTED"
        | "SLOT_IN_PAST"
        | "OUTSIDE_HORIZON"
        | "NOT_IN_SCHEDULE"
        | "SLOT_IN_BREAK";
    } {
  const { config, service, staff, slotDate } = params;
  const now = params.now ?? new Date();

  // 1. Service supported by resource
  if (staff.serviceIds && staff.serviceIds.length > 0 && !staff.serviceIds.includes(service.id)) {
    return { valid: false, error: "SERVICE_NOT_SUPPORTED" };
  }

  // 2. Past time (slot must be strictly in the future)
  if (slotDate.getTime() <= now.getTime()) {
    return { valid: false, error: "SLOT_IN_PAST" };
  }

  // 3. Booking horizon
  const { end } = bookingWindow(config, now);
  if (slotDate.getTime() >= end) {
    return { valid: false, error: "OUTSIDE_HORIZON" };
  }

  // 4. Schedule & breaks in Tashkent time
  const { dayOfWeek, minutesOfDay } = getTashkentTimeParts(slotDate);

  if (!staff.workDays.includes(dayOfWeek)) {
    return { valid: false, error: "NOT_IN_SCHEDULE" };
  }

  const workStartMin = parseTimeToMinutes(staff.workHours.start);
  const workEndMin = parseTimeToMinutes(staff.workHours.end);
  const slotStartMin = minutesOfDay;
  const slotEndMin = slotStartMin + service.durationMin;

  if (slotStartMin < workStartMin || slotEndMin > workEndMin) {
    return { valid: false, error: "NOT_IN_SCHEDULE" };
  }

  if (staff.breakHours) {
    const breakStartMin = parseTimeToMinutes(staff.breakHours.start);
    const breakEndMin = parseTimeToMinutes(staff.breakHours.end);
    if (slotStartMin < breakEndMin && slotEndMin > breakStartMin) {
      return { valid: false, error: "SLOT_IN_BREAK" };
    }
  }

  return { valid: true };
}
