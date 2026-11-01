import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readinessConfig, readinessFixture } from "./helpers/readiness-fixture.js";
import { loadEffectiveConfig } from "../src/bots/quickbook/setting-changes.js";
import {
  quickBookSettingsView,
  saveWebQuickBookConfig,
  settingsRevision,
} from "../src/bots/quickbook/web-config-save.js";
let f: Awaited<ReturnType<typeof readinessFixture>>;
beforeEach(async () => {
  f = await readinessFixture();
});
afterEach(async () => {
  await f?.close();
});
const now = new Date("2026-11-01T12:00:00+05:00");
describe("QuickBook complete form revisions", () => {
  it("rejects a stale full form after working hours change", async () => {
    const view = await quickBookSettingsView(f.prisma, f.bot.id, now);
    const first = await saveWebQuickBookConfig(f.prisma, {
      botId: f.bot.id,
      incoming: {
        ...readinessConfig,
        resources: [
          { ...readinessConfig.resources[0]!, workHours: { start: "10:00", end: "18:00" } },
        ],
      },
      adminId: null,
      revision: view.settingsRevision,
      now,
    });
    expect(first.ok).toBe(true);
    const stale = await saveWebQuickBookConfig(f.prisma, {
      botId: f.bot.id,
      incoming: { ...readinessConfig, slotIntervalMin: 60 },
      adminId: null,
      revision: view.settingsRevision,
      now,
    });
    expect(stale).toEqual({ ok: false, error: "STALE_SETTINGS" });
    expect((await loadEffectiveConfig(f.prisma, f.bot.id, now))?.resources[0]?.workHours).toEqual({
      start: "10:00",
      end: "18:00",
    });
  });
  it("requires a baseline revision and leaves data unchanged when it is absent", async () => {
    const result = await saveWebQuickBookConfig(f.prisma, {
      botId: f.bot.id,
      incoming: { ...readinessConfig, slotIntervalMin: 60 },
      adminId: null,
      now,
    });
    expect(result).toEqual({ ok: false, error: "STALE_SETTINGS" });
    expect((await loadEffectiveConfig(f.prisma, f.bot.id, now))?.slotIntervalMin).toBe(30);
  });
  it("uses a stable fingerprint for equivalent JSON key ordering", () => {
    const reordered = {
      ...readinessConfig,
      services: readinessConfig.services.map((s) => ({
        priceUzs: s.priceUzs,
        durationMin: s.durationMin,
        name: { uz: s.name.uz, ru: s.name.ru },
        id: s.id,
      })),
    };
    expect(settingsRevision(reordered, [])).toBe(settingsRevision(readinessConfig, []));
    expect(settingsRevision({ ...readinessConfig, bookingHorizonDays: 7 }, [])).not.toBe(
      settingsRevision(readinessConfig, []),
    );
  });
});
