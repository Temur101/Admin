import { describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { DEFAULT_QUICKBOOK_CONFIG } from "../src/bots/quickbook/default-config.js";
import {
  generateAvailableSlots,
  getAlternativeSlots,
  parseTashkentDate,
} from "../src/bots/quickbook/slot-generator.js";

// Dummy prisma with mock findMany
const mockPrisma = {
  booking: {
    findMany: async () => [],
  },
} as unknown as PrismaClient;

describe("QuickBook Slot Generator Unit Tests", () => {
  it("1. should parse Tashkent date correctly for day of week", () => {
    // 2026-10-10: Saturday (day 6)
    const { dayOfWeek, year, month, day } = parseTashkentDate("2026-10-10");
    expect(year).toBe(2026);
    expect(month).toBe(10);
    expect(day).toBe(10);
    expect(dayOfWeek).toBe(6);
  });

  it("2. should return 0 slots for staff day-off (Sunday for Alisher)", async () => {
    // Alisher works 1-6 (Mon-Sat), Sunday (day 0) is his day off.
    // 2026-10-11 is Sunday
    const slots = await generateAvailableSlots({
      botId: "bot_test",
      config: DEFAULT_QUICKBOOK_CONFIG,
      serviceId: "srv_haircut",
      staffId: "staff_alisher",
      dateStr: "2026-10-11",
      prisma: mockPrisma,
      now: new Date("2026-10-01T00:00:00Z"),
    });

    expect(slots).toHaveLength(0);
  });

  it("3. should generate valid slots within working hours and exclude breaks", async () => {
    // 2026-10-12 is Monday. Alisher works 10:00 - 20:00, break 14:00 - 15:00.
    // Haircut duration = 45 min, interval = 30 min.
    const slots = await generateAvailableSlots({
      botId: "bot_test",
      config: DEFAULT_QUICKBOOK_CONFIG,
      serviceId: "srv_haircut",
      staffId: "staff_alisher",
      dateStr: "2026-10-12",
      prisma: mockPrisma,
      now: new Date("2026-10-01T00:00:00Z"),
    });

    expect(slots.length).toBeGreaterThan(0);

    const labels = slots.map((s) => s.timeLabel);
    // First slot should be 10:00
    expect(labels[0]).toBe("10:00");

    // 13:30 slot ends at 14:15, which overlaps 14:00-15:00 break -> must be excluded
    expect(labels).not.toContain("13:30");
    // 14:00 and 14:30 are within break -> must be excluded
    expect(labels).not.toContain("14:00");
    expect(labels).not.toContain("14:30");

    // 15:00 slot ends at 15:45 -> should be present
    expect(labels).toContain("15:00");
  });

  it("4. should exclude slots where service duration exceeds remaining work hours", async () => {
    // Alisher ends work at 20:00.
    // 19:30 slot + 45 min duration ends at 20:15 > 20:00 -> must be excluded!
    const slots = await generateAvailableSlots({
      botId: "bot_test",
      config: DEFAULT_QUICKBOOK_CONFIG,
      serviceId: "srv_haircut", // 45 min
      staffId: "staff_alisher",
      dateStr: "2026-10-12",
      prisma: mockPrisma,
      now: new Date("2026-10-01T00:00:00Z"),
    });

    const labels = slots.map((s) => s.timeLabel);
    expect(labels).toContain("19:00");
    expect(labels).not.toContain("19:30");
  });

  it("5. should exclude passed slots for today", async () => {
    // Today is 2026-10-12 at 13:00 Tashkent time (08:00 UTC)
    const nowTashkent13 = new Date("2026-10-12T08:00:00.000Z");

    const slots = await generateAvailableSlots({
      botId: "bot_test",
      config: DEFAULT_QUICKBOOK_CONFIG,
      serviceId: "srv_haircut",
      staffId: "staff_alisher",
      dateStr: "2026-10-12",
      prisma: mockPrisma,
      now: nowTashkent13,
    });

    const labels = slots.map((s) => s.timeLabel);
    // Slots before 13:00 (10:00, 10:30, 11:00, 11:30, 12:00, 12:30) must be hidden
    expect(labels).not.toContain("10:00");
    expect(labels).not.toContain("11:00");
    expect(labels).not.toContain("12:30");
    // 15:00 is in the future -> present
    expect(labels).toContain("15:00");
  });

  it("6. should exclude slots overlapping existing bookings in database", async () => {
    // Existing booking at 11:00 for 45 min (ends 11:45)
    const existingSlotUtc = new Date(Date.UTC(2026, 9, 12, 11 - 5, 0, 0));

    const prismaWithBooking = {
      booking: {
        findMany: async () => [
          {
            staffId: "staff_alisher",
            slotTime: existingSlotUtc,
            durationMin: 45,
          },
        ],
      },
    } as unknown as PrismaClient;

    const slots = await generateAvailableSlots({
      botId: "bot_test",
      config: DEFAULT_QUICKBOOK_CONFIG,
      serviceId: "srv_haircut",
      staffId: "staff_alisher",
      dateStr: "2026-10-12",
      prisma: prismaWithBooking,
      now: new Date("2026-10-01T00:00:00Z"),
    });

    const labels = slots.map((s) => s.timeLabel);
    // 11:00 is booked -> must be excluded
    expect(labels).not.toContain("11:00");
    // 11:30 slot ends at 12:15 and overlaps 11:00-11:45 -> must be excluded
    expect(labels).not.toContain("11:30");
    // 12:00 is after 11:45 -> available
    expect(labels).toContain("12:00");
  });

  it("7. should provide alternative slots when target slot is taken", async () => {
    const alternatives = await getAlternativeSlots(
      {
        botId: "bot_test",
        config: DEFAULT_QUICKBOOK_CONFIG,
        serviceId: "srv_haircut",
        staffId: "staff_alisher",
        dateStr: "2026-10-12",
        prisma: mockPrisma,
        now: new Date("2026-10-01T00:00:00Z"),
      },
      3,
    );

    expect(alternatives.length).toBe(3);
    expect(alternatives[0]?.timeLabel).toBe("10:00");
  });
});
