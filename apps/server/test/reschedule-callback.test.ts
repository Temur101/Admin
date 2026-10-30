import { describe, expect, it } from "vitest";

describe("Reschedule callback_data size and handling", () => {
  it("fits all callback_data within Telegram 64-byte limit", () => {
    const bookingId = "26443784-eddf-4d7c-852e-9a28f0cdae53"; // 36-char UUID
    const slotSec = 1793514600; // 10 digits
    const callbackData = `qb:rs:c:${bookingId}:${slotSec}`;
    expect(Buffer.byteLength(callbackData, "utf8")).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(callbackData, "utf8")).toBe(55);
  });
});
