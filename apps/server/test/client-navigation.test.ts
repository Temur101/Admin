import { beforeEach, describe, expect, it, vi } from "vitest";
import { Bot } from "grammy";
import { pino } from "pino";
import type { BotUser, PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { createQuizChain } from "@lcqb/contracts/validation";
import { createEmptyQuickBookConfig } from "@lcqb/contracts";
import { MockTelegramTransport } from "../src/adapters/telegram/mock-transport.js";
import type { PlatformBotContext, PlatformBotSession, ResolvedBot } from "../src/gateway/types.js";
import { registerSharedBotHandlers } from "../src/bots/shared/handlers.js";
import { registerNavigationFallback } from "../src/bots/shared/navigation-handlers.js";
import { registerLeadCatchBot, startLeadCatchQuiz } from "../src/bots/leadcatch/index.js";
import { registerQuickBookBot } from "../src/bots/quickbook/index.js";
import { startQuickBookFlow } from "../src/bots/quickbook/quickbook-handlers.js";
import { getSlotLockKeys } from "../src/bots/quickbook/slot-lock.js";
import { t } from "../src/bots/shared/i18n.js";
import { createBooking } from "../src/bots/quickbook/booking-service.js";
vi.mock("../src/bots/quickbook/booking-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/bots/quickbook/booking-service.js")>()),
  createBooking: vi.fn(),
}));
vi.mock("../src/core/env.js", () => ({
  env: {
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
    TARIFF_1M_UZS: 100000,
    TARIFF_6M_UZS: 500000,
    TARIFF_12M_UZS: 1000000,
  },
}));
vi.mock("../src/bots/shared/notification.js", () => ({ notifyAdmins: vi.fn(async () => 1) }));
let bot: Bot<PlatformBotContext>;
let state: PlatformBotSession;
let transport: MockTelegramTransport;
let user: BotUser;
let meta: ResolvedBot;
let prisma: PrismaClient;
let redis: Redis;
let locks: Map<string, string>;
const saveLead = vi.fn();
const updateUser = vi.fn();
const release = vi.fn();
const sender = { id: 42, is_bot: false, first_name: "Клиент" };
let updateId = 0;
const config = () => ({
  ...createEmptyQuickBookConfig(),
  services: [
    { id: "service", name: { ru: "Консультация", uz: "Maslahat" }, durationMin: 90, priceUzs: 0 },
  ],
  resources: [
    {
      id: "staff",
      name: { ru: "Врач", uz: "Shifokor" },
      workDays: [0, 1, 2, 3, 4, 5, 6],
      workHours: { start: "09:00", end: "18:00" },
    },
  ],
});
beforeEach(async () => {
  vi.clearAllMocks();
  state = {};
  locks = new Map();
  user = {
    id: "u1",
    botId: "b1",
    tgId: 42n,
    lang: "RU",
    isAdmin: false,
    firstName: "Клиент",
    username: null,
    createdAt: new Date(),
  };
  meta = {
    id: "b1",
    tenantId: "tenant",
    botTokenEnc: "unused",
    botTokenHash: "unused",
    webhookSecret: "unused",
    botUsername: "test_bot",
    paidUntil: null,
    botType: "LEADCATCH",
    adminInviteCode: "invite",
    settings: createQuizChain(),
    subscriptionStatus: "ACTIVE",
    trialEndsAt: new Date().toISOString(),
  };
  updateUser.mockImplementation(async ({ data }) => {
    Object.assign(user, data);
    return { ...user };
  });
  saveLead.mockImplementation(async ({ create }) => ({ ...create }));
  release.mockImplementation(async (_script: string, count: number, ...args: string[]) => {
    const expected = args[count]!;
    let removed = 0;
    for (const key of args.slice(0, count)) {
      if (locks.get(key)?.endsWith(`:${expected}`)) {
        locks.delete(key);
        removed++;
      }
    }
    return removed ? 1 : 0;
  });
  redis = { eval: release } as unknown as Redis;
  prisma = {
    botUser: {
      findUnique: vi.fn(async () => ({ ...user })),
      update: updateUser,
    },
    lead: { upsert: saveLead },
  } as unknown as PrismaClient;
  transport = new MockTelegramTransport();
  bot = new Bot<PlatformBotContext>("123456:navigation-test-token");
  bot.api.config.use(transport.transformerFor("b1"));
  bot.use((ctx, next) => {
    ctx.session = state;
    ctx.botMeta = meta;
    return next();
  });
  const logger = pino({ level: "silent" });
  const controls = registerSharedBotHandlers(bot, prisma, {
    redis,
    transport,
    logger,
    onClientStart: async (ctx) => {
      if (ctx.botMeta.botType === "QUICKBOOK") await startQuickBookFlow(ctx, prisma, redis);
      else await startLeadCatchQuiz(ctx, prisma);
    },
  });
  registerLeadCatchBot(bot, { prisma, transport, logger });
  registerQuickBookBot(bot, { prisma, redis, transport, logger });
  registerNavigationFallback(bot, controls);
  await bot.init();
});
function message(text: string) {
  const command = text.startsWith("/") ? text.split(" ")[0]! : null;
  return bot.handleUpdate({
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: 1,
      from: sender,
      chat: { id: 42, type: "private", first_name: "Клиент" },
      text,
      ...(command
        ? { entities: [{ type: "bot_command" as const, offset: 0, length: command.length }] }
        : {}),
    },
  });
}
function click(data: string) {
  return bot.handleUpdate({
    update_id: ++updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: sender,
      chat_instance: "test",
      data,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: 42, type: "private", first_name: "Клиент" },
        text: "Выбор",
      },
    },
  });
}
const last = () => transport.callsOf("sendMessage").at(-1)!.payload;
const keyboard = () =>
  last().reply_markup as {
    keyboard: { text: string; request_contact?: boolean }[][];
    is_persistent?: boolean;
  };
