import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createEmptyQuickBookConfig, createEmptyQuizConfig } from "@lcqb/contracts";
import type { PlatformBotContext } from "../src/gateway/types.js";
import { startQuickBookFlow } from "../src/bots/quickbook/quickbook-handlers.js";
import { startLeadCatchQuiz } from "../src/bots/leadcatch/quiz-flow.js";
import { resolveInitialBotSettings } from "../src/admin-api/initial-bot-settings.js";

// These start-flow tests never book or send admin notifications.
vi.mock("../src/bots/shared/notification.js", () => ({ notifyAdmins: vi.fn() }));
vi.mock("../src/bots/quickbook/booking-service.js", () => ({
  createBooking: vi.fn(),
  formatTashkentDateTime: vi.fn(),
}));

function context(settings: unknown, lang: "RU" | "UZ") {
  const reply = vi.fn().mockResolvedValue(undefined);
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const session = { lang, quickbook: {}, quiz: { currentNodeId: "stale" } };
  const ctx = {
    botMeta: { settings },
    session,
    reply,
    api: { sendMessage },
    chat: { id: 123 },
  } as unknown as PlatformBotContext;
  return { ctx, reply, sendMessage, session };
}
const prisma = {} as PrismaClient;

describe("Поведение бота до настройки", () => {
  it.each(["RU", "UZ"] as const)(
    "пустой QuickBook на %s объясняет отсутствие настройки без меню записи",
    async (lang) => {
      const { ctx, reply } = context(createEmptyQuickBookConfig("TABLE"), lang);
      await startQuickBookFlow(ctx, prisma);
      expect(reply).toHaveBeenCalledWith(
        lang === "RU"
          ? "Сервис пока не настроен. Пожалуйста, попробуйте позже."
          : "Xizmat hali sozlanmagan. Iltimos, keyinroq urinib ko'ring.",
      );
      expect(reply).toHaveBeenCalledOnce();
    },
  );
  it.each(["RU", "UZ"] as const)(
    "пустой LeadCatch на %s не запускает демонстрационный опрос",
    async (lang) => {
      const { ctx, sendMessage, session } = context(createEmptyQuizConfig(), lang);
      await startLeadCatchQuiz(ctx, prisma);
      expect(sendMessage).toHaveBeenCalledWith(
        123,
        lang === "RU"
          ? "Сервис пока не настроен. Пожалуйста, попробуйте позже."
          : "Xizmat hali sozlanmagan. Iltimos, keyinroq urinib ko'ring.",
        undefined,
      );
      expect(session).not.toHaveProperty("quiz");
    },
  );
  it("выбранный шаблон ресторана запускает его услуги вместо стрижек", async () => {
    const settings = resolveInitialBotSettings({
      botType: "QUICKBOOK",
      templateId: "restaurant_tables",
    });
    const { ctx, reply } = context(settings, "RU");
    await startQuickBookFlow(ctx, prisma);
    const keyboard = reply.mock.calls[0]?.[1]?.reply_markup.inline_keyboard;
    expect(JSON.stringify(keyboard)).toContain("Обед");
    expect(JSON.stringify(keyboard)).not.toContain("Стрижка");
  });
});
