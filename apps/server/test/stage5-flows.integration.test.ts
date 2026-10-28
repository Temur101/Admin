import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import { createEmptyQuickBookConfig, type QuickBookConfig, type QuizConfig } from "@lcqb/contracts";
import { createQuizChain } from "@lcqb/contracts/validation";
import { BotPool } from "../src/gateway/bot-pool.js";
import type { ResolvedBot, PlatformBotSession } from "../src/gateway/types.js";
import { env } from "../src/core/env.js";
import { logger } from "../src/core/logger.js";
import { encryptSecret, sha256Hex } from "../src/core/crypto.js";
import { connectRedis, type Redis } from "../src/core/redis.js";
import { MockTelegramTransport } from "../src/adapters/telegram/mock-transport.js";
import { registerSettingsRoutes } from "../src/admin-api/settings.js";
import { registerBookingsRoutes } from "../src/admin-api/bookings.js";
import { registerReceiptsRoutes } from "../src/admin-api/receipts.js";
import { generateAvailableSlots } from "../src/bots/quickbook/slot-generator.js";
import { getSlotLockKeys } from "../src/bots/quickbook/slot-lock.js";
import { tashkentDateString } from "../src/bots/quickbook/booking-horizon.js";
import {
  getTestPrismaClient,
  createTestRedisClient,
  safeCleanTestDb,
  safeCleanTestRedis,
} from "./helpers/test-env.js";

const prisma = getTestPrismaClient();
let redis: Redis;
let app: FastifyInstance;
let pool: BotPool;
let transport: MockTelegramTransport;
let leadBot: ResolvedBot;
let bookingBot: ResolvedBot;
let quiz: QuizConfig;
let config: QuickBookConfig;
let auth: { authorization: string };
let update = 0;
const client = 42,
  owner = 99;

async function fixture(
  type: "LEADCATCH" | "QUICKBOOK",
  settings: QuizConfig | QuickBookConfig,
): Promise<ResolvedBot> {
  const token = `123456:${type}-stage5-test-token`;
  const tenant = await prisma.tenant.create({
    data: { clientName: "Stage 5", contactPhone: "+998901234567" },
  });
  const bot = await prisma.bot.create({
    data: {
      tenantId: tenant.id,
      botType: type,
      settings,
      botTokenEnc: encryptSecret(token, env.TOKEN_ENCRYPTION_KEY),
      botTokenHash: sha256Hex(token),
      webhookSecret: "stage5-secret",
      subscription: {
        create: { status: "TRIAL", trialEndsAt: new Date(Date.now() + 3 * 86400000) },
      },
    },
    include: { subscription: true },
  });
  for (const [tgId, isAdmin] of [
    [client, false],
    [owner, true],
  ] as const)
    await prisma.botUser.create({
      data: {
        botId: bot.id,
        tgId: BigInt(tgId),
        firstName: isAdmin ? "Владелец" : "Клиент",
        isAdmin,
        lang: "RU",
      },
    });
  return {
    id: bot.id,
    tenantId: tenant.id,
    botType: type,
    botTokenEnc: bot.botTokenEnc,
    botTokenHash: bot.botTokenHash,
    webhookSecret: bot.webhookSecret,
    botUsername: `${type.toLowerCase}_stage5_bot`,
    settings,
    subscriptionStatus: "TRIAL",
    trialEndsAt: bot.subscription!.trialEndsAt.toISOString(),
    paidUntil: null,
  };
}

const message = (bot: ResolvedBot, text: string, user = client) =>
  pool.handleUpdate(bot, {
    update_id: ++update,
    message: {
      message_id: update,
      date: Math.floor(Date.now() / 1000),
      from: { id: user, is_bot: false, first_name: user === owner ? "Владелец" : "Клиент" },
      chat: { id: user, type: "private", first_name: "Клиент" },
      text,
    },
  });

const click = (bot: ResolvedBot, data: string, user = client) =>
  pool.handleUpdate(bot, {
    update_id: ++update,
    callback_query: {
      id: String(update),
      from: { id: user, is_bot: false, first_name: "Клиент" },
      chat_instance: "stage5",
      data,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: user, type: "private", first_name: "Клиент" },
        text: "Выбор",
      },
    },
  });

