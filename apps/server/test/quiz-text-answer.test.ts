import { attachOutboxFixture } from "./helpers/outbox-fixture.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Bot } from "grammy";
import { pino } from "pino";
import type { Lead, PrismaClient } from "@prisma/client";
import { QuizConfigSchema, QUIZ_FREE_TEXT_MAX_LENGTH, type QuizConfig } from "@lcqb/contracts";
import { createQuizChain } from "@lcqb/contracts/validation";
import type { PlatformBotContext, PlatformBotSession, ResolvedBot } from "../src/gateway/types.js";
import { MockTelegramTransport } from "../src/adapters/telegram/mock-transport.js";
import { registerSharedBotHandlers } from "../src/bots/shared/handlers.js";
import { registerNavigationFallback } from "../src/bots/shared/navigation-handlers.js";
import { registerLeadCatchBot, startLeadCatchQuiz } from "../src/bots/leadcatch/index.js";
import { notifyAdmins } from "../src/bots/shared/notification.js";
vi.mock("../src/core/env.js", () => ({
  env: {
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
    TARIFF_1M_UZS: 100000,
    TARIFF_6M_UZS: 500000,
    TARIFF_12M_UZS: 1000000,
  },
}));
vi.mock("../src/bots/shared/notification.js", () => ({ notifyAdmins: vi.fn(async () => 1) }));
let state: PlatformBotSession;
let config: QuizConfig;
let bot: Bot<PlatformBotContext>;
let transport: MockTelegramTransport;
let rows: Map<string, Lead>;
let user: { lang: "RU" | "UZ"; isAdmin: boolean };
const saveLead = vi.fn();
let update = 0;
const sender = { id: 42, is_bot: false, first_name: "Клиент" };
beforeEach(async () => {
  vi.clearAllMocks();
  state = { lang: "RU" };
  user = { lang: "RU", isAdmin: false };
  rows = new Map();
  config = createQuizChain();
  for (const node of config.nodes)
    node.options.push({
      id: `custom-${node.id}`,
      text: { ru: "Свой ответ", uz: "O‘z javobim" },
      inputType: "TEXT",
      nextNodeId: node.options[0]!.nextNodeId,
    });
  saveLead.mockImplementation(
    async ({ where, create }: { where: { id: string }; create: Lead }) => {
      if (!rows.has(where.id)) rows.set(where.id, structuredClone(create));
      return structuredClone(rows.get(where.id));
    },
  );
  const prisma = {
    lead: { upsert: saveLead },
    botUser: {
      findUnique: vi.fn(async () => ({ ...user })),
      update: vi.fn(async ({ data }) => {
        Object.assign(user, data);
        return { ...user };
      }),
    },
  } as unknown as PrismaClient;
  attachOutboxFixture(prisma);
  transport = new MockTelegramTransport();
  bot = new Bot<PlatformBotContext>("123456:quiz-text-answer-test-token");
  bot.api.config.use(transport.transformerFor("b1"));
  bot.use((ctx, next) => {
    ctx.session = state;
    ctx.botMeta = { id: "b1", botType: "LEADCATCH", settings: config } as unknown as ResolvedBot;
    return next();
  });
  const logger = pino({ level: "silent" });
  const navigation = registerSharedBotHandlers(bot, prisma, {
    logger,
    transport,
    onClientStart: (ctx) => startLeadCatchQuiz(ctx, prisma),
  });
  registerLeadCatchBot(bot, { prisma, transport, logger });
  registerNavigationFallback(bot, navigation);
  await bot.init();
  await message("/start");
});
function message(text: string) {
  return bot.handleUpdate({
    update_id: ++update,
    message: {
      message_id: update,
      date: 1,
      from: sender,
      chat: { id: 42, type: "private", first_name: "Клиент" },
      text,
      ...(text.startsWith("/")
        ? {
            entities: [
              { type: "bot_command" as const, offset: 0, length: text.split(" ")[0]!.length },
            ],
          }
        : {}),
    },
  });
}
function click(data: string) {
  return bot.handleUpdate({
    update_id: ++update,
    callback_query: {
      id: `cb-${update}`,
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
async function contact() {
  if (state.quiz?.currentNodeId !== "__summary__") {
    await bot.handleUpdate({
      update_id: ++update,
      message: {
        message_id: update,
        date: 1,
        from: sender,
        chat: { id: 42, type: "private", first_name: "Клиент" },
        contact: { phone_number: "+998901234567", first_name: "Клиент", user_id: 42 },
      },
    });
  }
  if (state.quiz?.currentNodeId === "__summary__") {
    const summaryCall = [...transport.callsOf("sendMessage")]
      .reverse()
      .find((c) => (c.payload.reply_markup as { inline_keyboard?: unknown })?.inline_keyboard);
    const confirmBtn = (
      summaryCall?.payload.reply_markup as {
        inline_keyboard?: { text: string; callback_data: string }[][];
      }
    )?.inline_keyboard
      ?.flat()
      .find((b) => b.callback_data.startsWith("lc:confirm:"));
    if (confirmBtn) await click(confirmBtn.callback_data);
  }
}
const last = () => transport.callsOf("sendMessage").at(-1)!.payload;
function buttons() {
  return (
    last().reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }
  ).inline_keyboard.flat();
}
const regular = () => click(buttons()[0]!.callback_data);
const custom = () =>
  click(
    buttons().find((button) => button.text === "Свой ответ" || button.text === "O‘z javobim")!
      .callback_data,
  );
function failNextSend() {
  let fail = true;
  bot.api.config.use(async (previous, method, payload, signal) => {
    if (method === "sendMessage" && fail) {
      fail = false;
      throw new Error("Telegram unavailable");
    }
    return previous(method, payload, signal);
  });
}
describe("Свой ответ в опросе", () => {
  it("переходит к вводу только после кнопки, не записывая название кнопки в ответы", async () => {
    const button = buttons().find((item) => item.text === "Свой ответ")!;
    expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
    await click(button.callback_data);
    expect(state.quiz!.pendingText?.nodeId).toBe(config.nodes[0]!.id);
    expect(state.quiz!.currentNodeId).toBe(config.nodes[0]!.id);
    expect(state.quiz!.answers).toEqual({});
    expect(last().text).toContain("Напишите свой ответ");
    expect(Buffer.byteLength(buttons()[0]!.callback_data)).toBeLessThanOrEqual(64);
  });
  it("сохраняет текст, продолжает вопросы и передаёт владельцу полный ответ после контакта", async () => {
    await custom();
    const text = "Нужна другая услуга.\nМожно после 19:00? <b>Важно</b> 🌐";
    await message(`  ${text}  `);
    expect(state.quiz!.answers[config.nodes[0]!.id]).toEqual({
      question: config.nodes[0]!.title.ru,
      answer: text,
      optionId: config.nodes[0]!.options[1]!.id,
    });
    expect(state.quiz!.currentNodeId).toBe(config.nodes[1]!.id);
    expect(state.quiz!.pendingText).toBeUndefined();
    expect(saveLead).not.toHaveBeenCalled();
    await regular();
    await regular();
    await contact();
    expect(rows.size).toBe(1);
    expect([...rows.values()][0]!.answers).toHaveProperty(
      config.nodes[0]!.id,
      expect.objectContaining({ answer: text }),
    );
    expect(notifyAdmins).toHaveBeenCalledWith(
      "b1",
      expect.objectContaining({
        answers: expect.objectContaining({ [config.nodes[0]!.title.ru]: text }),
      }),
      expect.anything(),
    );
  });
  it("телефон в своём ответе остаётся ответом; контакт запрашивается отдельным шагом", async () => {
    await regular();
    await regular();
    await custom();
    await message("+998901234567");
    expect(state.quiz!.currentNodeId).toBe("__contact__");
    expect(saveLead).not.toHaveBeenCalled();
    await contact();
    expect(saveLead).toHaveBeenCalledOnce();
  });
  it.each(["   \n ", "x".repeat(QUIZ_FREE_TEXT_MAX_LENGTH + 1)])(
    "отклоняет пустой или слишком длинный ответ без перехода",
    async (text) => {
      await custom();
      const saved = structuredClone(state.quiz);
      await message(text);
      expect(last().text).toContain("непустой текст до 1000");
      expect(state.quiz).toEqual(saved);
      expect(saveLead).not.toHaveBeenCalled();
    },
  );
  it("принимает ответ ровно на верхней границе", async () => {
    await custom();
    await message("я".repeat(QUIZ_FREE_TEXT_MAX_LENGTH));
    expect(state.quiz!.answers[config.nodes[0]!.id]!.answer).toHaveLength(
      QUIZ_FREE_TEXT_MAX_LENGTH,
    );
  });
  it("не принимает произвольный текст до выбора своего ответа", async () => {
    const saved = structuredClone(state.quiz);
    await message("Хочу спросить");
    expect(state.quiz).toEqual(saved);
  });
  it("возвращается к вариантам без записи и позволяет выбрать обычный ответ", async () => {
    await custom();
    await click(buttons()[0]!.callback_data);
    expect(state.quiz!.pendingText).toBeUndefined();
    expect(state.quiz!.answers).toEqual({});
    await regular();
    expect(state.quiz!.answers[config.nodes[0]!.id]!.answer).toBe("Вариант ответа");
  });
  it("обычная кнопка того же вопроса отменяет ожидание текста", async () => {
    const original = buttons()[0]!.callback_data;
    await custom();
    await click(original);
    expect(state.quiz!.pendingText).toBeUndefined();
    expect(state.quiz!.currentNodeId).toBe(config.nodes[1]!.id);
  });
  it("поддерживает переход своего ответа в отдельную ветку", async () => {
    const extra = {
      ...structuredClone(config.nodes[2]!),
      id: "extra-question",
      options: [{ id: "done", text: { ru: "Готово", uz: "Tayyor" }, nextNodeId: null }],
    };
    config.nodes.push(extra);
    config.nodes[2]!.options[1]!.nextNodeId = extra.id;
    await message("/start");
    await regular();
    await regular();
    await custom();
    await message("Уточнение");
    expect(state.quiz!.currentNodeId).toBe(extra.id);
    expect(state.quiz!.stepCount).toBe(4);
    await regular();
    expect(state.quiz!.currentNodeId).toBe("__contact__");
  });
  it("сохраняет ожидание текста после сериализации сессии", async () => {
    await custom();
    state = JSON.parse(JSON.stringify(state));
    await message("Ответ после перезагрузки");
    expect(state.quiz!.currentNodeId).toBe(config.nodes[1]!.id);
    expect(state.quiz!.answers[config.nodes[0]!.id]!.answer).toBe("Ответ после перезагрузки");
  });
  it("контакт и фотография во время своего ответа не заменяют текст", async () => {
    await custom();
    const saved = structuredClone(state.quiz);
    await contact();
    await bot.handleUpdate({
      update_id: ++update,
      message: {
        message_id: update,
        date: 1,
        from: sender,
        chat: { id: 42, type: "private", first_name: "Клиент" },
        photo: [{ file_id: "photo", file_unique_id: "unique", width: 1, height: 1 }],
      },
    });
    expect(state.quiz).toEqual(saved);
    expect(last().text).toContain("Напишите свой ответ");
    expect(saveLead).not.toHaveBeenCalled();
  });
  it.each(["🏠 Главное меню", "/start", "🌐 Сменить язык"])(
    "%s очищает ожидание своего ответа",
    async (action) => {
      await custom();
      await message(action);
      expect(state.quiz?.pendingText).toBeUndefined();
      await message("Текст старого ответа");
      expect(state.quiz?.answers ?? {}).toEqual({});
      expect(saveLead).not.toHaveBeenCalled();
    },
  );
  it("ошибки ввода и запрос локализованы на узбекский", async () => {
    user.lang = "UZ";
    await message("/start");
    await custom();
    expect(last().text).toContain("Javobingizni");
    expect(buttons()[0]!.text).toBe("Variantlarga qaytish");
    await message("  ");
    expect(last().text).toContain("bo‘sh bo‘lmagan");
    await message("🌐 Menga boshqa xizmat kerak");
    expect(state.quiz!.answers[config.nodes[0]!.id]!.question).toBe(config.nodes[0]!.title.uz);
  });
});
describe("Неактуальные кнопки и повторные действия", () => {
  it("повтор своей кнопки сохраняет ожидание, не создавая ответа", async () => {
    const data = buttons()[1]!.callback_data;
    await click(data);
    await click(data);
    expect(state.quiz!.answers).toEqual({});
    expect(state.quiz!.stepCount).toBe(1);
  });
  it("кнопки ввода и возврата из предыдущего опроса не меняют новый", async () => {
    const data = buttons()[1]!.callback_data;
    await click(data);
    const back = buttons()[0]!.callback_data;
    await message("/start");
    const saved = structuredClone(state.quiz);
    await click(data);
    await click(back);
    expect(state.quiz).toEqual(saved);
  });
  it("возврат из предыдущего вопроса не отменяет следующий", async () => {
    await custom();
    const back = buttons()[0]!.callback_data;
    await message("Ответ");
    const saved = structuredClone(state.quiz);
    await click(back);
    expect(state.quiz).toEqual(saved);
  });
  it.each(["change", "remove"])(
    "изменение настройки %s отменяет старый ввод без потери ответов",
    async (change) => {
      await custom();
      if (change === "change") config.nodes[0]!.title.ru = "Изменённый вопрос";
      else config.nodes[0]!.options.pop();
      await message("Ответ на старую версию");
      expect(state.quiz!.answers).toEqual({});
      expect(state.quiz!.pendingText).toBeUndefined();
      expect(last().text).toBe(config.nodes[0]!.title.ru);
    },
  );
  it("после сбоя отправки запроса повтор кнопки восстанавливает ввод", async () => {
    const data = buttons()[1]!.callback_data;
    failNextSend();
    await expect(click(data)).rejects.toThrow("Telegram unavailable");
    expect(state.quiz!.pendingText).toBeDefined();
    await click(data);
    expect(last().text).toContain("Напишите свой ответ");
  });
  it("сбой отправки следующего вопроса не теряет текст и не записывает ответ повторно", async () => {
    const data = buttons()[1]!.callback_data;
    await click(data);
    failNextSend();
    await expect(message("Мой ответ")).rejects.toThrow("Telegram unavailable");
    expect(state.quiz!.pendingText).toBeUndefined();
    await click(data);
    expect(last().text).toBe(config.nodes[1]!.title.ru);
    expect(Object.keys(state.quiz!.answers)).toHaveLength(1);
    expect(state.quiz!.answers[config.nodes[0]!.id]!.answer).toBe("Мой ответ");
  });
  it("сбой возврата к вариантам сохраняет возможность повторить", async () => {
    await custom();
    const back = buttons()[0]!.callback_data;
    failNextSend();
    await expect(click(back)).rejects.toThrow("Telegram unavailable");
    expect(state.quiz!.pendingText).toBeDefined();
    await click(back);
    expect(state.quiz!.pendingText).toBeUndefined();
    expect(buttons()).toHaveLength(2);
  });
  it("после ошибки БД сохраняет текст и допускает повтор телефона", async () => {
    await custom();
    await message("Вопрос для владельца");
    await regular();
    await regular();
    const saved = structuredClone(state.quiz);
    saveLead.mockRejectedValueOnce(new Error("DB unavailable"));
    await contact();
    expect(state.quiz?.answers).toEqual(saved?.answers);
    expect(state.quiz?.currentNodeId).toBe("__summary__");
    await contact();
    await contact();
    expect(rows.size).toBe(1);
    expect([...rows.values()][0]!.answers).toHaveProperty(
      config.nodes[0]!.id,
      expect.objectContaining({ answer: "Вопрос для владельца" }),
    );
    expect(notifyAdmins).toHaveBeenCalledOnce();
  });
});
it("старые конфигурации не получают новый тип автоматически; неизвестные типы отклоняются", () => {
  const old = createQuizChain();
  expect(QuizConfigSchema.parse(old)).toEqual(old);
  const invalid = structuredClone(old) as unknown as {
    nodes: { options: { inputType?: string }[] }[];
  };
  invalid.nodes[0]!.options[0]!.inputType = "UNKNOWN";
  expect(QuizConfigSchema.safeParse(invalid).success).toBe(false);
});
