import type { PrismaClient } from "@prisma/client";
import type { QuickBookConfig } from "@lcqb/contracts";
import { tashkentDateString } from "./booking-horizon.js";
import { parseTashkentDate, parseTimeToMinutes } from "./slot-generator.js";

export interface AffectedBooking {
  id: string;
  customerName: string | null;
  customerPhone: string;
  slotTime: Date;
  endTime: Date | null;
  serviceName: string;
  staffId: string;
  reason: string;
}

export interface ConflictCheckResult {
  hasConflicts: boolean;
  affectedCount: number;
  affectedBookings: AffectedBooking[];
}

export interface FindAffectedBookingsParams {
  botId: string;
  prisma: PrismaClient;
  now?: Date;
  newBlock?: {
    resourceId: string;
    startsAt: Date;
    endsAt: Date;
  };
  newSettings?: QuickBookConfig;
}

export async function findAffectedBookings(
  params: FindAffectedBookingsParams,
): Promise<ConflictCheckResult> {
  const { botId, prisma, newBlock, newSettings } = params;
  const now = params.now ?? new Date();

  const activeBookings = await prisma.booking.findMany({
    where: {
      botId,
      status: { in: ["PENDING", "CONFIRMED"] },
      slotTime: { gte: now },
    },
    orderBy: { slotTime: "asc" },
  });

  const affected: AffectedBooking[] = [];

  for (const b of activeBookings) {
    const bStartMs = b.slotTime.getTime();
    const bEndMs = b.endTime ? b.endTime.getTime() : bStartMs + b.durationMin * 60000;

    if (newBlock) {
      const matchResource = newBlock.resourceId === "all" || newBlock.resourceId === b.staffId;
      const overlaps = bStartMs < newBlock.endsAt.getTime() && bEndMs > newBlock.startsAt.getTime();
      if (matchResource && overlaps) {
        affected.push({
          id: b.id,
          customerName: b.customerName,
          customerPhone: b.customerPhone,
          slotTime: b.slotTime,
          endTime: b.endTime,
          serviceName: b.serviceName,
          staffId: b.staffId,
          reason: "OVERLAPS_TIME_BLOCK",
        });
        continue;
      }
    }

    if (newSettings) {
      const service = newSettings.services.find((s) => s.id === b.serviceId);
      if (!service) {
        affected.push({
          id: b.id,
          customerName: b.customerName,
          customerPhone: b.customerPhone,
          slotTime: b.slotTime,
          endTime: b.endTime,
          serviceName: b.serviceName,
          staffId: b.staffId,
          reason: "SERVICE_REMOVED",
        });
        continue;
      }

      const resource = newSettings.resources.find((r) => r.id === b.staffId);
      if (!resource) {
        affected.push({
          id: b.id,
          customerName: b.customerName,
          customerPhone: b.customerPhone,
          slotTime: b.slotTime,
          endTime: b.endTime,
          serviceName: b.serviceName,
          staffId: b.staffId,
          reason: "RESOURCE_REMOVED",
        });
        continue;
      }

      const dateStr = tashkentDateString(b.slotTime);
      const { dayOfWeek } = parseTashkentDate(dateStr);
      if (!resource.workDays.includes(dayOfWeek)) {
        affected.push({
          id: b.id,
          customerName: b.customerName,
          customerPhone: b.customerPhone,
          slotTime: b.slotTime,
          endTime: b.endTime,
          serviceName: b.serviceName,
          staffId: b.staffId,
          reason: "DAY_NOT_IN_WORK_DAYS",
        });
        continue;
      }

      const slotHours = (b.slotTime.getUTCHours() + 5) % 24;
      const slotMins = b.slotTime.getUTCMinutes();
      const slotTotalMins = slotHours * 60 + slotMins;
      const slotEndTotalMins = slotTotalMins + b.durationMin;

      const workStartMins = parseTimeToMinutes(resource.workHours.start);
      const workEndMins = parseTimeToMinutes(resource.workHours.end);

      if (slotTotalMins < workStartMins || slotEndTotalMins > workEndMins) {
        affected.push({
          id: b.id,
          customerName: b.customerName,
          customerPhone: b.customerPhone,
          slotTime: b.slotTime,
          endTime: b.endTime,
          serviceName: b.serviceName,
          staffId: b.staffId,
          reason: "OUTSIDE_WORK_HOURS",
        });
        continue;
      }
    }
  }

  return {
    hasConflicts: affected.length > 0,
    affectedCount: affected.length,
    affectedBookings: affected,
  };
}