const labels = () =>
  keyboard()
    .keyboard.flat()
    .map((button) => button.text);
function hold() {
  state.quickbook = {
    serviceId: "service",
    resourceId: "staff",
    slotTimeIso: "2026-10-20T05:00:00.000Z",
    lockToken: "captured-token",
    lockDurationMin: 90,
    lockIntervalMin: 30,
  };
  const keys = getSlotLockKeys("b1", "staff", state.quickbook.slotTimeIso!, 90, 30);
  keys.forEach((key) => locks.set(key, "42:captured-token"));
  return keys;
}
describe("Постоянная навигация клиента", () => {
  it.each(["LEADCATCH", "QUICKBOOK"] as const)(
    "%s: меню доступно на обоих языках",
    async (type) => {
      meta.botType = type;
      for (const lang of ["RU", "UZ"] as const) {
        user.lang = lang;
        await message("/menu");
        expect(keyboard().is_persistent).toBe(true);
        expect(labels()).toEqual([
          t(lang, type === "QUICKBOOK" ? "client_book" : "client_quiz"),
          t(lang, "client_menu"),
          t(lang, "client_language"),
        ]);
      }
    },
  );
  it("start запускает опрос, а кнопка меню завершает текущий опрос без заявки", async () => {
    await message("/start");
    expect(state.quiz).toBeDefined();
    await message(t("RU", "client_menu"));
    expect(state.quiz).toBeUndefined();
    expect(saveLead).not.toHaveBeenCalled();
    expect(labels()).toContain(t("RU", "client_quiz"));
  });
  it("кнопка повторного опроса создаёт новое прохождение", async () => {
    await message("/start");
    const id = state.quiz!.attemptId;
    await message(t("RU", "client_quiz"));
    expect(state.quiz!.attemptId).not.toBe(id);
    expect(state.quiz!.answers).toEqual({});
  });
  it("после успешной заявки возвращает меню и позволяет ещё один опрос без start", async () => {
    await message("/start");
    for (let index = 0; index < 3; index++) {
      const markup = last().reply_markup as { inline_keyboard: { callback_data: string }[][] };
      await click(markup.inline_keyboard[0]![0]!.callback_data);
    }
    expect(
      keyboard()
        .keyboard.flat()
        .some((button) => button.request_contact),
    ).toBe(true);
    expect(labels()).toContain(t("RU", "client_menu"));
    await message("+998901234567");
    expect(saveLead).toHaveBeenCalledOnce();
    expect(state.quiz).toBeUndefined();
    expect(keyboard().is_persistent).toBe(true);
    await message(t("RU", "client_quiz"));
    expect(state.quiz).toBeDefined();
  });
  it("меню на шаге телефона не принимается за номер", async () => {
    await message("/start");
    state.quiz!.currentNodeId = "__contact__";
    await message(t("RU", "client_menu"));
    expect(last().text).toBe(t("RU", "client_menu_title"));
    expect(saveLead).not.toHaveBeenCalled();
  });
  it("неизвестный текст после завершения показывает меню", async () => {
    await message("Что дальше?");
    expect(labels()).toContain(t("RU", "client_menu"));
  });
  it("посторонний текст во время опроса сохраняет ответы и показывает подсказку", async () => {
    await message("/start");
    const saved = structuredClone(state.quiz);
    await message("Что выбрать?");
    expect(state.quiz).toEqual(saved);
    expect(last().text).toBe(t("RU", "client_use_buttons"));
  });
  it.each(["RU", "UZ"] as const)(
    "после успешной записи %s возвращает меню для следующей записи",
    async (lang) => {
      meta.botType = "QUICKBOOK";
      meta.settings = config();
      user.lang = lang;
      state.lang = lang;
      hold();
      vi.mocked(createBooking).mockResolvedValueOnce({
        success: true,
        booking: {
          id: "booking",
          serviceId: "service",
          serviceName: "Консультация",
          staffId: "staff",
          slotTime: new Date("2026-10-20T05:00:00.000Z"),
        },
      } as never);
      await message("+998901234567");
      expect(state.quickbook).toBeUndefined();
      expect(keyboard().is_persistent).toBe(true);
      expect(labels()).toContain(t(lang, "client_book"));
      // The successful booking is persisted by the service; navigation must not cancel it.
      await message(t(lang, "client_book"));
      expect(state.quickbook).toEqual({});
      expect(release).not.toHaveBeenCalled();
    },
  );
  it("новая запись доступна из меню без start", async () => {
    meta.botType = "QUICKBOOK";
    meta.settings = config();
    await message(t("RU", "client_book"));
    expect(state.quickbook).toEqual({});
    expect(last().text).toBe(t("RU", "qb_choose_service"));
  });
});
describe("Язык и права владельца", () => {
  it("смена языка завершает опрос и возвращает локализованное меню", async () => {
    await message("/start");
    await message(t("RU", "client_language"));
    expect(state.quiz).toBeUndefined();
    await click("set_lang:UZ");
    expect(user.lang).toBe("UZ");
    expect(state.lang).toBe("UZ");
    expect(state.quiz).toBeUndefined();
    expect(labels()).toContain(t("UZ", "client_quiz"));
  });
  it("старая кнопка языка меняет язык без неожиданного запуска опроса", async () => {
    state = {};
    await click("set_lang:UZ");
    expect(user.lang).toBe("UZ");
    expect(state.quiz).toBeUndefined();
    expect(labels()).toContain(t("UZ", "client_quiz"));
  });
  it("при первом выборе языка начинает опрос", async () => {
    user.lang = null;
    await message("/start");
    expect(state.quiz).toBeUndefined();
    await click("set_lang:UZ");
    expect(state.quiz).toBeDefined();
    expect(state.lang).toBe("UZ");
  });
  it("ошибка сохранения языка объясняется и допускает повтор", async () => {
    await message(t("RU", "client_language"));
    // profile also updates the user; fail the actual language write, not the profile update.
    updateUser.mockReset().mockImplementation(async ({ data }) => {
      if (data.lang) throw new Error("DB unavailable");
      Object.assign(user, data);
      return { ...user };
    });
    await click("set_lang:UZ");
    expect(last().text).toBe(t("RU", "client_language_failed"));
    expect(user.lang).toBe("RU");
    updateUser.mockImplementation(async ({ data }) => {
      Object.assign(user, data);
      return { ...user };
    });
    await click("set_lang:UZ");
    expect(user.lang).toBe("UZ");
    expect(state.quiz).toBeUndefined();
  });
  it("язык восстанавливается из профиля при новой сессии", async () => {
    user.lang = "UZ";
    state = {};
    await message("/menu");
    expect(labels()).toContain(t("UZ", "client_language"));
  });
  it("владелец может начать новую запись кнопкой даже во время запроса телефона", async () => {
    user.isAdmin = true;
    state.isAdmin = true;
    meta.botType = "QUICKBOOK";
    meta.settings = config();
    hold();
    await message("➕ Записать клиента");
    expect(locks.size).toBe(0);
    expect(state.quickbook).toEqual({});
    expect(last().text).toBe(t("RU", "qb_choose_service"));
  });
  it("владелец получает своё меню, в том числе после старой клиентской кнопки", async () => {
    user.isAdmin = true;
    await message(t("RU", "client_quiz"));
    expect(state.quiz).toBeUndefined();
    expect(labels()).toContain(t("RU", "admin_menu_sub"));
  });
  it("приглашение владельца работает, а клиент не может вызвать admin:lang", async () => {
    await click("admin:lang");
    expect(transport.callsOf("answerCallbackQuery").at(-1)!.payload.show_alert).toBe(true);
    expect(user.isAdmin).toBe(false);
    await message("/start adm_invite");
    expect(user.isAdmin).toBe(true);
    expect(labels()).toContain(t("RU", "admin_menu_sub"));
  });
  it("поддельный флаг администратора в сессии не даёт меню владельца", async () => {
    state.isAdmin = true;
    await message("/menu");
    expect(state.isAdmin).toBe(false);
    expect(labels()).toContain(t("RU", "client_quiz"));
  });
});
describe("Выход из удерживаемой записи", () => {
  it.each(["menu", "repeat", "language", "start"])(
    "%s освобождает все интервалы до очистки состояния",
    async (action) => {
      meta.botType = "QUICKBOOK";
      meta.settings = config();
      const keys = hold();
      await message(
        action === "menu"
          ? t("RU", "client_menu")
          : action === "repeat"
            ? t("RU", "client_book")
            : action === "language"
              ? t("RU", "client_language")
              : "/start",
      );
      expect(keys).toHaveLength(3);
      expect(locks.size).toBe(0);
      expect(release).toHaveBeenCalledOnce();
      expect(state.quickbook?.lockToken).toBeUndefined();
    },
  );
  it("не удаляет уже перехваченное другим пользователем удержание", async () => {
    const keys = hold();
    keys.forEach((key) => locks.set(key, "99:new-token"));
    await message("/menu");
    expect(locks.size).toBe(3);
    expect(state.quickbook).toBeUndefined();
  });
  it("ошибка Redis сохраняет выбор, повтор выхода успешно освобождает время", async () => {
    hold();
    const saved = structuredClone(state.quickbook);
    release.mockRejectedValueOnce(new Error("Redis unavailable"));
    await message("/menu");
    expect(last().text).toBe(t("RU", "client_reset_failed"));
    expect(state.quickbook).toEqual(saved);
    expect(locks.size).toBe(3);
    await message("/menu");
    expect(state.quickbook).toBeUndefined();
    expect(locks.size).toBe(0);
  });
  it("освобождает первоначальные интервалы после изменения конфигурации", async () => {
    hold();
    meta.botType = "QUICKBOOK";
    meta.settings = createEmptyQuickBookConfig();
    await message("/menu");
    expect(locks.size).toBe(0);
  });
});
