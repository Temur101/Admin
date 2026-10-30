import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actors, readinessFixture } from "./helpers/readiness-fixture.js";
let f: Awaited<ReturnType<typeof readinessFixture>>;
beforeEach(async () => {
  f = await readinessFixture();
});
afterEach(async () => {
  await f?.close();
});
describe("Readiness stage 4: safe Telegram output", () => {
  it.each(["RU", "UZ"] as const)("escapes customer HTML in the admin list (%s)", async (lang) => {
    await f.setSession(actors.owner, { lang });
    const b = await f.booking();
    await f.prisma.booking.update({
      where: { id: b.id },
      data: { customerName: "<unsupported>& клиент" },
    });
    await f.message(actors.owner, "📅 Записи");
    const output = f.transport.callsOf("sendMessage").at(-1)!.payload;
    expect(String(output.text)).not.toContain("<unsupported>");
    expect(String(output.text)).toContain("&lt;unsupported&gt;&amp;");
  });
  it.each(["EXPIRED", "GRACE_PERIOD", "BLOCKED"] as const)(
    "masks contacts for %s",
    async (status) => {
      await f.booking();
      await f.prisma.subscription.update({ where: { botId: f.bot.id }, data: { status } });
      await f.resolver.invalidate(f.bot.botTokenHash, f.bot.id);
      await f.message(actors.owner, "📅 Записи");
      expect(
        f.transport
          .callsOf("sendMessage")
          .map((x) => x.payload.text)
          .join("\n"),
      ).not.toContain("+998901234567");
    },
  );
  it("splits a full list into valid messages", async () => {
    await f.prisma.booking.createMany({
      data: Array.from({ length: 50 }, (_, i) => ({
        botId: f.bot.id,
        customerName: "Достаточно длинное имя тестового клиента",
        customerPhone: "+998901234567",
        staffId: "master1",
        serviceId: "haircut",
        serviceName: "Стрижка",
        durationMin: 30,
        slotTime: new Date(f.slot().getTime() + i * 1800000),
        status: "CONFIRMED" as const,
      })),
    });
    await f.message(actors.owner, "📅 Записи");
    const messages = f.transport.callsOf("sendMessage");
    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages) expect(String(m.payload.text).length).toBeLessThanOrEqual(4096);
    expect(messages.map((m) => m.payload.text).join("\n")).toContain("50.");
  });
});