const sent = (user = client) =>
  transport
    .callsOf("sendMessage")
    .filter((call) => Number(call.payload.chat_id) === user)
    .at(-1)!.payload;

function buttons() {
  return (
    sent().reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }
  ).inline_keyboard.flat();
}

const session = async (bot: ResolvedBot): Promise<PlatformBotSession> =>
  JSON.parse((await redis.get(`sess:${bot.id}:${client}`)) ?? "{}");

async function maintenance(enabled: boolean) {
  const response = await app.inject({
    method: "PUT",
    url: "/api/v1/settings",
    headers: auth,
    payload: { maintenanceMode: enabled },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().settings.maintenanceMode).toBe(enabled);
}

async function chooseHeldSlot() {
  const dateStr = tashkentDateString(new Date(Date.now() + 86400000));
  const slots = await generateAvailableSlots({
    botId: bookingBot.id,
    config,
    serviceId: "service",
    staffId: "staff",
    dateStr,
    prisma,
    redis,
  });
  expect(slots.length).toBeGreaterThan(0);
  const slot = slots[0]!;
  await click(bookingBot, `qb:slot:service:staff:${slot.slotTimeIso}`);
  expect((await session(bookingBot)).quickbook?.lockToken).toBeTruthy();
  return slot;
}

beforeAll(async () => {
  await prisma.$connect();
  redis = createTestRedisClient("stage5-flows");
  await connectRedis(redis);
});

afterAll(async () => {
  await redis.quit();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await safeCleanTestDb(prisma);
  await safeCleanTestRedis(redis);
  transport = new MockTelegramTransport();
  quiz = createQuizChain();
  quiz.nodes[0]!.options.push({
    id: "custom",
    text: { ru: "Свой ответ", uz: "O‘z javobim" },
    inputType: "TEXT",
    nextNodeId: quiz.nodes[1]!.id,
  });
  config = {
    ...createEmptyQuickBookConfig(),
    services: [
      { id: "service", name: { ru: "Консультация", uz: "Maslahat" }, durationMin: 90, priceUzs: 0 },
    ],
    resources: [
      {
        id: "staff",
        name: { ru: "Сотрудник", uz: "Xodim" },
        workDays: [0, 1, 2, 3, 4, 5, 6],
        workHours: { start: "09:00", end: "18:00" },
      },
    ],
  };
  leadBot = await fixture("LEADCATCH", quiz);
  bookingBot = await fixture("QUICKBOOK", config);
  pool = new BotPool({
    capacity: 10,
    encryptionKey: env.TOKEN_ENCRYPTION_KEY,
    transport,
    redis,
    sessionTtlSec: 3600,
    logger,
    prisma,
  });
  app = Fastify();
  await app.register(jwt, { secret: "stage5-test-only" });
  registerSettingsRoutes(app, prisma);
  registerBookingsRoutes(app, prisma, redis, transport, logger);
  registerReceiptsRoutes(app, prisma, redis, transport, logger);
  await app.ready();
  const admin = await prisma.admin.upsert({
    where: { email: "stage5@example.test" },
    create: { email: "stage5@example.test", passwordHash: "unused" },
    update: {},
  });
  auth = {
    authorization: `Bearer ${app.jwt.sign({ adminId: admin.id, email: admin.email, tokenType: "access" })}`,
  };
});

afterEach(async () => {
  await app?.close();
});

describe("Все сценарии с настоящими PostgreSQL и Redis", () => {
  it("техперерыв включается из API сразу; сохраняет свой ответ и позволяет закончить опрос после выключения", async () => {
    await message(leadBot, "/start");
    await click(leadBot, buttons().find((button) => button.text === "Свой ответ")!.callback_data);
    const saved = (await session(leadBot)).quiz;
    await maintenance(true);
    await message(leadBot, "Ответ во время перерыва");
    expect(sent().text).toContain("технические работы");
    expect((await session(leadBot)).quiz).toEqual(saved);
    expect(await prisma.lead.count()).toBe(0);
    await click(leadBot, "lc:ans:old:question:option");
    expect(transport.callsOf("answerCallbackQuery").at(-1)!.payload.show_alert).toBe(true);
    const settings = await app.inject({ method: "GET", url: "/api/v1/settings", headers: auth });
    expect(settings.statusCode).toBe(200);
    await maintenance(false);
    await message(leadBot, "Нужна другая услуга <вопрос> 🦊");
    await click(leadBot, buttons()[0]!.callback_data);
    await click(leadBot, buttons()[0]!.callback_data);
    await message(leadBot, "+998901234567");
    await click(leadBot, buttons().find((b) => b.callback_data.startsWith("lc:confirm:"))!.callback_data);
    const leads = await prisma.lead.findMany({ where: { botId: leadBot.id } });
    expect(leads).toHaveLength(1);
    expect(leads[0]!.answers).toHaveProperty(
      quiz.nodes[0]!.id,
      expect.objectContaining({ answer: "Нужна другая услуга <вопрос> 🦊" }),
    );
    expect(sent(owner).text).toContain("Нужна другая услуга <вопрос> 🦊");
    expect(sent().reply_markup).toHaveProperty("keyboard");
    await message(leadBot, "🔄 Пройти опрос ещё раз");
    expect((await session(leadBot)).quiz?.attemptId).not.toBe(saved?.attemptId);
  });

  it("владелец оплачивает подписку во время перерыва; текст виден и одобрение без JSON-тела работает", async () => {
    await maintenance(true);
    await message(leadBot, "/start", owner);
    expect(sent(owner).reply_markup).toHaveProperty("keyboard");
    await click(leadBot, "pay:tariff:1", owner);
    await message(leadBot, "Текстовый чек: перевод 12345", owner);
    const receipt = await prisma.paymentReceipt.findFirstOrThrow({ where: { botId: leadBot.id } });
    expect(receipt.textNote).toBe("Текстовый чек: перевод 12345");
    const list = await app.inject({ method: "GET", url: "/api/v1/receipts", headers: auth });
    expect(list.json().receipts[0].textNote).toBe(receipt.textNote);
    const approve = () =>
      app.inject({ method: "POST", url: `/api/v1/receipts/${receipt.id}/approve`, headers: auth });
    expect((await approve()).statusCode).toBe(200);
    expect((await approve()).statusCode).toBe(200);
    expect(
      (await prisma.paymentReceipt.findUniqueOrThrow({ where: { id: receipt.id } })).status,
    ).toBe("APPROVED");
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/receipts/${receipt.id}/reject`,
          headers: auth,
          payload: { reason: "Уже подтверждён" },
        })
      ).statusCode,
    ).toBe(409);
  });

  it("освобождает реальное удержание при техперерыве, сохраняет существующие записи и позволяет их отменить", async () => {
    const slot = await chooseHeldSlot();
    const keys = getSlotLockKeys(bookingBot.id, "staff", slot.slotTime, 90, config.slotIntervalMin);
    expect(keys).toHaveLength(3);
    expect((await redis.mget(...keys)).every(Boolean)).toBe(true);
    const existing = await prisma.booking.create({
      data: {
        botId: bookingBot.id,
        customerTgId: BigInt(client),
        customerPhone: "+998901234567",
        serviceId: "service",
        serviceName: "Консультация",
        staffId: "staff",
        durationMin: 90,
        slotTime: new Date(slot.slotTime.getTime() + 4 * 3600000),
        endTime: new Date(slot.slotTime.getTime() + 5.5 * 3600000),
        status: "CONFIRMED",
      },
    });
    await maintenance(true);
    await message(bookingBot, "+998901234567");
    expect(await redis.mget(...keys)).toEqual([null, null, null]);
    expect((await session(bookingBot)).quickbook).toBeUndefined();
    expect(await prisma.booking.count()).toBe(1);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: existing.id } })).status).toBe(
      "CONFIRMED",
    );
    await click(bookingBot, `book:cancel:${existing.id}`, 44);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: existing.id } })).status).toBe(
      "CONFIRMED",
    );
    await click(bookingBot, `book:cancel:${existing.id}`);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: existing.id } })).status).toBe(
      "CANCELLED",
    );
  });

  it("новая запись из меню создаёт отдельную бронь, а повтор телефона после успеха — нет", async () => {
    const held = await chooseHeldSlot();
    await message(bookingBot, "🏠 Главное меню");
    expect(
      await redis.mget(...getSlotLockKeys(bookingBot.id, "staff", held.slotTime, 90, 30)),
    ).toEqual([null, null, null]);
    await message(bookingBot, "📅 Записаться");
    await chooseHeldSlot();
    await message(bookingBot, "+998901234567");
    await click(
      bookingBot,
      buttons().find((b) => b.callback_data.startsWith("qb:confirm_book:"))!.callback_data,
    );
    expect(sent().reply_markup).toHaveProperty("keyboard");
    expect(await prisma.booking.count()).toBe(1);
    await message(bookingBot, "+998901234567");
    expect(await prisma.booking.count()).toBe(1);
    await message(bookingBot, "📅 Записаться");
    await chooseHeldSlot();
    await message(bookingBot, "+998901234567");
    await click(
      bookingBot,
      buttons().find((b) => b.callback_data.startsWith("qb:confirm_book:"))!.callback_data,
    );
    expect(await prisma.booking.count()).toBe(2);
  });

  it("второй экземпляр обработчика видит техперерыв и язык сразу, без локального кеша", async () => {
    await prisma.botUser.create({
      data: { botId: leadBot.id, tgId: 43n, isAdmin: false, lang: "UZ" },
    });
    const second = new BotPool({
      capacity: 10,
      encryptionKey: env.TOKEN_ENCRYPTION_KEY,
      transport,
      redis,
      sessionTtlSec: 3600,
      logger,
      prisma,
    });
    const bot = second.getOrCreateBot(leadBot);
    await maintenance(true);
    await bot.handleUpdate({
      update_id: ++update,
      message: {
        message_id: update,
        date: 1,
        from: { id: 43, is_bot: false, first_name: "Mijoz" },
        chat: { id: 43, type: "private", first_name: "Mijoz" },
        text: "/start",
      },
    });
    expect(sent(43).text).toContain("texnik ishlar");
    expect(JSON.parse((await redis.get(`sess:${leadBot.id}:43`)) ?? "{}").quiz).toBeUndefined();
    await maintenance(false);
    await bot.handleUpdate({
      update_id: ++update,
      message: {
        message_id: update,
        date: 1,
        from: { id: 43, is_bot: false, first_name: "Mijoz" },
        chat: { id: 43, type: "private", first_name: "Mijoz" },
        text: "/start",
      },
    });
    expect(sent(43).text).toBe(quiz.nodes[0]!.title.uz);
  });

  it("сохранённый срок ограничивает ручное создание, генерацию времени и старые даты бота", async () => {
    config.bookingHorizonDays = 1;
    bookingBot.settings = config;
    await prisma.bot.update({ where: { id: bookingBot.id }, data: { settings: config } });
    const dateStr = tashkentDateString(new Date(Date.now() + 86400000));
    expect(
      await generateAvailableSlots({
        botId: bookingBot.id,
        config,
        serviceId: "service",
        staffId: "staff",
        dateStr,
        prisma,
        redis,
      }),
    ).toEqual([]);
    await click(bookingBot, `qb:date:service:staff:${dateStr}`);
    expect(sent().text).toContain("больше недоступен");
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/bots/${bookingBot.id}/bookings`,
      headers: auth,
      payload: {
        serviceId: "service",
        staffId: "staff",
        slotTime: `${dateStr}T09:00:00+05:00`,
        customerName: "Клиент",
        customerPhone: "+998901234567",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("OUTSIDE_HORIZON");
    expect(await prisma.booking.count()).toBe(0);
  });
});
