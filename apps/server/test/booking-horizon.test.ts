import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createEmptyQuickBookConfig } from "@lcqb/contracts";
import {
  bookingWindow,
  isBookingDateAllowed,
  tashkentDateString,
} from "../src/bots/quickbook/booking-horizon.js";
import { validateBookingSlotEligibility } from "../src/bots/quickbook/booking-validator.js";
import {
  generateAvailableSlots,
  getAlternativeSlots,
} from "../src/bots/quickbook/slot-generator.js";
const config = () => ({
  ...createEmptyQuickBookConfig(),
  bookingHorizonDays: 1,
  services: [{ id: "s", name: { ru: "Услуга", uz: "Xizmat" }, durationMin: 30, priceUzs: 0 }],
  resources: [
    {
      id: "r",
      name: { ru: "Ресурс", uz: "Resurs" },
      workDays: [0, 1, 2, 3, 4, 5, 6],
      workHours: { start: "00:00", end: "23:59" },
    },
  ],
});
describe("Единый срок записи по времени Ташкента", () => {
  it.each([1, 7, 14, 60])(
    "%i календарных дней включает сегодня и исключает следующий день",
    (days) => {
      const cfg = { ...config(), bookingHorizonDays: days };
      const now = new Date("2026-12-31T18:59:00Z");
      const bounds = bookingWindow(cfg, now);
      expect(bounds.start).toBe(new Date("2026-12-30T19:00:00Z").getTime());
      expect(bounds.end - bounds.start).toBe(days * 86400000);
      expect(isBookingDateAllowed("2026-12-31", cfg, now)).toBe(true);
      expect(isBookingDateAllowed(tashkentDateString(new Date(bounds.end - 1)), cfg, now)).toBe(
        true,
      );
      expect(isBookingDateAllowed(tashkentDateString(new Date(bounds.end)), cfg, now)).toBe(false);
    },
  );
  it("граница суток переключается в 19:00 UTC, включая смену года", () => {
    expect(tashkentDateString(new Date("2026-12-31T19:00:00Z"))).toBe("2027-01-01");
    expect(isBookingDateAllowed("2027-01-01", config(), new Date("2026-12-31T19:00:00Z"))).toBe(
      true,
    );
    expect(isBookingDateAllowed("2026-12-31", config(), new Date("2026-12-31T19:00:00Z"))).toBe(
      false,
    );
  });
  it.each(["2026-02-30", "2026-13-01", "2026-1-01", "bad", "2026-10-18"])(
    "не допускает некорректную или прошедшую дату %s",
    (date) => {
      expect(isBookingDateAllowed(date, config(), new Date("2026-10-19T03:00:00Z"))).toBe(false);
    },
  );
  it("проверка создания допускает последнее время разрешённого дня, но не следующий день", () => {
    const cfg = config();
    const check = (slot: string) =>
      validateBookingSlotEligibility({
        config: cfg,
        service: cfg.services[0]!,
        staff: cfg.resources[0]!,
        slotDate: new Date(slot),
        now: new Date("2026-10-19T03:00:00Z"),
      });
    expect(check("2026-10-19T18:00:00Z")).toEqual({ valid: true });
    expect(check("2026-10-19T19:00:00Z")).toEqual({ valid: false, error: "OUTSIDE_HORIZON" });
    expect(check("2026-10-20T03:30:00Z")).toEqual({ valid: false, error: "OUTSIDE_HORIZON" });
  });
  it("генерация за пределами горизонта не обращается к базе", async () => {
    const findMany = vi.fn(async () => []);
    const prisma = { booking: { findMany } } as unknown as PrismaClient;
    for (const dateStr of ["2026-10-18", "2026-10-20", "2026-02-30"])
      expect(
        await generateAvailableSlots({
          botId: "b",
          config: config(),
          serviceId: "s",
          dateStr,
          prisma,
          now: new Date("2026-10-19T03:00:00Z"),
        }),
      ).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
  it("альтернативы не предлагают завтра при горизонте один день", async () => {
    const cfg = config();
    cfg.resources[0]!.workHours = { start: "09:00", end: "10:00" };
    const now = new Date("2026-10-19T04:15:00Z");
    const prisma = { booking: { findMany: vi.fn(async () => []) } } as unknown as PrismaClient;
    const result = await getAlternativeSlots(
      { botId: "b", config: cfg, serviceId: "s", dateStr: "2026-10-19", prisma, now },
      20,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.timeLabel).toBe("09:30");
    expect(result.every((slot) => tashkentDateString(slot.slotTime) === "2026-10-19")).toBe(true);
    expect(prisma.booking.findMany).toHaveBeenCalledOnce();
  });
});
