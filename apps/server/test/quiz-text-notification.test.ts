import { describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import { MockTelegramTransport } from "../src/adapters/telegram/mock-transport.js";
import { notifyAdmins } from "../src/bots/shared/notification.js";
import { encryptSecret } from "../src/core/crypto.js";
vi.mock("../src/core/env.js", () => ({
  env: { TOKEN_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64") },
}));
describe("Уведомление с текстовыми ответами", () => {
  it.each(["RU", "UZ"] as const)(
    "передаёт все ответы %s без обрезания и превышения лимита Telegram",
    async (lang) => {
      const transport = new MockTelegramTransport();
      const prisma = {
        bot: {
          findUnique: vi.fn(async () => ({
            id: "b1",
            botTokenEnc: encryptSecret(
              "123456:notification-test-token",
              Buffer.alloc(32).toString("base64"),
            ),
            subscription: { status: "ACTIVE" },
            users: [{ tgId: 42n, lang }],
          })),
        },
      } as unknown as PrismaClient;
      const answers = Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => [
          `Вопрос ${index + 1}`,
          `${index} <b>текст</b>\n` + "🦊".repeat(490),
        ]),
      );
      const count = await notifyAdmins(
        "b1",
        { kind: "LEAD", name: "Клиент", phone: "+998901234567", answers },
        { prisma, transport, logger: pino({ level: "silent" }) },
      );
      expect(count).toBe(1);
      const messages = transport.callsOf("sendMessage");
      expect(messages.length).toBeGreaterThan(1);
      for (const call of messages) {
        const text = String(call.payload.text);
        expect(text.length).toBeLessThanOrEqual(4096);
        expect(call.payload.parse_mode).toBeUndefined();
        expect(Buffer.from(text).toString("utf8")).toBe(text);
      }
      const full = messages.map((call) => call.payload.text).join("");
      for (const [question, answer] of Object.entries(answers))
        expect(full).toContain(`• ${question}: ${answer}`);
    },
  );
  it("обычное короткое уведомление остаётся одним сообщением", async () => {
    const transport = new MockTelegramTransport();
    const prisma = {
      bot: {
        findUnique: vi.fn(async () => ({
          id: "b1",
          botTokenEnc: encryptSecret(
            "123456:notification-test-token",
            Buffer.alloc(32).toString("base64"),
          ),
          subscription: { status: "ACTIVE" },
          users: [{ tgId: 42n, lang: "RU" }],
        })),
      },
    } as unknown as PrismaClient;
    await notifyAdmins(
      "b1",
      { kind: "LEAD", phone: "+998901234567", answers: { Вопрос: "Ответ" } },
      { prisma, transport, logger: pino({ level: "silent" }) },
    );
    expect(transport.callsOf("sendMessage")).toHaveLength(1);
  });
});
