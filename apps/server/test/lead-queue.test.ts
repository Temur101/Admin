import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LeadStatus } from "@prisma/client";
import { actors, readinessFixture } from "./helpers/readiness-fixture.js";
let f: Awaited<ReturnType<typeof readinessFixture>>;
beforeEach(async () => {
  f = await readinessFixture();
  await f.prisma.bot.update({ where: { id: f.bot.id }, data: { botType: "LEADCATCH" } });
  await f.resolver.invalidate(f.bot.botTokenHash, f.bot.id);
});
afterEach(async () => {
  await f?.close();
});
const view = () =>
  f.transport.calls
    .filter((c) => c.method === "sendMessage" || c.method === "editMessageText")
    .at(-1)!;
const text = () => String(view()?.payload.text ?? "");
const buttons = () =>
  (
    (
      view()?.payload.reply_markup as {
        inline_keyboard?: { text: string; callback_data: string }[][];
      }
    )?.inline_keyboard ?? []
  ).flat();
async function seed(name: string, status: LeadStatus = "NEW") {
  return f.prisma.lead.create({
    data: {
      botId: f.bot.id,
      customerTgId: actors.client,
      customerName: name,
      phoneRaw: "+998901234567",
      customerUsername: "queue_test_client",
      answers: { q: { question: "Что нужно?", answer: "Стрижка" } },
      status,
    },
  });
}
describe("LeadCatch actionable queue", () => {
  it("opens new leads by default with counters and individual cards", async () => {
    const fresh = await seed("Новое обращение");
    await seed("Завершённая заявка", "DONE");
    await f.message(actors.owner, "📋 Заявки/Записи");
    expect(text()).toContain("Новое обращение");
    expect(text()).not.toContain("Завершённая заявка");
    expect(buttons()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callback_data: `lq:open:${fresh.id}:N:0` }),
      ]),
    );
    expect(buttons().find((b) => b.callback_data === "lq:list:N:0")?.text).toContain("(1)");
    expect(buttons().find((b) => b.callback_data === "lq:list:D:0")?.text).toContain("(1)");
    await f.callback(actors.owner, `lq:open:${fresh.id}:N:0`);
    expect(text()).toContain("Что нужно?");
    expect(text()).toContain("Стрижка");
    expect(buttons().some((b) => b.callback_data === `lq:take:${fresh.id}:N:0`)).toBe(true);
  });
  it("takes and completes a lead from the queue, keeping history and updating original alerts", async () => {
    const lead = await seed("Очередь и история");
    await f.prisma.lead.update({
      where: { id: lead.id },
      data: { notificationRefs: [{ chatId: actors.owner, messageId: 42, lang: "RU" }] },
    });
    await f.callback(actors.owner, `lq:take:${lead.id}:N:0`);
    expect((await f.prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe(
      "IN_PROGRESS",
    );
    expect(text()).not.toContain("Очередь и история");
    expect(
      f.transport
        .callsOf("editMessageText")
        .some((c) => c.payload.message_id === 42 && String(c.payload.text).includes("В работе")),
    ).toBe(true);
    await f.callback(actors.owner, "lq:list:W:0");
    expect(text()).toContain("Очередь и история");
    await f.callback(actors.owner, `lq:open:${lead.id}:W:0`);
    expect(buttons().some((b) => b.callback_data === `lq:done:${lead.id}:W:0`)).toBe(true);
    await f.callback(actors.owner, `lq:done:${lead.id}:W:0`);
    expect(text()).not.toContain("Очередь и история");
    await f.callback(actors.owner, "lq:list:D:0");
    expect(text()).toContain("Очередь и история");
    expect(await f.prisma.lead.count()).toBe(1);
    await f.callback(actors.owner, `lq:open:${lead.id}:D:0`);
    expect(buttons().every((b) => b.callback_data.startsWith("lq:list:"))).toBe(true);
    await f.callback(actors.owner, `lq:reject:${lead.id}:W:0`);
    expect((await f.prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe("DONE");
  });
  it("paginates beyond twenty records and clamps a stale last page after taking its only lead", async () => {
    for (let i = 0; i < 21; i++) await seed(`Клиент ${String(i).padStart(2, "0")}`);
    await f.message(actors.owner, "📋 Заявки/Записи");
    expect(buttons().filter((b) => b.callback_data.startsWith("lq:open:"))).toHaveLength(5);
    await f.callback(actors.owner, "lq:list:N:4");
    const last = buttons().find((b) => b.callback_data.startsWith("lq:open:"))!;
    expect(last).toBeDefined();
    expect(text()).toContain("Клиент 20");
    await f.callback(actors.owner, last.callback_data.replace("lq:open:", "lq:take:"));
    expect(buttons().filter((b) => b.callback_data.startsWith("lq:open:"))).toHaveLength(5);
    expect(buttons().some((b) => b.callback_data === "lq:list:N:3")).toBe(true);
    await f.callback(actors.owner, "lq:list:N:999999");
    expect(buttons().some((b) => b.callback_data === "lq:list:N:3")).toBe(true);
    expect(buttons().every((b) => Buffer.byteLength(b.callback_data) <= 64)).toBe(true);
  });
  it("allows only one assignee and prevents another staff member from completing the lead", async () => {
    const lead = await seed("Гонка");
    await f.prisma.botUser.create({
      data: { botId: f.bot.id, tgId: actors.other, isAdmin: true, role: "STAFF", lang: "RU" },
    });
    await Promise.all([
      f.callback(actors.staff, `lq:take:${lead.id}:N:0`),
      f.callback(actors.other, `lq:take:${lead.id}:N:0`),
    ]);
    const current = await f.prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(current.status).toBe("IN_PROGRESS");
    expect([BigInt(actors.staff), BigInt(actors.other)]).toContain(current.assigneeTgId);
    const loser = current.assigneeTgId === BigInt(actors.staff) ? actors.other : actors.staff;
    await f.callback(loser, `lq:done:${lead.id}:W:0`);
    expect((await f.prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe(
      "IN_PROGRESS",
    );
    await f.callback(actors.owner, `lq:reject:${lead.id}:W:0`);
    await f.callback(actors.owner, "lq:list:R:0");
    expect(text()).toContain("Гонка");
    expect((await f.prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe(
      "REJECTED",
    );
  });
  it("checks fresh rights and bot scope on list, card and action callbacks", async () => {
    const lead = await seed("Секретная заявка");
    for (const cb of ["lq:list:A:0", `lq:open:${lead.id}:N:0`, `lq:take:${lead.id}:N:0`])
      await f.callback(actors.client, cb);
    expect(f.transport.callsOf("sendMessage")).toHaveLength(0);
    expect(f.transport.callsOf("editMessageText")).toHaveLength(0);
    expect(f.transport.callsOf("answerCallbackQuery")).toHaveLength(3);
    expect(
      f.transport.callsOf("answerCallbackQuery").every((c) => c.payload.show_alert === true),
    ).toBe(true);
    await f.prisma.botUser.update({
      where: { botId_tgId: { botId: f.bot.id, tgId: BigInt(actors.owner) } },
      data: { isAdmin: false, role: null },
    });
    await f.callback(actors.owner, `lq:take:${lead.id}:N:0`);
    expect((await f.prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).status).toBe("NEW");
    const other = await f.prisma.bot.create({
      data: {
        tenantId: f.bot.tenantId,
        botType: "LEADCATCH",
        botTokenEnc: "unused",
        botTokenHash: "foreign-queue-bot",
        webhookSecret: "unused",
      },
    });
    const foreign = await f.prisma.lead.create({
      data: {
        botId: other.id,
        customerTgId: actors.client,
        customerName: "Чужой клиент",
        phoneRaw: "+998901234567",
        answers: {},
      },
    });
    await f.callback(actors.staff, `lq:open:${foreign.id}:N:0`);
    await f.callback(actors.staff, `lq:take:${foreign.id}:N:0`);
    expect((await f.prisma.lead.findUniqueOrThrow({ where: { id: foreign.id } })).status).toBe(
      "NEW",
    );
    expect(
      f.transport.calls.every((c) => !String(c.payload.text ?? "").includes("Чужой клиент")),
    ).toBe(true);
  });
  it("masks contacts in lists and cards and localizes Uzbek navigation", async () => {
    const lead = await seed("Имя клиента");
    await f.prisma.subscription.update({
      where: { botId: f.bot.id },
      data: { status: "EXPIRED", paidUntil: new Date(0) },
    });
    await f.prisma.botUser.update({
      where: { botId_tgId: { botId: f.bot.id, tgId: BigInt(actors.owner) } },
      data: { lang: "UZ" },
    });
    await f.setSession(actors.owner, { lang: "UZ" });
    await f.resolver.invalidate(f.bot.botTokenHash, f.bot.id);
    await f.message(actors.owner, "📋 Arizalar/Buyurtmalar");
    expect(buttons().some((b) => b.text.includes("Yangi"))).toBe(true);
    expect(text()).not.toContain("Имя клиента");
    expect(text()).not.toContain("+998901234567");
    await f.callback(actors.owner, `lq:open:${lead.id}:N:0`);
    expect(text()).not.toContain("+998901234567");
    expect(text()).not.toContain("queue_test_client");
    expect(buttons().some((b) => b.callback_data.startsWith("lq:take:"))).toBe(false);
  });
  it("splits long plain-text cards safely and keeps navigation on the final part", async () => {
    const lead = await seed("Клиент <>&");
    await f.prisma.lead.update({
      where: { id: lead.id },
      data: { answers: { long: { question: "Начало", answer: "😀".repeat(5000) + "Конец" } } },
    });
    await f.callback(actors.owner, `lq:open:${lead.id}:N:0`);
    const calls = f.transport.calls.filter(
      (c) => c.method === "sendMessage" || c.method === "editMessageText",
    );
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((c) => String(c.payload.text).length <= 4096)).toBe(true);
    expect(calls.map((c) => c.payload.text).join("")).toContain("Конец");
    expect(buttons().some((b) => b.callback_data === "lq:list:N:0")).toBe(true);
    expect(calls.every((c) => c.payload.parse_mode === undefined)).toBe(true);
  });
});
