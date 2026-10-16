import type { QuickBookConfig } from "@lcqb/contracts";
export function previewBookingTimes(
  config: QuickBookConfig,
  serviceId: string,
  resourceId: string,
  day: number,
): string[] {
  const service = config.services.find((s) => s.id === serviceId);
  const resource = config.resources.find((r) => r.id === resourceId);
  if (!service || !resource || !resource.workDays.includes(day)) return [];
  if (resource.serviceIds?.length && !resource.serviceIds.includes(service.id)) return [];
  const minutes = (value: string) => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return NaN;
    const [h, m] = value.split(":").map(Number);
    return h! * 60 + m!;
  };
  const start = minutes(resource.workHours.start),
    end = minutes(resource.workHours.end);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start >= end ||
    config.slotIntervalMin < 5 ||
    service.durationMin < 5
  )
    return [];
  const breakStart = resource.breakHours ? minutes(resource.breakHours.start) : null;
  const breakEnd = resource.breakHours ? minutes(resource.breakHours.end) : null;
  if (
    resource.breakHours &&
    (!Number.isFinite(breakStart) ||
      !Number.isFinite(breakEnd) ||
      breakStart! >= breakEnd! ||
      breakStart! < start ||
      breakEnd! > end)
  )
    return [];
  const slots: string[] = [];
  for (let time = start; time + service.durationMin <= end; time += config.slotIntervalMin) {
    if (
      breakStart !== null &&
      breakEnd !== null &&
      time < breakEnd &&
      time + service.durationMin > breakStart
    )
      continue;
    slots.push(
      `${String(Math.floor(time / 60)).padStart(2, "0")}:${String(time % 60).padStart(2, "0")}`,
    );
  }
  return slots;
}
