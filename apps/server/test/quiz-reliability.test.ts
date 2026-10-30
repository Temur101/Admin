import { attachOutboxFixture } from "./helpers/outbox-fixture.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrismaClient, Lead } from "@prisma/client";
import { pino } from "pino";
import { Bot } from "grammy";
import { createQuizChain, validateQuizDag } from "@lcqb/contracts/validation";
import type { PlatformBotContext, PlatformBotSession, ResolvedBot } from "../src/gateway/types.js";
import { registerLeadCatchBot } from "../src/bots/leadcatch/index.js";
import { startLeadCatchQuiz, handleLeadCatchContact } from "../src/bots/leadcatch/quiz-flow.js";
import { quizAttemptId } from "../src/bots/leadcatch/quiz-session.js";
import { MockTelegramTransport } from "../src/adapters/telegram/mock-transport.js";
import { notifyAdmins } from "../src/bots/shared/notification.js";
import { callbackId } from "../src/bots/shared/callback-id.js";
vi.mock("../src/bots/shared/notification.js", () => ({ notifyAdmins: vi.fn(async () => 1) }));
const logger = pino({ level: "silent" });
let state: PlatformBotSession;
let config: ReturnType<typeof createQuizChain>;
let bot: Bot<PlatformBotContext>;
let transport: MockTelegramTransport;
let prisma: PrismaClient;
let rows: Map<string, Lead>;
const upsert = vi.fn();
let context: PlatformBotContext;
const sender = { id: 42, is_bot: false, first_name: "Клиент" };
let updateId = 0;
beforeEach(async () => {
  state = { lang: "RU" };
  config = createQuizChain();
  rows = new Map();
  transport = new MockTelegramTransport();
  upsert.mockImplementation(async ({ where, create }: { where: { id: string }; create: Lead }) => {
    const old = rows.get(where.id);
    if (old) return structuredClone(old);
    rows.set(where.id, structuredClone(create));
    return structuredClone(create);
  });
  prisma = { lead: { upsert } } as unknown as PrismaClient;
  attachOutboxFixture(prisma);
  bot = new Bot<PlatformBotContext>("123456:quiz-reliability-test-token");
  bot.api.config.use(transport.transformerFor("b1"));
  bot.use((ctx, next) => {
    ctx.session = state;
    ctx.botMeta = { id: "b1", settings: config } as unknown as ResolvedBot;
    context = ctx;
    return next();
  });
  registerLeadCatchBot(bot, { prisma, transport, logger });
  await bot.init();
  await bot.handleUpdate({
    update_id: ++updateId,
    message: {
      message_id: 1,
      date: 1,
      from: sender,
      chat: { id: 42, type: "private", first_name: "Клиент" },
      text: "/quiz",
      entities: [{ type: "bot_command", offset: 0, length: 5 }],
    },
  });
});
afterEach(() => {
  vi.clearAllMocks();
});
function buttons() {
  const markup = transport.callsOf("sendMessage").at(-1)?.payload.reply_markup as {
    inline_keyboard: { callback_data: string }[][];
  };
  return markup.inline_keyboard.flat();
}
function lastText() {
  return String(transport.callsOf("sendMessage").at(-1)?.payload.text);
}
const click = (data: string) =>
  bot.handleUpdate({
    update_id: ++updateId,
    callback_query: {
      id: `cb-${updateId}`,
      from: sender,
      chat_instance: "local",
      data,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: 42, type: "private", first_name: "Клиент" },
        text: "Вопрос",
      },
    },
  });
