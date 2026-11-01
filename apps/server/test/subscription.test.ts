import { describe, expect, it } from "vitest";
import type { SubStatus } from "@prisma/client";
import {
  isMaskedStatus,
  transitionSubscription,
  type SubscriptionContext,
  type SubscriptionEvent,
} from "../src/bots/shared/subscription.js";
import { maskName, maskPhone, maskUsername } from "../src/bots/shared/masking.js";

describe("Subscription State Machine (Table-Driven)", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const futureDate = new Date("2026-10-10T12:00:00Z");
  const pastDate = new Date("2026-09-20T12:00:00Z");

  interface TestCase {
    name: string;
    initialStatus: SubStatus;
    event: SubscriptionEvent;
    ctx: SubscriptionContext;
    expectedStatus: SubStatus;
    expectedChanged: boolean;
    expectedFailedAttempts?: number;
  }

  const cases: TestCase[] = [
    {
      name: "TRIAL + TICK before expiration -> stays TRIAL",
      initialStatus: "TRIAL",
      event: { type: "TICK" },
      ctx: { now, trialEndsAt: futureDate, paidUntil: null, failedReceiptAttempts: 0 },
      expectedStatus: "TRIAL",
      expectedChanged: false,
    },
    {
      name: "TRIAL + TICK after trialEndsAt -> becomes EXPIRED",
      initialStatus: "TRIAL",
      event: { type: "TICK" },
      ctx: { now, trialEndsAt: pastDate, paidUntil: null, failedReceiptAttempts: 0 },
      expectedStatus: "EXPIRED",
      expectedChanged: true,
    },
    {
      name: "ACTIVE + TICK before paidUntil -> stays ACTIVE",
      initialStatus: "ACTIVE",
      event: { type: "TICK" },
      ctx: { now, trialEndsAt: pastDate, paidUntil: futureDate, failedReceiptAttempts: 0 },
      expectedStatus: "ACTIVE",
      expectedChanged: false,
    },
    {
      name: "ACTIVE + TICK after paidUntil -> becomes EXPIRED",
      initialStatus: "ACTIVE",
      event: { type: "TICK" },
      ctx: { now, trialEndsAt: pastDate, paidUntil: pastDate, failedReceiptAttempts: 0 },
      expectedStatus: "EXPIRED",
      expectedChanged: true,
    },
    {
      name: "EXPIRED + TICK -> stays EXPIRED",
      initialStatus: "EXPIRED",
      event: { type: "TICK" },
      ctx: { now, trialEndsAt: pastDate, paidUntil: pastDate, failedReceiptAttempts: 0 },
      expectedStatus: "EXPIRED",
      expectedChanged: false,
    },
    {
      name: "EXPIRED + RECEIPT_SUBMITTED -> remains expired until approval",
      initialStatus: "EXPIRED",
      event: { type: "RECEIPT_SUBMITTED", months: 1 },
      ctx: { now, trialEndsAt: pastDate, paidUntil: pastDate, failedReceiptAttempts: 0 },
      expectedStatus: "EXPIRED",
      expectedChanged: false,
    },
    {
      name: "BLOCKED + RECEIPT_SUBMITTED -> stays BLOCKED (payments blocked)",
      initialStatus: "BLOCKED",
      event: { type: "RECEIPT_SUBMITTED", months: 1 },
      ctx: { now, trialEndsAt: pastDate, paidUntil: pastDate, failedReceiptAttempts: 2 },
      expectedStatus: "BLOCKED",
      expectedChanged: false,
    },
    {
      name: "ACTIVE + RECEIPT_APPROVED -> stays ACTIVE, resets failed attempts to 0",
      initialStatus: "ACTIVE",
      event: { type: "RECEIPT_APPROVED" },
      ctx: { now, trialEndsAt: pastDate, paidUntil: futureDate, failedReceiptAttempts: 1 },
      expectedStatus: "ACTIVE",
      expectedChanged: true,
      expectedFailedAttempts: 0,
    },
    {
      name: "ACTIVE + RECEIPT_REJECTED (attempt 1, rollback to past) -> becomes GRACE_PERIOD",
      initialStatus: "ACTIVE",
      event: { type: "RECEIPT_REJECTED", prevPaidUntil: pastDate, optimisticGranted: true },
      ctx: { now, trialEndsAt: pastDate, paidUntil: futureDate, failedReceiptAttempts: 0 },
      expectedStatus: "GRACE_PERIOD",
      expectedChanged: true,
      expectedFailedAttempts: 1,
    },
    {
      name: "GRACE_PERIOD + RECEIPT_REJECTED (attempt 2) -> becomes BLOCKED",
      initialStatus: "GRACE_PERIOD",
      event: { type: "RECEIPT_REJECTED", prevPaidUntil: pastDate, optimisticGranted: true },
      ctx: { now, trialEndsAt: pastDate, paidUntil: pastDate, failedReceiptAttempts: 1 },
      expectedStatus: "BLOCKED",
      expectedChanged: true,
      expectedFailedAttempts: 2,
    },
    {
      name: "ACTIVE + RECEIPT_REJECTED (rollback to still valid future) -> stays ACTIVE",
      initialStatus: "ACTIVE",
      event: { type: "RECEIPT_REJECTED", prevPaidUntil: futureDate },
      ctx: { now, trialEndsAt: pastDate, paidUntil: futureDate, failedReceiptAttempts: 0 },
      expectedStatus: "ACTIVE",
      expectedChanged: true,
      expectedFailedAttempts: 1,
    },
    {
      name: "EXPIRED + MANUAL_EXTEND -> becomes ACTIVE with new date",
      initialStatus: "EXPIRED",
      event: { type: "MANUAL_EXTEND", until: futureDate },
      ctx: { now, trialEndsAt: pastDate, paidUntil: pastDate, failedReceiptAttempts: 0 },
      expectedStatus: "ACTIVE",
      expectedChanged: true,
      expectedFailedAttempts: 0,
    },
    {
      name: "BLOCKED + MANUAL_UNBLOCK (future trial) -> becomes TRIAL",
      initialStatus: "BLOCKED",
      event: { type: "MANUAL_UNBLOCK" },
      ctx: { now, trialEndsAt: futureDate, paidUntil: pastDate, failedReceiptAttempts: 2 },
      expectedStatus: "TRIAL",
      expectedChanged: true,
      expectedFailedAttempts: 0,
    },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const res = transitionSubscription(tc.initialStatus, tc.event, tc.ctx);
      expect(res.nextStatus).toBe(tc.expectedStatus);
      expect(res.changed).toBe(tc.expectedChanged);
      if (tc.expectedFailedAttempts !== undefined) {
        expect(res.nextFailedAttempts).toBe(tc.expectedFailedAttempts);
      }
    });
  }
});

describe("Data Masking Logic", () => {
  it("should mask Uzbekistan phone numbers in standard format", () => {
    expect(maskPhone("+998901234567")).toBe("+998 90 *** ** 67");
    expect(maskPhone("998931112233")).toBe("+998 93 *** ** 33");
    expect(maskPhone("901234567")).toBe("+998 90 *** ** 67");
  });

  it("should mask customer names and usernames", () => {
    expect(maskName("Azizbek")).toBe("***");
    expect(maskName("")).toBe("***");
    expect(maskUsername("temur_dev")).toBe("@***");
    expect(maskUsername(null)).toBe("***");
  });

  it("should identify masked statuses correctly", () => {
    expect(isMaskedStatus("TRIAL")).toBe(false);
    expect(isMaskedStatus("ACTIVE")).toBe(false);
    expect(isMaskedStatus("EXPIRED")).toBe(true);
    expect(isMaskedStatus("GRACE_PERIOD")).toBe(true);
    expect(isMaskedStatus("BLOCKED")).toBe(true);
  });
});
