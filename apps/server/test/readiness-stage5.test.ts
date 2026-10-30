import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actors, readinessFixture } from "./helpers/readiness-fixture.js";
let f: Awaited<ReturnType<typeof readinessFixture>>;
beforeEach(async () => { f = await readinessFixture(); });
afterEach(async () => { await f?.close(); });
describe("Readiness stage 5: durable owner notifications", () => {
  it("notifies the owner when the customer cancels through My bookings", async () => {
    const b = await f.booking(); f.transport.clear();
    await f.callback(actors.client, `qb:my:cancel:${b.id}`);
    expect(f.transport.callsOf("sendMessage").some(c => c.payload.chat_id === actors.owner)).toBe(true);
  });
});

import { enqueueAdminNotifications, flushNotificationOutbox } from "../src/bots/shared/notification-outbox.js";
import { MockTelegramTransport } from "../src/adapters/telegram/mock-transport.js";
import { logger } from "../src/core/logger.js";
import { handleLeadCatchContact } from "../src/bots/leadcatch/lead-submission.js";
import type { PlatformBotContext } from "../src/gateway/types.js";
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import { registerBotsOpsRoutes } from "../src/admin-api/bots-ops.js";
const event = { kind: "BOOKING_CANCELLED" as const, phone: "+998901234567", service: "Стрижка", staff: "Мастер", time: "Завтра" };
function ownerUnavailable() {
  const transport = new MockTelegramTransport();
  const original = transport.transformerFor.bind(transport);
  transport.transformerFor = botId => {
    const base = original(botId);
    return async (prev, method, payload, signal) => {
      if (method === "sendMessage" && Number((payload as { chat_id?: unknown }).chat_id) === actors.owner) throw new Error("fetch failed");
      return base(prev, method, payload, signal);
    };
  };
  return transport;
}
it("retains an undelivered lead after the customer session ends and recovers after restart", async () => {
  await f.prisma.bot.update({ where: { id: f.bot.id }, data: { botType: "LEADCATCH" } });
  const ctx = { from: { id: actors.client, first_name: "Fixture" }, chat: { id: actors.client }, botMeta: await f.resolver.resolveById(f.bot.id), session: { lang: "RU", quiz: { currentNodeId: "__summary__", startedAt: Date.now(), stepCount: 3, phone: "+998901234567", answers: { q: { question: "Вопрос", answer: "Ответ" } } } }, api: { sendMessage: async () => ({ message_id: 1 }) } } as unknown as PlatformBotContext;
  expect(await handleLeadCatchContact(ctx, f.prisma, { transport: ownerUnavailable(), logger })).toBe(true);
  expect(ctx.session.quiz).toBeUndefined();
  expect(await f.prisma.lead.count()).toBe(1);
  expect(await f.prisma.notificationDelivery.count({ where: { status: "PENDING" } })).toBe(1);
  const recoveredTransport = new MockTelegramTransport();
  await flushNotificationOutbox({ prisma: f.prisma, transport: recoveredTransport, logger, now: new Date(Date.now() + 61000) });
  expect(await f.prisma.notificationDelivery.count({ where: { status: "SENT" } })).toBe(2);
  expect(recoveredTransport.callsOf("sendMessage").map(c => c.payload.chat_id)).toEqual([actors.owner]);
});
it("enqueues each recipient once and leases concurrent workers", async () => {
  await f.prisma.$transaction(async tx => {
    await enqueueAdminNotifications(tx, f.bot.id, "test:once", event);
    await enqueueAdminNotifications(tx, f.bot.id, "test:once", event);
  });
  await Promise.all([1, 2].map(() => flushNotificationOutbox({ ...f, logger })));
  expect(await f.prisma.notificationDelivery.count()).toBe(2);
  expect(f.transport.callsOf("sendMessage")).toHaveLength(2);
});
it("rolls back the notification job together with a failed business transaction", async () => {
  await expect(f.prisma.$transaction(async tx => { await enqueueAdminNotifications(tx, f.bot.id, "test:rollback", event); throw new Error("rollback"); })).rejects.toThrow("rollback");
  expect(await f.prisma.notificationDelivery.count()).toBe(0);
});
it("recovers an expired delivery lease and skips a revoked recipient", async () => {
  await f.prisma.$transaction(tx => enqueueAdminNotifications(tx, f.bot.id, "test:lease", event));
  await f.prisma.notificationDelivery.updateMany({ data: { status: "SENDING", lockedUntil: new Date(0) } });
  await f.prisma.botUser.update({ where: { botId_tgId: { botId: f.bot.id, tgId: BigInt(actors.staff) } }, data: { isAdmin: false, role: null } });
  await flushNotificationOutbox({ ...f, logger });
  expect(await f.prisma.notificationDelivery.count({ where: { status: "SENT" } })).toBe(1);
  expect(await f.prisma.notificationDelivery.count({ where: { status: "SKIPPED" } })).toBe(1);
});
it("exposes exhausted deliveries only to an authenticated operator and supports retry", async () => {
  await f.prisma.$transaction(tx => enqueueAdminNotifications(tx, f.bot.id, "test:dead", event));
  await flushNotificationOutbox({ ...f, transport: ownerUnavailable(), logger, maxAttempts: 1 });
  const failed = await f.prisma.notificationDelivery.findFirstOrThrow({ where: { status: "FAILED" } });
  const app = Fastify(); await app.register(jwt, { secret: "test" }); registerBotsOpsRoutes(app, f.prisma); await app.ready();
  try {
    expect((await app.inject({ url: "/api/v1/system/notification-errors" })).statusCode).toBe(401);
    const headers = { authorization: `Bearer ${app.jwt.sign({ tokenType: "access" })}` };
    expect((await app.inject({ url: "/api/v1/system/notification-errors", headers })).json().deliveries).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: `/api/v1/system/notification-errors/${failed.id}/retry`, headers })).statusCode).toBe(200);
    await flushNotificationOutbox({ ...f, logger });
    expect((await f.prisma.notificationDelivery.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe("SENT");
  } finally { await app.close(); }
});
it("moves a crashed final attempt into the visible failure queue", async () => {
  await f.prisma.$transaction(tx => enqueueAdminNotifications(tx, f.bot.id, "test:final-lease", event));
  await f.prisma.notificationDelivery.updateMany({ data: { status: "SENDING", attempts: 5, lockedUntil: new Date(0) } });
  await flushNotificationOutbox({ ...f, logger });
  expect(await f.prisma.notificationDelivery.count({ where: { status: "FAILED" } })).toBe(2);
});
