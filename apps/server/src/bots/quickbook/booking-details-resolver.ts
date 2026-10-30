import { getQuickBookConfig } from "./config-resolver.js";
import { formatTashkentDateTime } from "./booking-service.js";

export function resolveBookingDetails(
  booking: {
    bot?: { settings: unknown } | null;
    serviceId: string;
    serviceName: string;
    staffId: string;
    slotTime: Date;
  },
  settings: unknown,
  lang: "RU" | "UZ",
): {
  serviceName: string;
  staffName: string;
  timeFormatted: string;
} {
  const config = getQuickBookConfig(
    (booking.bot?.settings ?? settings) as Record<string, unknown> | null | undefined,
  );
  const loc = lang === "UZ" ? "uz" : "ru";
  const service = config.services.find((s) => s.id === booking.serviceId);
  const resource = config.resources.find((r) => r.id === booking.staffId);
  return {
    serviceName: service?.name[loc] || booking.serviceName,
    staffName: resource?.name[loc] || booking.staffId,
    timeFormatted: formatTashkentDateTime(booking.slotTime),
  };
}
