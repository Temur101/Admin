import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { registerBotsSimpleSettingsRoutes } from "../src/admin-api/bots-simple-settings.js";
import { actors, readinessConfig, readinessFixture } from "./helpers/readiness-fixture.js";
import { createTimeBlock } from "../src/bots/quickbook/time-block-service.js";
import { createBooking } from "../src/bots/quickbook/booking-service.js";
import { logger } from "../src/core/logger.js";
let f: Awaited<ReturnType<typeof readinessFixture>>;
let app: ReturnType<typeof Fastify>;
let headers: { authorization: string };
beforeEach(async () => {
  f = await readinessFixture();
  app = Fastify();
  await app.register(jwt, { secret: "test" });
  registerBotsSimpleSettingsRoutes(app, f.prisma, f.redis);
  await app.ready();
  headers = { authorization: `Bearer ${app.jwt.sign({ tokenType: "access" })}` };
});
afterEach(async () => {
  await app?.close();
  await f?.close();
});
describe("Readiness stage 3: settings and time blocks", () => {
  it.each([
    { start: "99:99", end: "00:00" },
    { start: "18:00", end: "09:00" },
    { start: "09:00", end: "18:00", workDays: [] },
  ])("rejects invalid hours without saving: %j", async (workHours) => {
    const r = await app.inject({
      method: "PATCH",
      url: `/api/v1/bots/${f.bot.id}/simple-settings`,
      headers,
      payload: { workHours },
    });
    expect(r.statusCode).toBe(400);
    expect((await f.prisma.bot.findUniqueOrThrow({ where: { id: f.bot.id } })).settings).toEqual(
      f.bot.settings,
    );
  });
  it("invalidates both real metadata cache keys", async () => {
    await f.resolver.resolveById(f.bot.id);
    const r = await app.inject({
      method: "PATCH",
      url: `/api/v1/bots/${f.bot.id}/simple-settings`,
      headers,
      payload: { prices: [{ serviceId: "haircut", priceUzs: 99999 }] },
    });
    expect(r.statusCode).toBe(200);
    for (const meta of [
      await f.resolver.resolveById(f.bot.id),
      await f.resolver.resolve(f.bot.botTokenHash),
    ])
      expect((meta!.settings.services as { priceUzs: number }[])[0]!.priceUzs).toBe(99999);
  });
  it("requires owner confirmation before blocking an existing booking", async () => {
    await f.booking();
    await f.callback(actors.owner, "tb:create:all:tomorrow");
    expect(await f.prisma.timeBlock.count()).toBe(0);
    const confirm = f
      .buttons()!
      .inline_keyboard.flat()
      .find((b) => b.callback_data.startsWith("tb:confirm:"))!;
    expect(confirm).toBeTruthy();
    await f.callback(actors.owner, confirm.callback_data);
    expect(await f.prisma.timeBlock.count()).toBe(1);
    await f.callback(actors.owner, confirm.callback_data);
    expect(await f.prisma.timeBlock.count()).toBe(1);
  });
  it("rejects unknown resource IDs", async () => {
    const r = await app.inject({
      method: "POST",
      url: `/api/v1/bots/${f.bot.id}/time-blocks`,
      headers,
      payload: {
        resourceId: "foreign",
        startsAt: f.slot().toISOString(),
        endsAt: f.slot("13:00").toISOString(),
      },
    });
    expect(r.statusCode).toBe(400);
    expect(await f.prisma.timeBlock.count()).toBe(0);
  });
  it("serializes a day block and a concurrent booking", async () => {
    const results = await Promise.allSettled([
      createTimeBlock(f.prisma, {
        botId: f.bot.id,
        resourceId: "all",
        startsAt: f.slot(),
        endsAt: f.slot("13:00"),
      }),
      createBooking({
        ...f,
        logger,
        botId: f.bot.id,
        customerTgId: actors.client,
        customerPhone: "+998901234567",
        serviceId: "haircut",
        staffId: "master1",
        slotTime: f.slot(),
        config: readinessConfig,
      }),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    const blocks = await f.prisma.timeBlock.count();
    const bookings = await f.prisma.booking.count();
    expect(blocks + bookings).toBe(1);
  });
});
