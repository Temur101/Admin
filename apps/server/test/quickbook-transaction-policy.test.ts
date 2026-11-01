import type { Prisma, PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { actors, readinessConfig, readinessFixture } from "./helpers/readiness-fixture.js";
import { createBooking } from "../src/bots/quickbook/booking-service.js";
import { rescheduleBooking } from "../src/bots/quickbook/reschedule-service.js";
import { scheduleSettingChange } from "../src/bots/quickbook/setting-changes.js";
import { logger } from "../src/core/logger.js";
let f: Awaited<ReturnType<typeof readinessFixture>>;
const cfg = { ...readinessConfig, minLeadMinutes: 60 };
beforeEach(async () => {
  f = await readinessFixture();
  await f.prisma.bot.update({ where: { id: f.bot.id }, data: { settings: cfg } });
});
afterEach(async () => {
  vi.useRealTimers();
  await f?.close();
});
function beforeTransaction(hook: () => Promise<unknown> | void): PrismaClient {
  return new Proxy(f.prisma, {
    get(target, key, receiver) {
      if (key !== "$transaction") return Reflect.get(target, key, receiver);
      return async (
        fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options?: { maxWait?: number; timeout?: number },
      ) => {
        await hook();
        return f.prisma.$transaction(fn, options);
      };
    },
  });
}
function args(prisma = f.prisma) {
  return {
    prisma,
    redis: f.redis,
    transport: f.transport,
    logger,
    botId: f.bot.id,
    customerTgId: actors.client,
    customerPhone: "+998901234567",
    serviceId: "haircut",
    staffId: "master1",
    slotTime: new Date("2026-11-02T15:00:00+05:00"),
    config: cfg,
    expectedPriceUzs: 50000,
  };
}
function clock(at: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
}
describe("Booking policy at the transaction boundary", () => {
  it("checks time after a real PostgreSQL resource lock wait", async () => {
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locker = f.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${f.bot.id}:master1`}));`;
        acquired();
        await hold;
      },
      { timeout: 15000 },
    );
    await ready;
    clock("2026-11-02T14:00:00+05:00");
    const booking = createBooking(args());
    try {
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const rows = await f.prisma.$queryRaw<
          { count: bigint }[]
        >`SELECT count(*) FROM pg_stat_activity WHERE wait_event = 'advisory' AND query LIKE '%pg_advisory_xact_lock%';`;
        if (Number(rows[0]?.count) > 0) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      vi.setSystemTime(new Date("2026-11-02T14:00:01+05:00"));
      release();
      expect(await booking).toMatchObject({ success: false, error: "TOO_SOON" });
      expect(await f.prisma.booking.count()).toBe(0);
    } finally {
      release();
      await Promise.allSettled([locker, booking]);
    }
  });
  it("requires a new confirmation if price changes after the preflight read", async () => {
    clock("2026-11-02T12:00:00+05:00");
    const db = beforeTransaction(() =>
      f.prisma.bot.update({
        where: { id: f.bot.id },
        data: {
          settings: { ...cfg, services: cfg.services.map((s) => ({ ...s, priceUzs: 75000 })) },
        },
      }),
    );
    expect(await createBooking(args(db))).toMatchObject({
      success: false,
      error: "PRICE_CHANGED",
      priceUzs: 75000,
    });
    expect(await f.prisma.booking.count()).toBe(0);
  });
  it("rejects a slot that becomes less than an hour away while entering the transaction", async () => {
    clock("2026-11-02T14:00:00+05:00");
    const db = beforeTransaction(() => {
      vi.setSystemTime(new Date("2026-11-02T14:00:01+05:00"));
    });
    expect(await createBooking(args(db))).toMatchObject({ success: false, error: "TOO_SOON" });
    expect(await f.prisma.booking.count()).toBe(0);
  });
  it("keeps the original booking when the same boundary is crossed during reschedule", async () => {
    const original = await f.prisma.booking.create({
      data: {
        botId: f.bot.id,
        customerTgId: actors.client,
        customerPhone: "+998901234567",
        serviceId: "haircut",
        serviceName: "Стрижка",
        staffId: "master1",
        durationMin: 30,
        priceUzs: 50000,
        slotTime: new Date("2026-11-03T12:00:00+05:00"),
        status: "CONFIRMED",
      },
    });
    clock("2026-11-02T14:00:00+05:00");
    const prisma = beforeTransaction(() => {
      vi.setSystemTime(new Date("2026-11-02T14:00:01+05:00"));
    });
    const result = await rescheduleBooking({
      ...args(prisma),
      bookingId: original.id,
      newSlotTime: args().slotTime,
      userId: actors.client,
    });
    expect(result).toEqual({ success: false, error: "TOO_SOON" });
    expect(
      (await f.prisma.booking.findUniqueOrThrow({ where: { id: original.id } })).slotTime,
    ).toEqual(original.slotTime);
  });
  it("observes a pending price activation across midnight without a worker", async () => {
    await scheduleSettingChange(f.prisma, {
      botId: f.bot.id,
      kind: "SERVICE_PRICE",
      targetId: "haircut",
      newValue: 75000,
      author: { tgId: actors.owner },
      now: new Date("2026-11-01T12:00:00+05:00"),
    });
    clock("2026-11-01T23:59:59+05:00");
    const db = beforeTransaction(() => {
      vi.setSystemTime(new Date("2026-11-02T00:00:01+05:00"));
    });
    expect(await createBooking(args(db))).toMatchObject({
      success: false,
      error: "PRICE_CHANGED",
      priceUzs: 75000,
    });
  });
  it("cannot create a booking for a service removed after the preflight read", async () => {
    clock("2026-11-02T12:00:00+05:00");
    const db = beforeTransaction(() =>
      f.prisma.bot.update({
        where: { id: f.bot.id },
        data: { settings: { ...cfg, services: [] } },
      }),
    );
    expect(await createBooking(args(db))).toMatchObject({
      success: false,
      error: "SERVICE_NOT_FOUND",
    });
  });
});
