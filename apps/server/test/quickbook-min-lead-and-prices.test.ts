import { describe, expect, it } from "vitest";
import { createEmptyQuickBookConfig, type QuickBookConfig } from "@lcqb/contracts";
import { buildApp } from "../src/index.js";
import {
  applyDueChanges,
  cancelPendingChange,
  loadEffectiveConfig,
  scheduleSettingChange,
  validateChangeValue,
} from "../src/bots/quickbook/setting-changes.js";
import { ensureInitialMinLead } from "../src/bots/quickbook/initial-min-lead.js";
import { findNextWorkingDate } from "../src/bots/quickbook/setting-schedule.js";
import { generateAvailableSlots } from "../src/bots/quickbook/slot-generator.js";
import { createBooking, cancelBooking } from "../src/bots/quickbook/booking-service.js";
import { rescheduleBooking } from "../src/bots/quickbook/reschedule-service.js";
import { saveWebQuickBookConfig } from "../src/bots/quickbook/web-config-save.js";
import { resolveInitialBotSettings } from "../src/admin-api/initial-bot-settings.js";
import { callbackId } from "../src/bots/shared/callback-id.js";
import { actors, readinessConfig, readinessFixture } from "./helpers/readiness-fixture.js";

describe("QuickBook: min lead time & service prices (Stages 2–10)", () => {
  it("Stage 2 & 8: enforces OWNER-only rights from DB, blocks STAFF/client/revoked/other-bot, and uses short single-use callbacks", async () => {
    const fx = await readinessFixture();
    try {
      const sentCount = () => fx.transport.callsOf("sendMessage").length;
      const lastText = () => String(fx.transport.callsOf("sendMessage").at(-1)?.payload.text ?? "");

      // Client and STAFF cannot open Settings or trigger limit callbacks
      const before = sentCount();
      await fx.message(actors.client, "⚙️ Настройки");
      await fx.message(actors.staff, "⚙️ Настройки");
      await fx.callback(actors.client, "lim:lead");
      await fx.callback(actors.staff, "lim:pr");
      expect(sentCount()).toBe(before);

      // OWNER opens Settings and sees buttons for min lead and service prices
      await fx.message(actors.owner, "⚙️ Настройки");
      expect(lastText()).toContain("Мин. время до онлайн-записи");
      const menuCbs =
        fx
          .buttons()
          ?.inline_keyboard.flat()
          .map((b) => b.callback_data) ?? [];
      expect(menuCbs).toEqual(expect.arrayContaining(["lim:lead", "lim:pr"]));
      for (const cb of menuCbs) {
        expect(Buffer.byteLength(cb, "utf8")).toBeLessThanOrEqual(64);
      }

      // OWNER starts price change flow: Settings -> Service prices -> Pick service -> Enter amount
      await fx.callback(actors.owner, "lim:pr");
      const srvCb = `lim:ps:${callbackId("haircut")}`;
      expect(Buffer.byteLength(srvCb, "utf8")).toBeLessThanOrEqual(64);
      await fx.callback(actors.owner, srvCb);
      expect(lastText()).toContain("Стрижка");
      expect(lastText()).toContain("50 000");

      // Invalid price inputs are rejected without saving
      await fx.message(actors.owner, "-100");
      expect(lastText()).toContain("неотрицательная");
      await fx.message(actors.owner, "abc");
      expect(lastText()).toContain("неотрицательная");

      // Leaving input via command or menu button does not save anything
      await fx.message(actors.owner, "/start");
      expect(await fx.prisma.botSettingChange.count({ where: { botId: fx.bot.id } })).toBe(0);

      // Start price input again, enter 0 UZS (free service compatibility) -> preview shown
      await fx.callback(actors.owner, srvCb);
      await fx.message(actors.owner, "0");
      expect(lastText()).toContain("Стрижка");
      expect(lastText()).toContain("Сейчас: 50 000 сум.");
      expect(lastText()).toContain("Новая цена: 0 сум.");
      const confirmCb = fx
        .buttons()
        ?.inline_keyboard.flat()
        .find((b) => b.callback_data.startsWith("lim:ok:"))?.callback_data;
      expect(confirmCb).toBeDefined();
      expect(Buffer.byteLength(confirmCb!, "utf8")).toBeLessThanOrEqual(64);

      // Revoking OWNER rights before clicking confirm blocks the confirmation
      await fx.prisma.botUser.update({
        where: { botId_tgId: { botId: fx.bot.id, tgId: BigInt(actors.owner) } },
        data: { role: "STAFF" },
      });
      await fx.callback(actors.owner, confirmCb!);
      expect(await fx.prisma.botSettingChange.count({ where: { botId: fx.bot.id } })).toBe(0);

      // Restore OWNER rights, preview 65000 UZS, confirm once, second tap on same token is stale
      await fx.prisma.botUser.update({
        where: { botId_tgId: { botId: fx.bot.id, tgId: BigInt(actors.owner) } },
        data: { role: "OWNER" },
      });
      await fx.callback(actors.owner, srvCb);
      await fx.message(actors.owner, "65000");
      const okCb = fx
        .buttons()!
        .inline_keyboard.flat()
        .find((b) => b.callback_data.startsWith("lim:ok:"))!.callback_data;
      await fx.callback(actors.owner, okCb);
      expect(lastText()).toContain("Сохранено");
      expect(await fx.prisma.botSettingChange.count({ where: { botId: fx.bot.id } })).toBe(1);

      // Repeated tap on the same confirm button does not create duplicate changes
      await fx.callback(actors.owner, okCb);
      expect(lastText()).toContain("устарели");
      expect(await fx.prisma.botSettingChange.count({ where: { botId: fx.bot.id } })).toBe(1);

      // Stale button for a deleted service is rejected
      await fx.callback(actors.owner, `lim:ps:${callbackId("non_existent_srv")}`);
      expect(lastText()).toContain("устарели");

      // Uzbek localization check
      await fx.setSession(actors.owner, { lang: "UZ" });
      await fx.callback(actors.owner, "lim:lead");
      expect(lastText()).toContain("minimal vaqtni tanlang");
      await fx.callback(actors.owner, "lim:ld:120");
      expect(lastText()).toContain("Yangi qiymat: 2 soat.");
    } finally {
      await fx.close();
    }
  });

  it("Stage 3, 4 & 5: validates min lead >= 60, computes next working day (weekends, full closures, month/year rollover), preserves promised date, and records history", async () => {
    const fx = await readinessFixture();
    try {
      // Stage 4: Value validation
      expect(validateChangeValue("MIN_LEAD", 60)).toBe(true);
      expect(validateChangeValue("MIN_LEAD", 120)).toBe(true);
      expect(validateChangeValue("MIN_LEAD", 59)).toBe(false);
      expect(validateChangeValue("MIN_LEAD", 0)).toBe(false);
      expect(validateChangeValue("MIN_LEAD", -60)).toBe(false);
      expect(validateChangeValue("MIN_LEAD", 60.5)).toBe(false);

      // New bots get 60 minutes by default
      expect(createEmptyQuickBookConfig().minLeadMinutes).toBe(60);
      const fromTemplate = resolveInitialBotSettings({
        botType: "QUICKBOOK",
        templateId: "barbershop_2masters",
      }) as Record<string, unknown>;
      expect(fromTemplate.minLeadMinutes).toBe(60);

      // Legacy bot without minLeadMinutes: ensureInitialMinLead schedules 60 min for next working day
      const nowFri = new Date("2026-10-30T10:00:00+05:00"); // Friday
      const count1 = await ensureInitialMinLead(fx.prisma, nowFri);
      expect(count1).toBe(1);
      // Repeated initialization is idempotent and does not reset or shift effectiveAt
      const count2 = await ensureInitialMinLead(fx.prisma, new Date("2026-10-31T10:00:00+05:00"));
      expect(count2).toBe(0);

      // Before effective date, legacy behaviour (no minLeadMinutes) still applies
      const cfgToday = await loadEffectiveConfig(fx.prisma, fx.bot.id, nowFri);
      expect(cfgToday?.minLeadMinutes).toBeUndefined();

      // Stage 5: Next working day calculation across weekends, closures, and year rollover
      const weekdayConfig: QuickBookConfig = {
        ...readinessConfig,
        minLeadMinutes: 60,
        services: [
          { id: "s1", name: { ru: "Стрижка", uz: "Soch" }, durationMin: 30, priceUzs: 50000 },
          { id: "s2", name: { ru: "Борода", uz: "Soqol" }, durationMin: 30, priceUzs: 40000 },
        ],
        resources: [
          {
            id: "m1",
            name: { ru: "Али", uz: "Ali" },
            serviceIds: ["s1"],
            workDays: [1, 2, 3, 4, 5], // Mon-Fri
            workHours: { start: "09:00", end: "18:00" },
          },
          {
            id: "m2",
            name: { ru: "Вали", uz: "Vali" },
            serviceIds: ["s2"],
            workDays: [6], // Saturday only
            workHours: { start: "10:00", end: "16:00" },
          },
        ],
      };

      // On Friday 2026-10-30:
      // - For s1 (served only by m1 who works Mon-Fri), Saturday & Sunday are off -> Monday 2026-11-02 (month rollover Oct -> Nov!)
      expect(findNextWorkingDate(weekdayConfig, "s1", [], nowFri)).toBe("2026-11-02");
      // - For s2 (served by m2 who works Sat), tomorrow Saturday 2026-10-31 is working
      expect(findNextWorkingDate(weekdayConfig, "s2", [], nowFri)).toBe("2026-10-31");
      // - If m2 is fully closed on Saturday 2026-10-31 by a TimeBlock, next working day for s2 becomes Saturday 2026-11-07
      const satClosure = [
        {
          resourceId: "m2",
          startsAt: new Date("2026-10-31T05:00:00.000Z"), // 10:00 Tashkent
          endsAt: new Date("2026-10-31T11:00:00.000Z"), // 16:00 Tashkent
        },
      ];
      expect(findNextWorkingDate(weekdayConfig, "s2", satClosure, nowFri)).toBe("2026-11-07");

      // Year rollover: 2026-12-31 (Thursday) -> 2027-01-01 (Friday)
      expect(
        findNextWorkingDate(weekdayConfig, "s1", [], new Date("2026-12-31T15:00:00+05:00")),
      ).toBe("2027-01-01");

      // Ordinary bookings filling the day do NOT turn a working day into a day off
      await fx.prisma.bot.update({
        where: { id: fx.bot.id },
        data: { settings: weekdayConfig },
      });
      await fx.prisma.booking.create({
        data: {
          botId: fx.bot.id,
          customerPhone: "+998901234567",
          serviceId: "s2",
          serviceName: "Борода",
          staffId: "m2",
          durationMin: 360,
          slotTime: new Date("2026-10-31T10:00:00+05:00"),
          endTime: new Date("2026-10-31T16:00:00+05:00"),
          status: "CONFIRMED",
        },
      });
      const s2Change = await scheduleSettingChange(fx.prisma, {
        botId: fx.bot.id,
        kind: "SERVICE_PRICE",
        targetId: "s2",
        newValue: 45000,
        author: { tgId: actors.owner },
        now: nowFri,
      });
      expect(s2Change.ok && !s2Change.unchanged && s2Change.plan.effectiveDate).toBe("2026-10-31");

      // Independent changes: scheduling s1 price and MIN_LEAD do not overwrite s2 price change
      const s1Change = await scheduleSettingChange(fx.prisma, {
        botId: fx.bot.id,
        kind: "SERVICE_PRICE",
        targetId: "s1",
        newValue: 60000,
        author: { tgId: actors.owner },
        now: nowFri,
      });
      expect(s1Change.ok && !s1Change.unchanged && s1Change.plan.effectiveDate).toBe("2026-11-02");
      const leadChange = await scheduleSettingChange(fx.prisma, {
        botId: fx.bot.id,
        kind: "MIN_LEAD",
        newValue: 90,
        author: { tgId: actors.owner },
        now: nowFri,
      });
      expect(leadChange.ok && !leadChange.unchanged).toBe(true);

      // Replacing a pending change marks the old row REPLACED and creates a new PENDING row
      const s1Replaced = await scheduleSettingChange(fx.prisma, {
        botId: fx.bot.id,
        kind: "SERVICE_PRICE",
        targetId: "s1",
        newValue: 70000,
        author: { tgId: actors.owner },
        now: nowFri,
      });
      expect(s1Replaced.ok && !s1Replaced.unchanged).toBe(true);
      const s1History = await fx.prisma.botSettingChange.findMany({
        where: { botId: fx.bot.id, kind: "SERVICE_PRICE", targetId: "s1" },
        orderBy: { createdAt: "asc" },
      });
      expect(s1History.map((h) => [h.status, h.newValue])).toEqual([
        ["REPLACED", 60000],
        ["PENDING", 70000],
      ]);

      // Cancelling a pending change marks it CANCELLED with author
      const cancelled = await cancelPendingChange(fx.prisma, {
        botId: fx.bot.id,
        changeId: s1History[1]!.id,
        author: { tgId: actors.owner },
        now: nowFri,
      });
      expect(cancelled).toBe(true);
      const afterCancel = await fx.prisma.botSettingChange.findUniqueOrThrow({
        where: { id: s1History[1]!.id },
      });
      expect(afterCancel.status).toBe("CANCELLED");
      expect(afterCancel.resolvedByTgId).toBe(BigInt(actors.owner));
    } finally {
      await fx.close();
    }
  });

  it("Stage 6: activates due changes without restart or after downtime, invalidates cache, overlays only changed fields, and drops removed services", async () => {
    const fx = await readinessFixture();
    try {
      const baseConfig: QuickBookConfig = {
        ...readinessConfig,
        minLeadMinutes: 60,
        services: [
          { id: "haircut", name: { ru: "Стрижка", uz: "Soch" }, durationMin: 30, priceUzs: 50000 },
          { id: "beard", name: { ru: "Борода", uz: "Soqol" }, durationMin: 30, priceUzs: 30000 },
        ],
      };
      await fx.prisma.bot.update({
        where: { id: fx.bot.id },
        data: { settings: baseConfig },
      });
      await fx.resolver.invalidate(fx.bot.botTokenHash, fx.bot.id);

      const day0 = new Date("2026-11-01T12:00:00+05:00");
      await scheduleSettingChange(fx.prisma, {
        botId: fx.bot.id,
        kind: "MIN_LEAD",
        newValue: 120,
        author: { tgId: actors.owner },
        now: day0,
      });
      await scheduleSettingChange(fx.prisma, {
        botId: fx.bot.id,
        kind: "SERVICE_PRICE",
        targetId: "haircut",
        newValue: 65000,
        author: { tgId: actors.owner },
        now: day0,
      });

      // Before 00:00 of 2026-11-02 (23:59:59 on 2026-11-01), old values remain active
      const beforeMidnight = new Date("2026-11-01T23:59:59+05:00");
      const cfgBefore = await loadEffectiveConfig(fx.prisma, fx.bot.id, beforeMidnight);
      expect(cfgBefore?.minLeadMinutes).toBe(60);
      expect(cfgBefore?.services.find((s) => s.id === "haircut")?.priceUzs).toBe(50000);

      // Web admin edits working hours and deletes 'beard' while 'beard' also had a pending price change
      await scheduleSettingChange(fx.prisma, {
        botId: fx.bot.id,
        kind: "SERVICE_PRICE",
        targetId: "beard",
        newValue: 40000,
        author: { tgId: actors.owner },
        now: day0,
      });
      const savedWeb = await saveWebQuickBookConfig(fx.prisma, {
        botId: fx.bot.id,
        incoming: {
          ...baseConfig,
          services: [baseConfig.services[0]!], // 'beard' removed!
          resources: [
            {
              ...baseConfig.resources[0]!,
              workHours: { start: "10:00", end: "22:00" },
            },
          ],
        },
        adminId: null,
        now: day0,
      });
      expect(savedWeb.ok).toBe(true);

      // Pending change for deleted 'beard' was automatically cancelled
      const beardChange = await fx.prisma.botSettingChange.findFirstOrThrow({
        where: { botId: fx.bot.id, targetId: "beard" },
      });
      expect(beardChange.status).toBe("CANCELLED");

      // At 00:00 of 2026-11-02, even BEFORE applyDueChanges runs (e.g. after server downtime),
      // loadEffectiveConfig immediately returns the new values AND preserves web admin's workHours!
      const atMidnight = new Date("2026-11-02T00:00:00+05:00");
      const cfgAtMidnight = await loadEffectiveConfig(fx.prisma, fx.bot.id, atMidnight);
      expect(cfgAtMidnight?.minLeadMinutes).toBe(120);
      expect(cfgAtMidnight?.services.find((s) => s.id === "haircut")?.priceUzs).toBe(65000);
      expect(cfgAtMidnight?.services.find((s) => s.id === "beard")).toBeUndefined();
      expect(cfgAtMidnight?.resources[0]?.workHours.start).toBe("10:00");

      // Concurrent applyDueChanges calls are safe and apply exactly once
      const [applied1, applied2] = await Promise.all([
        applyDueChanges(fx.prisma, {
          now: atMidnight,
          redis: fx.redis,
          tenantResolver: fx.resolver,
        }),
        applyDueChanges(fx.prisma, {
          now: atMidnight,
          redis: fx.redis,
          tenantResolver: fx.resolver,
        }),
      ]);
      expect(applied1 + applied2).toBe(2);
    } finally {
      await fx.close();
    }
  });

  it("Stage 7 & 9: enforces minLeadMinutes on slot grid, booking, and reschedule; bypasses for manual booking; locks agreed price on Booking and requires re-confirmation on price change", async () => {
    const fx = await readinessFixture();
    try {
      const cfg: QuickBookConfig = {
        ...readinessConfig,
        minLeadMinutes: 60,
        slotIntervalMin: 30,
        services: [
          { id: "haircut", name: { ru: "Стрижка", uz: "Soch" }, durationMin: 30, priceUzs: 50000 },
        ],
        resources: [
          {
            id: "master1",
            name: { ru: "Мастер", uz: "Usta" },
            workDays: [0, 1, 2, 3, 4, 5, 6],
            workHours: { start: "09:00", end: "20:00" },
          },
        ],
      };
      await fx.prisma.bot.update({
        where: { id: fx.bot.id },
        data: { settings: cfg },
      });

      // Grid test: now = 14:20 Tashkent, minLead = 60m, step = 30m -> first slot is 15:30!
      const now1420 = new Date("2026-11-02T14:20:00+05:00");
      const clientSlots = await generateAvailableSlots({
        botId: fx.bot.id,
        config: cfg,
        serviceId: "haircut",
        dateStr: "2026-11-02",
        prisma: fx.prisma,
        redis: fx.redis,
        now: now1420,
      });
      expect(clientSlots[0]?.timeLabel).toBe("15:30");

      // Owner manual booking (skipMinLead: true) can still use 14:30!
      const manualSlots = await generateAvailableSlots({
        botId: fx.bot.id,
        config: cfg,
        serviceId: "haircut",
        dateStr: "2026-11-02",
        prisma: fx.prisma,
        redis: fx.redis,
        now: now1420,
        skipMinLead: true,
      });
      expect(manualSlots[0]?.timeLabel).toBe("14:30");

      // Client attempting to book 15:00 at 14:20 is rejected with TOO_SOON and alternatives starting at 15:30
      const tooSoonBook = await createBooking({
        prisma: fx.prisma,
        redis: fx.redis,
        transport: fx.transport,
        logger: (await import("../src/core/logger.js")).logger,
        botId: fx.bot.id,
        customerTgId: actors.client,
        customerName: "Клиент",
        customerPhone: "+998901234567",
        serviceId: "haircut",
        staffId: "master1",
        slotTime: new Date("2026-11-02T15:00:00+05:00"),
        config: cfg,
        now: now1420,
      });
      expect(tooSoonBook.success).toBe(false);
      if (!tooSoonBook.success && "alternativeSlots" in tooSoonBook) {
        expect(tooSoonBook.error).toBe("TOO_SOON");
        expect(tooSoonBook.alternativeSlots[0]?.timeLabel).toBe("15:30");
      }

      // Manual booking by owner at 15:00 succeeds even though it's within 60 min
      const manualBook = await createBooking({
        prisma: fx.prisma,
        redis: fx.redis,
        transport: fx.transport,
        logger: (await import("../src/core/logger.js")).logger,
        botId: fx.bot.id,
        customerTgId: null,
        customerName: "Гость",
        customerPhone: "+998901112233",
        serviceId: "haircut",
        staffId: "master1",
        slotTime: new Date("2026-11-02T15:00:00+05:00"),
        config: cfg,
        now: now1420,
        source: "MANUAL",
        createdByTgId: actors.owner,
        expectedPriceUzs: 50000,
      });
      expect(manualBook.success).toBe(true);
      if (manualBook.success) {
        expect(manualBook.booking.priceUzs).toBe(50000);
      }

      // Stage 9: If price changed in DB while client/owner had summary open, createBooking returns PRICE_CHANGED
      await fx.prisma.bot.update({
        where: { id: fx.bot.id },
        data: {
          settings: {
            ...cfg,
            services: [{ ...cfg.services[0]!, priceUzs: 75000 }],
          },
        },
      });
      const stalePriceBook = await createBooking({
        prisma: fx.prisma,
        redis: fx.redis,
        transport: fx.transport,
        logger: (await import("../src/core/logger.js")).logger,
        botId: fx.bot.id,
        customerTgId: actors.client,
        customerName: "Клиент",
        customerPhone: "+998901234567",
        serviceId: "haircut",
        staffId: "master1",
        slotTime: new Date("2026-11-02T16:00:00+05:00"),
        config: cfg, // stale config with 50000 passed in!
        now: now1420,
        expectedPriceUzs: 50000,
      });
      expect(stalePriceBook).toEqual({
        success: false,
        error: "PRICE_CHANGED",
        priceUzs: 75000,
      });

      // Confirming with the new expectedPriceUzs (75000) succeeds and stores 75000 on Booking
      const confirmedBook = await createBooking({
        prisma: fx.prisma,
        redis: fx.redis,
        transport: fx.transport,
        logger: (await import("../src/core/logger.js")).logger,
        botId: fx.bot.id,
        customerTgId: actors.client,
        customerName: "Клиент",
        customerPhone: "+998901234567",
        serviceId: "haircut",
        staffId: "master1",
        slotTime: new Date("2026-11-02T16:00:00+05:00"),
        config: cfg,
        now: now1420,
        expectedPriceUzs: 75000,
      });
      expect(confirmedBook.success).toBe(true);
      const bookingId = confirmedBook.success ? confirmedBook.booking.id : "";

      // Now price changes to 90000 in DB:
      await fx.prisma.bot.update({
        where: { id: fx.bot.id },
        data: {
          settings: {
            ...cfg,
            services: [{ ...cfg.services[0]!, priceUzs: 90000 }],
          },
        },
      });

      // Failed reschedule into a TOO_SOON slot (14:30) keeps original booking at 16:00 and price 75000
      const badResched = await rescheduleBooking({
        prisma: fx.prisma,
        redis: fx.redis,
        transport: fx.transport,
        logger: (await import("../src/core/logger.js")).logger,
        botId: fx.bot.id,
        bookingId,
        newSlotTime: new Date("2026-11-02T14:30:00+05:00"),
        userId: actors.client,
        config: cfg,
        now: now1420,
      });
      expect(badResched).toEqual({ success: false, error: "TOO_SOON" });
      const untouched = await fx.prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
      expect(untouched.slotTime.toISOString()).toBe(
        new Date("2026-11-02T16:00:00+05:00").toISOString(),
      );
      expect(untouched.priceUzs).toBe(75000);

      // Valid reschedule to 17:00 preserves the agreed price (75000, NOT 90000)
      const okResched = await rescheduleBooking({
        prisma: fx.prisma,
        redis: fx.redis,
        transport: fx.transport,
        logger: (await import("../src/core/logger.js")).logger,
        botId: fx.bot.id,
        bookingId,
        newSlotTime: new Date("2026-11-02T17:00:00+05:00"),
        userId: actors.client,
        config: cfg,
        now: now1420,
      });
      expect(okResched.success).toBe(true);
      if (okResched.success) {
        expect(okResched.booking.priceUzs).toBe(75000);
      }

      // After cancelling and creating a new booking, the new booking uses the new active price (90000)
      await cancelBooking(fx.prisma, fx.redis, {
        bookingId,
        botId: fx.bot.id,
        userId: actors.client,
      });
      const rebooked = await createBooking({
        prisma: fx.prisma,
        redis: fx.redis,
        transport: fx.transport,
        logger: (await import("../src/core/logger.js")).logger,
        botId: fx.bot.id,
        customerTgId: actors.client,
        customerName: "Клиент",
        customerPhone: "+998901234567",
        serviceId: "haircut",
        staffId: "master1",
        slotTime: new Date("2026-11-02T17:00:00+05:00"),
        config: cfg,
        now: now1420,
      });
      expect(rebooked.success && rebooked.booking.priceUzs).toBe(90000);

      // Legacy booking created without priceUzs keeps NULL (never 0 or current price)
      const legacy = await fx.booking();
      expect(legacy.priceUzs).toBeNull();
    } finally {
      await fx.close();
    }
  });

  it("Stage 10: Web Admin API enforces minLeadMinutes >= 60, schedules delayed changes, exposes pendingChanges/settingsRevision, and rejects stale revisions without wiping Telegram changes", async () => {
    const fx = await readinessFixture();
    const app = await buildApp({
      prisma: fx.prisma,
      redis: fx.redis,
      transport: fx.transport,
      enableScheduler: false,
    });
    try {
      const token = app.jwt.sign({
        adminId: "00000000-0000-0000-0000-000000000001",
        email: "admin@example.com",
        tokenType: "access",
      });
      const headers = { authorization: `Bearer ${token}` };

      // 1. Reject minLeadMinutes < 60 via PUT /api/v1/bots/:id/settings
      const invalidRes = await app.inject({
        method: "PUT",
        url: `/api/v1/bots/${fx.bot.id}/settings`,
        headers,
        payload: { ...readinessConfig, minLeadMinutes: 30 },
      });
      expect(invalidRes.statusCode).toBe(400);

      // 2. Telegram owner schedules a price change (50000 -> 60000)
      await scheduleSettingChange(fx.prisma, {
        botId: fx.bot.id,
        kind: "SERVICE_PRICE",
        targetId: "haircut",
        newValue: 60000,
        author: { tgId: actors.owner },
      });

      // 3. GET /api/v1/bots/:id returns pendingChanges and settingsRevision
      const getRes1 = await app.inject({
        method: "GET",
        url: `/api/v1/bots/${fx.bot.id}`,
        headers,
      });
      expect(getRes1.statusCode).toBe(200);
      const botView1 = getRes1.json().bot;
      expect(botView1.pendingChanges).toHaveLength(1);
      expect(botView1.pendingChanges[0].newValue).toBe(60000);
      const rev1: string = botView1.settingsRevision;
      expect(rev1).toBeTruthy();

      // 4. Saving full JSON with unchanged priceUzs (50000) and new workHours does NOT wipe Telegram's pending price change!
      const putRes = await app.inject({
        method: "PUT",
        url: `/api/v1/bots/${fx.bot.id}/settings?revision=${rev1}`,
        headers,
        payload: {
          ...readinessConfig,
          minLeadMinutes: 120,
          resources: [
            {
              ...readinessConfig.resources[0]!,
              workHours: { start: "08:00", end: "20:00" },
            },
          ],
        },
      });
      expect(putRes.statusCode).toBe(200);
      const putBody = putRes.json();
      expect(putBody.pendingChanges).toHaveLength(2); // both SERVICE_PRICE (60000) and MIN_LEAD (120)!

      // 5. Re-using the old revision token (rev1) now returns 409 STALE_SETTINGS
      const staleRes = await app.inject({
        method: "PUT",
        url: `/api/v1/bots/${fx.bot.id}/settings?revision=${rev1}`,
        headers,
        payload: readinessConfig,
      });
      expect(staleRes.statusCode).toBe(409);
      expect(staleRes.json().error).toBe("STALE_SETTINGS");
    } finally {
      await app.close();
      await fx.close();
    }
  });
});
