import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actors, readinessConfig, readinessFixture } from "./helpers/readiness-fixture.js";
import { callbackId } from "../src/bots/shared/callback-id.js";
import { rescheduleBooking } from "../src/bots/quickbook/reschedule-service.js";
import { logger } from "../src/core/logger.js";
let f: Awaited<ReturnType<typeof readinessFixture>>;
beforeEach(async () => {
  f = await readinessFixture();
});
afterEach(async () => {
  await f?.close();
});
const button = (prefix: string) =>
  f
    .buttons()!
    .inline_keyboard.flat()
    .find((b) => b.callback_data.startsWith(prefix))!.callback_data;

describe("Readiness stage 2: complete booking flows", () => {
  it.each([actors.owner, actors.staff])(
    "completes a manual booking end to end for %s",
    async (user) => {
      await f.message(user, "➕ Записать клиента");
      await f.callback(user, button("qb:srv:"));
      await f.callback(
        user,
        f
          .buttons()!
          .inline_keyboard.flat()
          .find((b) => b.callback_data.endsWith(callbackId("master1")))!.callback_data,
      );
      await f.callback(
        user,
        f
          .buttons()!
          .inline_keyboard.flat()
          .find((b) => b.callback_data.endsWith(f.tomorrow))!.callback_data,
      );
      await f.callback(user, button("qb:slot:"));
      expect((await f.session(user)).quickbook?.step).toBe("admin_name");
      await f.message(user, "Записанный клиент");
      await f.message(user, "+998901234567");
      await f.callback(user, button("qb:adm:confirm:"));
      expect(await f.prisma.booking.findFirstOrThrow()).toMatchObject({
        customerName: "Записанный клиент",
        customerTgId: null,
        source: "MANUAL",
        createdByTgId: BigInt(user),
      });
      expect((await f.redis.keys("lock:slot:*")).length).toBe(0);
    },
  );
  it("releases a manual hold when cancelled", async () => {
    await f.message(actors.owner, "➕ Записать клиента");
    await f.callback(
      actors.owner,
      `qb:slot:${callbackId("haircut")}:${callbackId("master1")}:${f.slot().toISOString()}`,
    );
    const held = (await f.session(actors.owner)).quickbook;
    expect(held?.lockToken).toBeTruthy();
    await f.callback(actors.owner, "qb:adm:cancel");
    expect((await f.session(actors.owner)).quickbook).toBeUndefined();
    expect((await f.redis.keys("lock:slot:*")).length).toBe(0);
  });
  it("reschedules through a short callback and rejects a stale replay", async () => {
    const b = await f.booking();
    await f.callback(actors.client, `qb:my:resched:${b.id}`);
    await f.callback(actors.client, `qb:rs:s:${b.id}:${f.tomorrow}`);
    const data = button("qb:rs:c:");
    for (const b of f.buttons()!.inline_keyboard.flat())
      expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
    await f.callback(actors.client, data);
    const updated = await f.prisma.booking.findUniqueOrThrow({ where: { id: b.id } });
    expect(updated.slotTime.getTime()).not.toBe(b.slotTime.getTime());
    expect(updated.endTime!.getTime() - updated.slotTime.getTime()).toBe(
      updated.durationMin * 60000,
    );
    const updatedAt = updated.slotTime;
    await f.callback(actors.client, data);
    expect((await f.prisma.booking.findUniqueOrThrow({ where: { id: b.id } })).slotTime).toEqual(
      updatedAt,
    );
  });
  it("resets reminder attempts on a successful reschedule", async () => {
    const b = await f.booking();
    await f.prisma.booking.update({
      where: { id: b.id },
      data: { reminderAttempts: 3, reminderSent: true },
    });
    const result = await rescheduleBooking({
      ...f,
      logger,
      botId: f.bot.id,
      bookingId: b.id,
      newSlotTime: f.slot("13:00"),
      userId: actors.client,
      config: readinessConfig,
    });
    expect(result.success && result.booking).toMatchObject({
      reminderAttempts: 0,
      reminderSent: false,
    });
  });
  it("keeps one winner when two customers reschedule into the same slot", async () => {
    const a = await f.booking();
    const b = await f.prisma.booking.create({
      data: {
        botId: f.bot.id,
        customerTgId: actors.other,
        customerPhone: "+998901234567",
        serviceId: "haircut",
        serviceName: "Стрижка",
        staffId: "master1",
        durationMin: 30,
        slotTime: f.slot("13:00"),
        status: "CONFIRMED",
      },
    });
    const outcomes = await Promise.all(
      [a, b].map((b) =>
        rescheduleBooking({
          ...f,
          logger,
          botId: f.bot.id,
          bookingId: b.id,
          userId: Number(b.customerTgId),
          newSlotTime: f.slot("14:00"),
          config: readinessConfig,
        }),
      ),
    );
    expect(outcomes.filter((x) => x.success)).toHaveLength(1);
    expect(
      await f.prisma.booking.count({ where: { slotTime: f.slot("14:00"), status: "CONFIRMED" } }),
    ).toBe(1);
  });
});
