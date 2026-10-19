import { beforeEach, describe, expect, it, vi } from "vitest";
import { Bot } from "grammy";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { createEmptyQuickBookConfig } from "@lcqb/contracts";
import type { PlatformBotContext, PlatformBotSession, ResolvedBot } from "../src/gateway/types.js";
import { MockTelegramTransport } from "../src/adapters/telegram/mock-transport.js";
import { maintenanceMiddleware } from "../src/bots/shared/maintenance.js";
vi.mock("../src/core/env.js", () => ({
  env: { TARIFF_1M_UZS: 100000, TARIFF_6M_UZS: 500000, TARIFF_12M_UZS: 1000000 },
}));
let bot: Bot<PlatformBotContext>;
let state: PlatformBotSession;
let transport: MockTelegramTransport;
let enabled: boolean;
let user: { isAdmin: boolean; lang: "RU" | "UZ" } | null;
const next = vi.fn();
const lookup = vi.fn();
const release = vi.fn();
let update = 0;
beforeEach(async () => {
  vi.clearAllMocks();
  enabled = true;
  user = { isAdmin: false, lang: "RU" };
  state = {
    lang: "RU",
    quiz: { currentNodeId: "q1", answers: {}, startedAt: Date.now(), stepCount: 1 },
  };
  lookup.mockImplementation(async () => ({ maintenanceMode: enabled }));
  release.mockResolvedValue(1);
  const prisma = {
    platformSettings: { findUnique: lookup },
    botUser: { findUnique: vi.fn(async () => user) },
  } as unknown as PrismaClient;
  transport = new MockTelegramTransport();
  bot = new Bot<PlatformBotContext>("123456:maintenance-test-token");
  bot.api.config.use(transport.transformerFor("b1"));
  bot.use((ctx, proceed) => {
    ctx.session = state;
    ctx.botMeta = {
      id: "b1",
      botType: "QUICKBOOK",
      settings: createEmptyQuickBookConfig(),
    } as unknown as ResolvedBot;
    return proceed();
  });
  bot.use(
    maintenanceMiddleware(prisma, { eval: release } as unknown as Redis, pino({ level: "silent" })),
  );
  bot.use(async () => {
    next();
  });
  await bot.init();
});
const message = () =>
  bot.handleUpdate({
    update_id: ++update,
    message: {
      message_id: update,
      date: 1,
      from: { id: 42, is_bot: false, first_name: "Клиент" },
      chat: { id: 42, type: "private", first_name: "Клиент" },
      text: "/start",
    },
  });
const click = (data: string) =>
  bot.handleUpdate({
    update_id: ++update,
    callback_query: {
      id: String(update),
      from: { id: 42, is_bot: false, first_name: "Клиент" },
      chat_instance: "test",
      data,
    },
  });
const hold = () => {
  state.quickbook = {
    serviceId: "s",
    resourceId: "r",
    slotTimeIso: "2026-10-20T05:00:00Z",
    lockToken: "token",
    lockDurationMin: 90,
    lockIntervalMin: 30,
  };
};
describe("Режим обслуживания до обработчиков диалогов", () => {
  it("блокирует сообщения клиента, сохраняя незаконченный опрос", async () => {
    const saved = structuredClone(state.quiz);
    await message();
    expect(next).not.toHaveBeenCalled();
    expect(state.quiz).toEqual(saved);
    expect(transport.callsOf("sendMessage").at(-1)!.payload.text).toContain("технические работы");
  });
  it("отвечает на callback, не пропуская старую кнопку", async () => {
    await click("lc:ans:old:q1:o1");
    expect(next).not.toHaveBeenCalled();
    expect(transport.callsOf("answerCallbackQuery").at(-1)!.payload.show_alert).toBe(true);
  });
  it("при истёкшем callback сообщает о перерыве обычным сообщением", async () => {
    bot.api.config.use(async (previous, method, payload, signal) => {
      if (method === "answerCallbackQuery") throw new Error("Query is too old");
      return previous(method, payload, signal);
    });
    await click("lc:ans:old:q1:o1");
    expect(transport.callsOf("sendMessage").at(-1)!.payload.text).toContain("технические работы");
    expect(next).not.toHaveBeenCalled();
  });
  it("выключение действует на следующее сообщение без перезапуска", async () => {
    await message();
    enabled = false;
    await message();
    expect(next).toHaveBeenCalledOnce();
    expect(lookup).toHaveBeenCalledTimes(2);
  });
  it("отсутствие строки настройки означает обычный режим", async () => {
    lookup.mockResolvedValueOnce(null);
    await message();
    expect(next).toHaveBeenCalledOnce();
  });
  it("владелец сохраняет доступ к управлению", async () => {
    user!.isAdmin = true;
    await message();
    expect(next).toHaveBeenCalledOnce();
  });
  it("флаг владельца в Redis не позволяет обойти проверку роли", async () => {
    state.isAdmin = true;
    await message();
    expect(next).not.toHaveBeenCalled();
    expect(state.isAdmin).toBe(false);
  });
  it.each(["book:confirm:booking", "book:cancel:booking"])(
    "пропускает %s для проверки прав обычным обработчиком",
    async (data) => {
      await click(data);
      expect(next).toHaveBeenCalledOnce();
    },
  );
  it("локализует сообщение по сохранённому языку пользователя", async () => {
    user!.lang = "UZ";
    await message();
    expect(transport.callsOf("sendMessage").at(-1)!.payload.text).toContain("texnik ishlar");
  });
  it("освобождает все интервалы удержания, сохраняя ответы опроса", async () => {
    hold();
    const saved = structuredClone(state.quiz);
    await message();
    expect(release).toHaveBeenCalledOnce();
    expect(release.mock.calls[0]![1]).toBe(3);
    expect(release.mock.calls[0]).toContain("token");
    expect(state.quickbook).toBeUndefined();
    expect(state.quiz).toEqual(saved);
    expect(next).not.toHaveBeenCalled();
  });
  it("ошибка освобождения удержания не запускает сценарий и сохраняет состояние", async () => {
    hold();
    const saved = structuredClone(state.quickbook);
    release.mockRejectedValueOnce(new Error("Redis unavailable"));
    await message();
    expect(state.quickbook).toEqual(saved);
    expect(next).not.toHaveBeenCalled();
  });
  it("ошибка чтения режима не пропускает бизнес-операции", async () => {
    lookup.mockRejectedValueOnce(new Error("DB unavailable"));
    await expect(message()).rejects.toThrow("DB unavailable");
    expect(next).not.toHaveBeenCalled();
  });
});
