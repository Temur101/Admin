import type { Prisma } from "@prisma/client";
import type { QuickBookConfig } from "@lcqb/contracts";
import { loadEffectiveConfig } from "./effective-settings.js";
import { validateBookingSlotEligibility } from "./booking-validator.js";

type EligibilityError = Extract<
  ReturnType<typeof validateBookingSlotEligibility>,
  { valid: false }
>["error"];
type PolicyError = EligibilityError | "SERVICE_NOT_FOUND" | "STAFF_NOT_FOUND" | "PRICE_CHANGED";

export class BookingPolicyError extends Error {
  constructor(
    readonly code: PolicyError,
    readonly config: QuickBookConfig | null,
    readonly priceUzs?: number,
  ) {
    super(code);
  }
}

/** Shared Bot row lock allows independent masters to book concurrently, but serializes config writes. */
export async function lockBookingPolicy(
  tx: Prisma.TransactionClient,
  botId: string,
  staffId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM "Bot" WHERE id = ${botId}::uuid FOR SHARE`;
  if (!rows.length) throw new BookingPolicyError("SERVICE_NOT_FOUND", null);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${`calendar:${botId}`}));`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${botId}:${staffId}`}));`;
}

/** Call after ALL locks: time and due changes must be evaluated at the actual write boundary. */
export async function checkBookingPolicy(
  tx: Prisma.TransactionClient,
  p: {
    botId: string;
    serviceId: string;
    staffId: string;
    slotDate: Date;
    now?: Date;
    skipMinLead?: boolean;
    expectedPriceUzs?: number;
    durationMin?: number;
  },
) {
  const now = p.now ?? new Date();
  const config = await loadEffectiveConfig(tx, p.botId, now);
  const service = config?.services.find((s) => s.id === p.serviceId);
  if (!config || !service) throw new BookingPolicyError("SERVICE_NOT_FOUND", config);
  const staff = config.resources.find((r) => r.id === p.staffId);
  if (!staff) throw new BookingPolicyError("STAFF_NOT_FOUND", config);
  if (p.expectedPriceUzs !== undefined && p.expectedPriceUzs !== service.priceUzs) {
    throw new BookingPolicyError("PRICE_CHANGED", config, service.priceUzs);
  }
  const chosenService =
    p.durationMin === undefined ? service : { ...service, durationMin: p.durationMin };
  const eligibility = validateBookingSlotEligibility({
    config,
    service: chosenService,
    staff,
    slotDate: p.slotDate,
    now,
    skipMinLead: p.skipMinLead,
  });
  if (!eligibility.valid) throw new BookingPolicyError(eligibility.error, config);
  return {
    config,
    service: chosenService,
    staff,
    endTime: new Date(p.slotDate.getTime() + chosenService.durationMin * 60000),
  };
}
