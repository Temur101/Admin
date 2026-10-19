import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Bot } from "grammy";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { createEmptyQuickBookConfig, type QuickBookConfig } from "@lcqb/contracts";
import { MockTelegramTransport } from "../src/adapters/telegram/mock-transport.js";
import type { PlatformBotContext, PlatformBotSession, ResolvedBot } from "../src/gateway/types.js";
import { registerBookingSelectionHandlers } from "../src/bots/quickbook/booking-selection.js";
import {
  startQuickBookFlow,
  renderAlternativeSlots,
} from "../src/bots/quickbook/quickbook-handlers.js";
import { callbackId, resolveCallbackId } from "../src/bots/shared/callback-id.js";
import type { TimeSlot } from "../src/bots/quickbook/slot-generator.js";
let bot: Bot<PlatformBotContext>;
let context: PlatformBotContext;
let transport: MockTelegramTransport;
let state: PlatformBotSession;
let config: QuickBookConfig;
let prisma: PrismaClient;
const lock = vi.fn();
const release = vi.fn();
const sender = { id: 42, is_bot: false, first_name: "Клиент" };
let update = 0;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T03:00:00Z"));
  state = { lang: "RU" };
  transport = new MockTelegramTransport();
  config = {
    ...createEmptyQuickBookConfig(),
    services: [
      {
        id: randomUUID(),
        name: { ru: "Консультация", uz: "Maslahat" },
        durationMin: 30,
        priceUzs: 0,
      },
    ],
    resources: [
      {
        id: randomUUID(),
        name: { ru: "Врач", uz: "Shifokor" },
        workDays: [0, 1, 2, 3, 4, 5, 6],
        workHours: { start: "09:00", end: "18:00" },
      },
    ],
  };
  prisma = { booking: { findMany: vi.fn(async () => []) } } as unknown as PrismaClient;
  lock.mockResolvedValue("OK");
  release.mockResolvedValue(1);
  const redis = {
    mget: vi.fn(async () => [null]),
    exists: vi.fn(async () => 0),
    get: vi.fn(async () => null),
    set: lock,
    eval: release,
  } as unknown as Redis;
  bot = new Bot<PlatformBotContext>("123456:booking-callback-test-token");
  bot.api.config.use(transport.transformerFor("b1"));
  bot.use((ctx, next) => {
    ctx.session = state;
    ctx.botMeta = { id: "b1", settings: config } as unknown as ResolvedBot;
    context = ctx;
    return next();
  });
  registerBookingSelectionHandlers(bot, {
    prisma,
    redis,
    transport,
    logger: pino({ level: "silent" }),
  });
  await bot.init();
  await bot.handleUpdate({
    update_id: ++update,
    message: {
      message_id: 1,
      date: 1,
      from: sender,
      chat: { id: 42, type: "private", first_name: "Клиент" },
      text: "init",
    },
  });
  await startQuickBookFlow(context, prisma);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
function buttons() {
  const markup = transport.callsOf("sendMessage").at(-1)?.payload.reply_markup as {
    inline_keyboard: { text: string; callback_data: string }[][];
  };
  return markup.inline_keyboard.flat();
}
function validButtons() {
  const all = buttons();
  expect(all.length).toBeGreaterThan(0);
  for (const button of all) expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
  return all;
}
const click = (data: string) =>
  bot.handleUpdate({
    update_id: ++update,
    callback_query: {
      id: `cb-${update}`,
      from: sender,
      chat_instance: "local",
      data,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: 42, type: "private", first_name: "Клиент" },
        text: "Выбор записи",
      },
    },
  });