async function contact() {
  if (state.quiz?.currentNodeId !== "__summary__") {
    await bot.handleUpdate({
      update_id: ++updateId,
      message: {
        message_id: 1,
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
        inline_keyboard?: { callback_data: string }[][];
      }
    )?.inline_keyboard
      ?.flat()
      .find((b) => b.callback_data.startsWith("lc:confirm:"));
    if (confirmBtn) await click(confirmBtn.callback_data);
  }
}
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
async function finishQuestions() {
  for (let index = 0; index < 3; index++) await click(buttons()[0]!.callback_data);
}
const submit = () =>
  handleLeadCatchContact(context, prisma, { rawPhone: "+998901234567", transport, logger });
describe("Кнопки и последовательность опроса", () => {
  it("цепочка с UUID проходит все вопросы с callback_data не длиннее 64 байт", async () => {
    for (let index = 0; index < 3; index++) {
      const data = buttons()[0]!.callback_data;
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      await click(data);
    }
    expect(state.quiz?.currentNodeId).toBe("__contact__");
    expect(Object.keys(state.quiz!.answers)).toEqual(config.nodes.map((node) => node.id));
  });
  it("повтор старого ответа не откатывает вопрос и не меняет ответы", async () => {
    const data = buttons()[0]!.callback_data;
    await click(data);
    const saved = structuredClone(state.quiz);
    await click(data);
    expect(state.quiz).toEqual(saved);
    expect(
      transport
        .callsOf("sendMessage")
        .some((call) => String(call.payload.text).includes("неактуален")),
    ).toBe(true);
  });
  it("повтор кнопки восстанавливает вопрос, если его отправка в Telegram сорвалась", async () => {
    const first = buttons()[0]!.callback_data;
    failNextSend();
    await expect(click(first)).rejects.toThrow("Telegram unavailable");
    expect(state.quiz!.currentNodeId).toBe(config.nodes[1]!.id);
    await click(first);
    expect(lastText()).toBe(config.nodes[1]!.title.ru);
    expect(state.quiz!.stepCount).toBe(2);
    expect(Object.keys(state.quiz!.answers)).toHaveLength(1);
  });
  it("повтор последнего ответа восстанавливает запрос телефона без повторного ответа", async () => {
    await click(buttons()[0]!.callback_data);
    await click(buttons()[0]!.callback_data);
    const last = buttons()[0]!.callback_data;
    failNextSend();
    await expect(click(last)).rejects.toThrow("Telegram unavailable");
    await click(last);
    expect(lastText()).toContain("номер телефона");
    expect(state.quiz!.currentNodeId).toBe("__contact__");
    expect(Object.keys(state.quiz!.answers)).toHaveLength(3);
  });
  it("кнопка из предыдущего прохождения не действует даже на том же вопросе", async () => {
    const old = buttons()[0]!.callback_data;
    const oldId = state.quiz!.attemptId;
    await startLeadCatchQuiz(context, prisma);
    expect(state.quiz!.attemptId).not.toBe(oldId);
    const saved = structuredClone(state.quiz);
    await click(old);
    expect(state.quiz).toEqual(saved);
    expect(lastText()).toContain("неактуален");
  });
  it("изменение конфигурации делает ранее отправленную кнопку неактуальной", async () => {
    const old = buttons()[0]!.callback_data;
    config.nodes[0]!.title.ru = "Новый текст";
    await click(old);
    expect(state.quiz!.answers).toEqual({});
    expect(lastText()).toContain("неактуален");
  });
  it("не принимает старый формат кнопки в новом прохождении", async () => {
    await click(`lc:opt:${config.nodes[0]!.id}:${config.nodes[0]!.options[0]!.id}`);
    expect(state.quiz!.answers).toEqual({});
    expect(lastText()).toContain("неактуален");
  });
  it("поддерживает короткую старую кнопку в существующей старой сессии", async () => {
    config.nodes.forEach((node, index) => {
      node.id = `q${index + 1}`;
      node.options[0]!.id = `o${index + 1}`;
      node.options[0]!.nextNodeId = index < 2 ? `q${index + 2}` : null;
    });
    config.startNodeId = "q1";
    state.quiz = { currentNodeId: "q1", stepCount: 1, answers: {}, startedAt: Date.now() - 5000 };
    await click("lc:opt:q1:o1");
    expect(state.quiz!.currentNodeId).toBe("q2");
    expect(buttons()[0]!.callback_data).toMatch(/^lc:ans:/);
  });
  it("не создаёт новое прохождение при нажатии кнопки после завершения сессии", async () => {
    const old = buttons()[0]!.callback_data;
    state.quiz = undefined;
    await click(old);
    expect(state.quiz).toBeUndefined();
    expect(lastText()).toContain("Главное меню");
  });
});
describe("Сохранение заявки", () => {
  it("сохраняет ответы и не сообщает об успехе, если БД недоступна; повтор отправки успешен", async () => {
    await finishQuestions();
    const saved = structuredClone(state.quiz);
    upsert.mockRejectedValueOnce(new Error("DB unavailable"));
    await contact();
    expect(state.quiz?.answers).toEqual(saved?.answers);
    expect(state.quiz?.currentNodeId).toBe("__summary__");
    expect(rows.size).toBe(0);
    expect(lastText()).toContain("Не удалось сохранить заявку");
    expect(notifyAdmins).not.toHaveBeenCalled();
    await contact();
    expect(rows.size).toBe(1);
    expect(state.quiz).toBeUndefined();
    expect(lastText()).toContain("заявка успешно принята");
  });
  it("сохраняет одну заявку при повторе после потери подтверждения Telegram", async () => {
    await finishQuestions();
    const send = vi.spyOn(context.api, "sendMessage");
    send.mockRejectedValueOnce(new Error("Telegram unavailable"));
    await expect(submit()).rejects.toThrow("Telegram unavailable");
    expect(rows.size).toBe(1);
    expect(state.quiz?.currentNodeId).toBe("__contact__");
    await submit();
    expect(rows.size).toBe(1);
    expect(notifyAdmins).toHaveBeenCalledOnce();
    expect(state.quiz).toBeUndefined();
  });
  it("одновременные повторы одного прохождения используют один ключ заявки", async () => {
    await finishQuestions();
    const session = structuredClone(state.quiz);
    const copy = () =>
      ({
        api: context.api,
        from: context.from,
        chat: context.chat,
        botMeta: context.botMeta,
        session: { lang: "RU", quiz: structuredClone(session) },
      }) as unknown as PlatformBotContext;
    const first = copy(),
      second = copy();
    await Promise.all([
      handleLeadCatchContact(first, prisma, { rawPhone: "+998901234567", transport, logger }),
      handleLeadCatchContact(second, prisma, { rawPhone: "+998901234567", transport, logger }),
    ]);
    expect(rows.size).toBe(1);
    expect(upsert.mock.calls[0]![0].where.id).toBe(upsert.mock.calls[1]![0].where.id);
  });
  it("новое прохождение с тем же телефоном создаёт новую заявку", async () => {
    await finishQuestions();
    await contact();
    await startLeadCatchQuiz(context, prisma);
    await finishQuestions();
    await contact();
    expect(rows.size).toBe(2);
  });
  it("повтор контакта после успеха не создаёт пустую заявку", async () => {
    await finishQuestions();
    await contact();
    await contact();
    expect(rows.size).toBe(1);
    expect(upsert).toHaveBeenCalledOnce();
  });
  it("не принимает контакт до последнего шага", async () => {
    await contact();
    expect(rows.size).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });
  it("однозначно восстанавливает ключ старой сессии после перезагрузки", async () => {
    await finishQuestions();
    delete state.quiz!.attemptId;
    const id = quizAttemptId(context);
    state.quiz = JSON.parse(JSON.stringify(state.quiz));
    expect(quizAttemptId(context)).toBe(id);
    expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  });
  it("ошибка сохранения объясняется и на узбекском языке", async () => {
    await finishQuestions();
    state.lang = "UZ";
    upsert.mockRejectedValueOnce(new Error("DB unavailable"));
    await contact();
    expect(lastText()).toContain("Arizani saqlab bo‘lmadi");
    expect(state.quiz).toBeDefined();
  });
});
it("кодирование ограничивает длинные и нелатинские идентификаторы", () => {
  const ids = [randomUUID(), "вопрос:".repeat(100), "identifier".repeat(1000)];
  for (const id of ids)
    expect(
      Buffer.byteLength(`lc:ans:123456789abc:${callbackId(id)}:${callbackId(id)}`),
    ).toBeLessThanOrEqual(64);
  expect(validateQuizDag(config).valid).toBe(true);
});
