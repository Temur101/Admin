import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actors, readinessFixture } from "./helpers/readiness-fixture.js";
import { submitPaymentReceipt, approveReceipt, rejectReceipt } from "../src/bots/shared/payment-service.js";
import { addMonths } from "../src/bots/shared/subscription.js";
let f: Awaited<ReturnType<typeof readinessFixture>>;
beforeEach(async () => { f = await readinessFixture(); });
afterEach(async () => { await f?.close(); });
const submit = (months = 12) => submitPaymentReceipt({ prisma: f.prisma, redis: f.redis, botId: f.bot.id, submittedByTgId: actors.owner, kind: "TEXT", months, amountUzs: 1000000, textNote: "Текст без подтверждённого перевода" });
describe("Readiness stage 6: payment approval gate", () => {
  it("does not activate an expired subscription after a text receipt", async () => {
    await f.prisma.subscription.update({ where: { botId: f.bot.id }, data: { status: "EXPIRED", paidUntil: null, trialEndsAt: new Date(0) } });
    const { receipt } = await submit();
    expect(receipt.status).toBe("PENDING");
    expect(await f.prisma.subscription.findUniqueOrThrow({ where: { botId: f.bot.id } })).toMatchObject({ status: "EXPIRED", paidUntil: null });
  });
  it("extends an existing paid period exactly once under concurrent approval", async () => {
    const before = await f.prisma.subscription.findUniqueOrThrow({ where: { botId: f.bot.id } });
    const { receipt } = await submit(1);
    expect((await f.prisma.subscription.findUniqueOrThrow({ where: { botId: f.bot.id } })).paidUntil).toEqual(before.paidUntil);
    await Promise.all([1, 2, 3, 4].map(() => approveReceipt({ prisma: f.prisma, redis: f.redis, receiptId: receipt.id })));
    expect((await f.prisma.subscription.findUniqueOrThrow({ where: { botId: f.bot.id } })).paidUntil).toEqual(addMonths(before.paidUntil!, 1));
  });
  it("rejects a pending receipt without removing an independently extended paid period", async () => {
    const { receipt } = await submit(1);
    const independent = new Date(Date.now() + 90 * 86400000);
    await f.prisma.subscription.update({ where: { botId: f.bot.id }, data: { paidUntil: independent } });
    await rejectReceipt({ prisma: f.prisma, redis: f.redis, receiptId: receipt.id, reason: "Не подтверждено" });
    expect((await f.prisma.subscription.findUniqueOrThrow({ where: { botId: f.bot.id } })).paidUntil).toEqual(independent);
  });
  it("keeps one terminal outcome when approval races rejection", async () => {
    const before = await f.prisma.subscription.findUniqueOrThrow({ where: { botId: f.bot.id } });
    const { receipt } = await submit(1);
    await Promise.all([approveReceipt({ prisma: f.prisma, receiptId: receipt.id }), rejectReceipt({ prisma: f.prisma, receiptId: receipt.id, reason: "Нет оплаты" })]);
    const final = await f.prisma.paymentReceipt.findUniqueOrThrow({ where: { id: receipt.id } });
    const sub = await f.prisma.subscription.findUniqueOrThrow({ where: { botId: f.bot.id } });
    expect(sub.paidUntil).toEqual(final.status === "APPROVED" ? addMonths(before.paidUntil!, 1) : before.paidUntil);
  });
});
it.each(["approve", "reject"] as const)("reviews a legacy optimistic pending receipt safely: %s", async action => {
  const original = new Date("2027-01-31T10:00:00Z");
  const granted = addMonths(original, 1);
  await f.prisma.subscription.update({ where: { botId: f.bot.id }, data: { paidUntil: original } });
  const { receipt } = await submit(1);
  await f.prisma.paymentReceipt.update({ where: { id: receipt.id }, data: { optimisticGranted: true, prevPaidUntil: original, grantedUntil: granted } });
  await f.prisma.subscription.update({ where: { botId: f.bot.id }, data: { paidUntil: granted } });
  if (action === "approve") await approveReceipt({ prisma: f.prisma, receiptId: receipt.id });
  else await rejectReceipt({ prisma: f.prisma, receiptId: receipt.id, reason: "Legacy rejection" });
  expect((await f.prisma.subscription.findUniqueOrThrow({ where: { botId: f.bot.id } })).paidUntil).toEqual(action === "approve" ? granted : original);
});
it("rejects a legacy grant without losing an independent seven-day extension", async () => {
  const original = new Date("2027-01-31T10:00:00Z"); const granted = addMonths(original, 1);
  const { receipt } = await submit(1);
  await f.prisma.paymentReceipt.update({ where: { id: receipt.id }, data: { optimisticGranted: true, prevPaidUntil: original, grantedUntil: granted } });
  await f.prisma.subscription.update({ where: { botId: f.bot.id }, data: { paidUntil: new Date(granted.getTime() + 7 * 86400000) } });
  await rejectReceipt({ prisma: f.prisma, receiptId: receipt.id, reason: "Legacy rejection" });
  expect((await f.prisma.subscription.findUniqueOrThrow({ where: { botId: f.bot.id } })).paidUntil).toEqual(new Date(original.getTime() + 7 * 86400000));
});
it.each(["RU", "UZ"] as const)("preserves a valid trial and explains rejection correctly in %s", async lang => {
  await f.prisma.subscription.update({ where: { botId: f.bot.id }, data: { status: "TRIAL", paidUntil: null } });
  await f.prisma.botUser.update({ where: { botId_tgId: { botId: f.bot.id, tgId: BigInt(actors.owner) } }, data: { lang } });
  const { receipt } = await submit(1);
  await rejectReceipt({ prisma: f.prisma, receiptId: receipt.id, reason: "Не подтверждено", transport: f.transport });
  expect((await f.prisma.subscription.findUniqueOrThrow({ where: { botId: f.bot.id } })).status).toBe("TRIAL");
  const text = String(f.transport.callsOf("sendMessage").find(c => c.payload.chat_id === actors.owner)!.payload.text);
  expect(text).toContain(lang === "RU" ? "Пробный период" : "Sinov muddati");
});
