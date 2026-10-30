import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actors, readinessFixture } from "./helpers/readiness-fixture.js";

let f: Awaited<ReturnType<typeof readinessFixture>>;
beforeEach(async () => {
  f = await readinessFixture();
});
afterEach(async () => {
  await f?.close();
});
const manualSession = (slot: Date) => ({
  lang: "RU" as const,
  isAdmin: true,
  quickbook: {
    runId: "newrun123",
    isAdminBooking: true,
    step: "admin_summary" as const,
    serviceId: "haircut",
    resourceId: "master1",
    slotTimeIso: slot.toISOString(),
    customerName: "Client",
    phone: "+998901234567",
  },
});

describe("Readiness stage 1: authorization regression gate", () => {
  it.each([actors.client, actors.staff, actors.other])(
    "rejects a forged day block from %s",
    async (user) => {
      await f.callback(user, "tb:create:all:tomorrow");
      expect(await f.prisma.timeBlock.count()).toBe(0);
    },
  );
  it("does not expose owner menus to staff or clients", async () => {
    for (const user of [actors.client, actors.staff]) {
      f.transport.clear();
      await f.callback(user, "tb:menu:add");
      expect(
        f
          .buttons()
          ?.inline_keyboard.flat()
          .some((b) => b.callback_data.startsWith("tb:add:")),
      ).not.toBe(true);
    }
  });
  it("allows the owner to create/delete but denies staff deletion", async () => {
    await f.callback(actors.owner, "tb:create:all:tomorrow");
    const block = await f.prisma.timeBlock.findFirstOrThrow();
    await f.callback(actors.staff, `tb:del:${block.id}`);
    expect(await f.prisma.timeBlock.count()).toBe(1);
    await f.callback(actors.owner, `tb:del:${block.id}`);
    expect(await f.prisma.timeBlock.count()).toBe(0);
  });
  it("rechecks revoked owner rights even with a stale admin session", async () => {
    await f.setSession(actors.owner, manualSession(f.slot()));
    await f.prisma.botUser.update({
      where: { botId_tgId: { botId: f.bot.id, tgId: BigInt(actors.owner) } },
      data: { isAdmin: false, role: null },
    });
    await f.callback(actors.owner, "tb:create:all:tomorrow");
    await f.callback(actors.owner, "qb:adm:confirm:newrun123");
    expect(await f.prisma.timeBlock.count()).toBe(0);
    expect(await f.prisma.booking.count()).toBe(0);
  });
  it("rejects the original manual-confirm exploit from a client session", async () => {
    await f.setSession(actors.client, {
      ...manualSession(f.slot()),
      isAdmin: false,
      quickbook: { ...manualSession(f.slot()).quickbook, isAdminBooking: false, step: "summary" },
    });
    await f.callback(actors.client, "qb:adm:confirm");
    expect(await f.prisma.booking.count()).toBe(0);
  });
  it.each([actors.owner, actors.staff])(
    "allows a current manual confirmation by authorized actor %s",
    async (user) => {
      await f.setSession(user, manualSession(f.slot()));
      await f.callback(user, "qb:adm:confirm:newrun123");
      const booking = await f.prisma.booking.findFirstOrThrow();
      expect(booking).toMatchObject({
        source: "MANUAL",
        customerTgId: null,
        createdByTgId: BigInt(user),
      });
    },
  );
  it("rejects an old confirmation for a different run and a non-summary step", async () => {
    await f.setSession(actors.owner, manualSession(f.slot()));
    await f.callback(actors.owner, "qb:adm:confirm:oldrun123");
    await f.setSession(actors.owner, {
      ...manualSession(f.slot()),
      quickbook: { ...manualSession(f.slot()).quickbook, step: "admin_phone" },
    });
    await f.callback(actors.owner, "qb:adm:confirm:newrun123");
    expect(await f.prisma.booking.count()).toBe(0);
  });
  it("rejects another customer's reschedule menus", async () => {
    const booking = await f.booking();
    for (const data of [
      `qb:my:resched:${booking.id}`,
      `qb:rs:d:${booking.id}:0`,
      `qb:rs:s:${booking.id}:${f.tomorrow}`,
    ]) {
      f.transport.clear();
      await f.callback(actors.other, data);
      expect(
        f
          .buttons()
          ?.inline_keyboard.flat()
          .some((b) => b.callback_data.startsWith("qb:rs:")),
      ).not.toBe(true);
    }
  });
  it("rejects reschedule previews for a booking in another bot", async () => {
    const otherBot = await f.prisma.bot.create({
      data: {
        tenantId: f.bot.tenantId,
        botType: "QUICKBOOK",
        botTokenEnc: f.bot.botTokenEnc,
        botTokenHash: "other-fixture-hash",
        webhookSecret: "other-fixture",
      },
    });
    const booking = await f.booking();
    await f.prisma.booking.update({ where: { id: booking.id }, data: { botId: otherBot.id } });
    await f.callback(actors.client, `qb:rs:s:${booking.id}:${f.tomorrow}`);
    expect(
      f
        .buttons()
        ?.inline_keyboard.flat()
        .some((b) => b.callback_data.startsWith("qb:rs:")),
    ).not.toBe(true);
  });
});
