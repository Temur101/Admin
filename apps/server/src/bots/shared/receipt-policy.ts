import type { PaymentReceipt, Subscription, SubStatus } from "@prisma/client";

/** Only pre-migration pending receipts have already granted subscription time. */
export function paidUntilAfterRejection(receipt: PaymentReceipt, sub: Subscription): Date | null {
  if (!receipt.optimisticGranted) return sub.paidUntil;
  if (!sub.paidUntil || sub.paidUntil.getTime() === receipt.grantedUntil.getTime())
    return receipt.prevPaidUntil;
  const base =
    receipt.prevPaidUntil && receipt.prevPaidUntil > receipt.createdAt
      ? receipt.prevPaidUntil
      : receipt.createdAt;
  const grantedMs = Math.max(0, receipt.grantedUntil.getTime() - base.getTime());
  return new Date(sub.paidUntil.getTime() - grantedMs);
}

export function statusAfterRejection(
  sub: Subscription,
  paidUntil: Date | null,
  attempts: number,
  now: Date,
): SubStatus {
  if (sub.status === "BLOCKED") return "BLOCKED";
  if (paidUntil && paidUntil > now) return "ACTIVE";
  if (attempts >= 2) return "BLOCKED";
  return sub.status === "TRIAL" && sub.trialEndsAt > now ? "TRIAL" : "GRACE_PERIOD";
}
