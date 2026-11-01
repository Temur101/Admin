import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { actors, readinessConfig, readinessFixture } from "./helpers/readiness-fixture.js";
import {
  applyDueChanges,
  cancelPendingChange,
  loadEffectiveConfig,
  scheduleSettingChange,
} from "../src/bots/quickbook/setting-changes.js";
import { ensureInitialMinLead } from "../src/bots/quickbook/initial-min-lead.js";

let f: Awaited<ReturnType<typeof readinessFixture>>;
const before = new Date("2026-11-01T12:00:00+05:00");
const after = new Date("2026-11-02T00:00:01+05:00");
beforeEach(async () => {
  f = await readinessFixture();
});
afterEach(async () => {
  await f?.close();
});

async function change(value = 120) {
  const res = await scheduleSettingChange(f.prisma, {
    botId: f.bot.id,
    kind: "MIN_LEAD",
    newValue: value,
    author: { tgId: actors.owner },
    now: before,
  });
  if (!res.ok || res.unchanged) throw new Error("Fixture change was not scheduled");
  return res.change;
}

describe("QuickBook setting cancellation", () => {
  it("does not undo an effective value before its worker has run", async () => {
    await f.prisma.bot.update({
      where: { id: f.bot.id },
      data: { settings: { ...readinessConfig, minLeadMinutes: 60 } },
    });
    const pending = await change();
    expect((await loadEffectiveConfig(f.prisma, f.bot.id, after))?.minLeadMinutes).toBe(120);
    expect(
      await cancelPendingChange(f.prisma, {
        botId: f.bot.id,
        changeId: pending.id,
        author: { tgId: actors.owner },
        now: after,
      }),
    ).toBe(false);
    expect((await loadEffectiveConfig(f.prisma, f.bot.id, after))?.minLeadMinutes).toBe(120);
    expect(
      (await f.prisma.botSettingChange.findUniqueOrThrow({ where: { id: pending.id } })).status,
    ).toBe("APPLIED");
  });

  it("preserves the initial mandatory hour when its cancellation is attempted", async () => {
    await ensureInitialMinLead(f.prisma, before);
    const initial = await f.prisma.botSettingChange.findFirstOrThrow();
    expect(
      await cancelPendingChange(f.prisma, {
        botId: f.bot.id,
        changeId: initial.id,
        author: { tgId: actors.owner },
        now: before,
      }),
    ).toBe(false);
    await ensureInitialMinLead(f.prisma, before);
    expect((await loadEffectiveConfig(f.prisma, f.bot.id, after))?.minLeadMinutes).toBe(60);
  });

  it("returns to the mandatory hour on the same promised date when a legacy bot cancels a higher limit", async () => {
    const pending = await change();
    expect(
      await cancelPendingChange(f.prisma, {
        botId: f.bot.id,
        changeId: pending.id,
        author: { tgId: actors.owner },
        now: before,
      }),
    ).toBe(true);
    const baseline = await f.prisma.botSettingChange.findFirstOrThrow({
      where: { status: "PENDING" },
    });
    expect(baseline.newValue).toBe(60);
    expect(baseline.effectiveAt).toEqual(pending.effectiveAt);
    expect((await loadEffectiveConfig(f.prisma, f.bot.id, before))?.minLeadMinutes).toBeUndefined();
    expect((await loadEffectiveConfig(f.prisma, f.bot.id, after))?.minLeadMinutes).toBe(60);
  });

  it("repairs legacy cancelled activation history without moving an existing pending date", async () => {
    const initial = await change(60);
    await f.prisma.botSettingChange.update({
      where: { id: initial.id },
      data: { status: "CANCELLED" },
    });
    expect(await ensureInitialMinLead(f.prisma, before)).toBe(1);
    expect(await ensureInitialMinLead(f.prisma, after)).toBe(0);
    expect((await loadEffectiveConfig(f.prisma, f.bot.id, after))?.minLeadMinutes).toBe(60);
  });

  it("serializes cancellation with activation and keeps another bot's changes inaccessible", async () => {
    await f.prisma.bot.update({
      where: { id: f.bot.id },
      data: { settings: { ...readinessConfig, minLeadMinutes: 60 } },
    });
    const pending = await change();
    await Promise.all([
      applyDueChanges(f.prisma, { now: after }),
      cancelPendingChange(f.prisma, {
        botId: f.bot.id,
        changeId: pending.id,
        author: { tgId: actors.owner },
        now: after,
      }),
    ]);
    expect((await loadEffectiveConfig(f.prisma, f.bot.id, after))?.minLeadMinutes).toBe(120);
    expect(
      await cancelPendingChange(f.prisma, {
        botId: "00000000-0000-0000-0000-000000000001",
        changeId: pending.id,
        author: { tgId: actors.owner },
        now: before,
      }),
    ).toBe(false);
  });
});