describe("Короткие кнопки записи", () => {
  it("проходит выбор услуги, UUID ресурса, даты и времени, сохраняя реальные идентификаторы", async () => {
    await click(validButtons()[0]!.callback_data);
    const resource = validButtons().find((button) => button.text === "Врач")!;
    await click(resource.callback_data);
    const date = validButtons()[0]!.callback_data;
    await click(date);
    const time = validButtons()[0]!.callback_data;
    await click(time);
    expect(state.quickbook?.serviceId).toBe(config.services[0]!.id);
    expect(state.quickbook?.resourceId).toBe(config.resources[0]!.id);
    expect(state.quickbook?.lockToken).toBeTruthy();
    expect(lock).toHaveBeenCalledOnce();
  });
  it("повтор времени восстанавливает запрос телефона без повторного захвата", async () => {
    for (let index = 0; index < 3; index++) await click(validButtons()[0]!.callback_data);
    const slot = validButtons()[0]!.callback_data;
    await click(slot);
    const saved = structuredClone(state.quickbook);
    await click(slot);
    expect(state.quickbook).toEqual(saved);
    expect(lock).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(state.quickbook?.lockDurationMin).toBe(config.services[0]!.durationMin);
    expect(state.quickbook?.lockIntervalMin).toBe(config.slotIntervalMin);
  });
  it("возврат к услуге освобождает выбранное время, ошибка освобождения сохраняет выбор", async () => {
    for (let index = 0; index < 4; index++) await click(validButtons()[0]!.callback_data);
    const saved = structuredClone(state.quickbook);
    const service = `qb:srv:${callbackId(config.services[0]!.id)}`;
    release.mockRejectedValueOnce(new Error("Redis unavailable"));
    await click(service);
    expect(state.quickbook).toEqual(saved);
    await click(service);
    expect(state.quickbook).toEqual({ serviceId: config.services[0]!.id });
    expect(release.mock.calls.at(-1)).toContain(saved!.lockToken);
  });
  it("поддерживает выбор любого ресурса с короткими кнопками", async () => {
    await click(validButtons()[0]!.callback_data);
    await click(validButtons()[0]!.callback_data);
    await click(validButtons()[0]!.callback_data);
    await click(validButtons()[0]!.callback_data);
    expect(state.quickbook?.resourceId).toBe(config.resources[0]!.id);
    expect(lock).toHaveBeenCalledOnce();
  });
  it("альтернативные слоты тоже укладываются в лимит Telegram", async () => {
    const slot = {
      staffId: config.resources[0]!.id,
      staffName: "Врач",
      timeLabel: "10:00",
      slotTime: new Date("2026-10-17T05:00:00Z"),
      slotTimeIso: "2026-10-17T05:00:00.000Z",
      durationMin: 30,
    } satisfies TimeSlot;
    await renderAlternativeSlots(context, [slot], config.services[0]!.id, slot.staffId);
    validButtons();
    await click(buttons()[0]!.callback_data);
    expect(state.quickbook?.serviceId).toBe(config.services[0]!.id);
    expect(state.quickbook?.resourceId).toBe(slot.staffId);
  });
  it("понимает ранее отправленные короткие идентификаторы", async () => {
    config.services[0]!.id = "service";
    config.resources[0]!.id = "staff";
    await click("qb:srv:service");
    expect(state.quickbook?.serviceId).toBe("service");
    expect(buttons().some((button) => button.text === "Врач")).toBe(true);
  });
  it("удалённая услуга не создаёт сессию с чужим идентификатором", async () => {
    const old = buttons()[0]!.callback_data;
    config.services = [];
    await click(old);
    expect(state.quickbook).toEqual({});
    expect(String(transport.callsOf("sendMessage").at(-1)?.payload.text)).toContain(
      "больше недоступен",
    );
    expect(lock).not.toHaveBeenCalled();
  });
  it("не захватывает время из несуществующего ресурса или некорректной даты", async () => {
    await click(`qb:slot:${callbackId(config.services[0]!.id)}:missing:2026-10-17T05:00:00.000Z`);
    await click(
      `qb:slot:${callbackId(config.services[0]!.id)}:${callbackId(config.resources[0]!.id)}:invalid`,
    );
    expect(lock).not.toHaveBeenCalled();
  });
  it("длинные ID с разделителями разрешаются без потери исходного значения", async () => {
    config.services[0]!.id = "услуга:".repeat(100);
    config.resources[0]!.id = "ресурс:".repeat(100);
    await startQuickBookFlow(context, prisma);
    await click(validButtons()[0]!.callback_data);
    const data = validButtons().find((button) => button.text === "Врач")!.callback_data;
    await click(data);
    validButtons();
    expect(state.quickbook?.resourceId).toBe(config.resources[0]!.id);
  });
  it.each([1, 7, 14, 60])(
    "показывает все %i разрешённых дат с переходами между страницами",
    async (horizon) => {
      config.bookingHorizonDays = horizon;
      await click(`qb:res:${callbackId(config.services[0]!.id)}:any`);
      const dates: string[] = [];
      for (let page = 0; page < Math.ceil(horizon / 7); page++) {
        const all = validButtons();
        dates.push(
          ...all
            .filter((button) => button.callback_data.startsWith("qb:date:"))
            .map((button) => button.callback_data.slice(-10)),
        );
        const next = all.find(
          (button) =>
            button.callback_data.startsWith("qb:days:") &&
            button.callback_data.endsWith(`:${page + 1}`),
        );
        if (page + 1 < Math.ceil(horizon / 7)) {
          expect(next).toBeDefined();
          await click(next!.callback_data);
        } else expect(next).toBeUndefined();
      }
      expect(new Set(dates).size).toBe(horizon);
      expect(dates[0]).toBe("2026-10-16");
      expect(dates.at(-1)).toBe(
        new Date(Date.UTC(2026, 9, 16 + horizon - 1)).toISOString().slice(0, 10),
      );
    },
  );
  it("локализует даты и возвращается на предыдущую страницу", async () => {
    state.lang = "UZ";
    await click(`qb:res:${callbackId(config.services[0]!.id)}:any`);
    expect(buttons()[0]!.text).toContain("Bugun");
    expect(buttons()[1]!.text).toContain("Ertaga");
    const first = buttons()[0]!.callback_data;
    await click(buttons().find((button) => button.text === "Keyingi →")!.callback_data);
    await click(buttons().find((button) => button.text === "← Oldingi")!.callback_data);
    expect(buttons()[0]!.callback_data).toBe(first);
  });
  it("не обрабатывает поддельную или устаревшую дату и страницу за горизонтом", async () => {
    config.bookingHorizonDays = 1;
    const ids = `${callbackId(config.services[0]!.id)}:any`;
    const saved = structuredClone(state.quickbook);
    await click(`qb:date:${ids}:2026-10-17`);
    await click(`qb:date:${ids}:2026-10-15`);
    await click(`qb:days:${ids}:1`);
    expect(state.quickbook).toEqual(saved);
    expect(prisma.booking.findMany).not.toHaveBeenCalled();
    expect(lock).not.toHaveBeenCalled();
  });
  it("неизвестный токен не интерпретируется как первый элемент списка", () => {
    expect(resolveCallbackId(config.services, "invalid")).toBeUndefined();
  });
});
