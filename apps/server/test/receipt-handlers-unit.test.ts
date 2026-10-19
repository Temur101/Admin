import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Bot } from "grammy";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PlatformBotContext, PlatformBotSession, ResolvedBot } from "../src/gateway/types.js";
import { registerReceiptHandlers } from "../src/bots/shared/receipt-handlers.js";
import { submitPaymentReceipt } from "../src/bots/shared/payment-service.js";
import { MockTelegramTransport } from "../src/adapters/telegram/mock-transport.js";
import { encryptSecret } from "../src/core/crypto.js";
vi.mock("../src/core/env.js", () => ({
  env: {
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
    TARIFF_1M_UZS: 100000,
    TARIFF_6M_UZS: 500000,
    TARIFF_12M_UZS: 1000000,
  },
}));
vi.mock("../src/core/platform-notifier.js", () => ({
  notifyPlatformOwner: vi.fn(async () => false),
}));
vi.mock("../src/bots/shared/payment-service.js", () => ({
  submitPaymentReceipt: vi.fn(),
  formatTashkentDateTime: () => "16.11.2026",
}));
let bot: Bot<PlatformBotContext>;
let state: PlatformBotSession;
let transport: MockTelegramTransport;
let directory: string;
const sender = { id: 42, is_bot: false, first_name: "Владелец" };
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "lcqb-receipt-test-"));
  state = { lang: "RU", payment: { months: 1, amountUzs: 100000 } };
  transport = new MockTelegramTransport();
  const prisma = {
    botUser: { findUnique: vi.fn(async () => ({ isAdmin: true, lang: "RU" })) },
    platformSettings: {
      findUnique: vi.fn(async () => ({
        paymentDetails: "Карта",
        tariffs: [
          { months: 1, amountUzs: 150000 },
          { months: 6, amountUzs: 650000 },
          { months: 12, amountUzs: 1250000 },
        ],
      })),
    },
  } as unknown as PrismaClient;
  bot = new Bot<PlatformBotContext>("123456:unit-test-token");
  bot.api.config.use(transport.transformerFor("b1"));
  bot.use((ctx, next) => {
    ctx.session = state;
    ctx.botMeta = {
      id: "b1",
      subscriptionStatus: "ACTIVE",
      botTokenEnc: encryptSecret("123456:unit-test-token", Buffer.alloc(32).toString("base64")),
    } as ResolvedBot;
    return next();
  });
  registerReceiptHandlers(bot, prisma, { redis: {} as Redis, transport, uploadDir: directory });
  await bot.init();
  vi.mocked(submitPaymentReceipt).mockResolvedValue({
    receipt: { id: "r1", months: 1, amount: 100000 } as never,
    newPaidUntil: new Date("2026-11-16T10:00:00Z"),
    newStatus: "ACTIVE",
  });
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
  vi.clearAllMocks();
});
const choose = (months: number) =>
  bot.handleUpdate({
    update_id: 1,
    callback_query: {
      id: "callback",
      from: sender,
      chat_instance: "local",
      data: `pay:tariff:${months}`,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: 42, type: "private", first_name: "Владелец" },
        text: "Тарифы",
      },
    },
  });
describe("Отправка оплаты владельцем бота", () => {
  it("сохраняет подпись к фото вместе с изображением", async () => {
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1,
        from: sender,
        chat: { id: 42, type: "private", first_name: "Владелец" },
        photo: [{ file_id: "photo", file_unique_id: "unique", width: 1, height: 1 }],
        caption: "  Перевод с карты владельца\nНомер 123456  ",
      },
    });
    expect(submitPaymentReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "PHOTO",
        textNote: "Перевод с карты владельца\nНомер 123456",
      }),
    );
    const params = vi.mocked(submitPaymentReceipt).mock.calls[0]![0];
    expect((await stat(join(directory, params.imagePath!))).isFile()).toBe(true);
    expect(state.payment).toBeUndefined();
  });
  it("сохраняет текст вместо изображения", async () => {
    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1,
        from: sender,
        chat: { id: 42, type: "private", first_name: "Владелец" },
        text: "Оплатил подписку, номер перевода 123456",
      },
    });
    expect(submitPaymentReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "TEXT",
        textNote: "Оплатил подписку, номер перевода 123456",
      }),
    );
  });
  it("выбранные шесть месяцев получают цену из настроек платформы", async () => {
    await choose(6);
    expect(state.payment).toEqual({ months: 6, amountUzs: 650000 });
  });
  it("старый трёхмесячный тариф не подменяется годовым", async () => {
    await choose(3);
    expect(state.payment).toBeUndefined();
    expect(JSON.stringify(transport.callsOf("sendMessage").at(-1)?.payload.reply_markup)).toContain(
      "pay:tariff:6",
    );
    expect(submitPaymentReceipt).not.toHaveBeenCalled();
  });
});
