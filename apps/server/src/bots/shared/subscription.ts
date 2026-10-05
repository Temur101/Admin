import type { SubStatus } from "@prisma/client";

export type SubscriptionEvent =
  | { type: "TICK" }
  | { type: "RECEIPT_SUBMITTED"; months: number }
  | { type: "RECEIPT_APPROVED" }
  | { type: "RECEIPT_REJECTED"; prevPaidUntil: Date | null; prevStatus?: SubStatus }
  | { type: "MANUAL_EXTEND"; until: Date }
  | { type: "MANUAL_UNBLOCK" };

export interface SubscriptionContext {
  now: Date;
  trialEndsAt: Date;
  paidUntil: Date | null;
  failedReceiptAttempts: number;
}

export interface TransitionResult {
  nextStatus: SubStatus;
  nextPaidUntil: Date | null;
  nextFailedAttempts: number;
  changed: boolean;
}

export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const expectedMonth = result.getMonth() + months;
  result.setMonth(expectedMonth);
  return result;
}

/**
 * Pure state machine transition function for bot subscription lifecycle.
 */
export function transitionSubscription(
  currentStatus: SubStatus,
  event: SubscriptionEvent,
  ctx: SubscriptionContext,
): TransitionResult {
  const { now, trialEndsAt, paidUntil, failedReceiptAttempts } = ctx;

  switch (event.type) {
    case "TICK": {
      if (currentStatus === "TRIAL" && now > trialEndsAt) {
        return {
          nextStatus: "EXPIRED",
          nextPaidUntil: paidUntil,
          nextFailedAttempts: failedReceiptAttempts,
          changed: true,
        };
      }
      if (currentStatus === "ACTIVE" && paidUntil && now > paidUntil) {
        return {
          nextStatus: "EXPIRED",
          nextPaidUntil: paidUntil,
          nextFailedAttempts: failedReceiptAttempts,
          changed: true,
        };
      }
      return {
        nextStatus: currentStatus,
        nextPaidUntil: paidUntil,
        nextFailedAttempts: failedReceiptAttempts,
        changed: false,
      };
    }

    case "RECEIPT_SUBMITTED": {
      if (currentStatus === "BLOCKED") {
        // Payment submission is disallowed when blocked
        return {
          nextStatus: currentStatus,
          nextPaidUntil: paidUntil,
          nextFailedAttempts: failedReceiptAttempts,
          changed: false,
        };
      }
      const baseDate = paidUntil && paidUntil > now ? paidUntil : now;
      const nextPaidUntil = addMonths(baseDate, event.months);
      return {
        nextStatus: "ACTIVE",
        nextPaidUntil,
        nextFailedAttempts: failedReceiptAttempts,
        changed: true,
      };
    }

    case "RECEIPT_APPROVED": {
      return {
        nextStatus: "ACTIVE",
        nextPaidUntil: paidUntil,
        nextFailedAttempts: 0,
        changed: failedReceiptAttempts !== 0 || currentStatus !== "ACTIVE",
      };
    }

    case "RECEIPT_REJECTED": {
      const nextFailedAttempts = failedReceiptAttempts + 1;
      const nextPaidUntil = event.prevPaidUntil;

      // If rolled-back paidUntil is still in the future, remain ACTIVE
      if (nextPaidUntil && nextPaidUntil > now) {
        return {
          nextStatus: "ACTIVE",
          nextPaidUntil,
          nextFailedAttempts,
          changed: true,
        };
      }

      if (nextFailedAttempts >= 2) {
        return {
          nextStatus: "BLOCKED",
          nextPaidUntil,
          nextFailedAttempts,
          changed: true,
        };
      }

      return {
        nextStatus: "GRACE_PERIOD",
        nextPaidUntil,
        nextFailedAttempts,
        changed: true,
      };
    }

    case "MANUAL_EXTEND": {
      return {
        nextStatus: "ACTIVE",
        nextPaidUntil: event.until,
        nextFailedAttempts: 0,
        changed: true,
      };
    }

    case "MANUAL_UNBLOCK": {
      const nextStatus: SubStatus = now < trialEndsAt ? "TRIAL" : "EXPIRED";
      return {
        nextStatus,
        nextPaidUntil: paidUntil,
        nextFailedAttempts: 0,
        changed: true,
      };
    }
  }
}

/**
 * Checks whether contacts and sensitive data should be masked for the given subscription status.
 */
export function isMaskedStatus(status: SubStatus): boolean {
  return status === "EXPIRED" || status === "GRACE_PERIOD" || status === "BLOCKED";
}
