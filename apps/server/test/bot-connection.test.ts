import { describe, expect, it, vi } from "vitest";
import type { Bot } from "grammy";
import { checkBotConnection } from "../src/admin-api/bot-connection.js";

const bot = { id: "bot1", isActive: true, botTokenHash: "hash" };
function options(mode: "polling" | "webhook" = "polling") {
  const api = {
    getMe: vi.fn().mockResolvedValue({}),
    getWebhookInfo: vi
      .fn()
      .mockResolvedValue({ url: "https://example.com/api/v1/tg/webhook/hash" }),
  };
  return {
    mode,
    publicBaseUrl: "https://example.com",
    pollingManager: { isConnected: vi.fn().mockReturnValue(true) },
    getTelegramBot: () => ({ api }) as unknown as Bot,
    api,
  };
}

describe("Проверка связи бота без базы", () => {
  it("не считает активный флаг работающим polling", async () => {
    const opts = options();
    opts.pollingManager.isConnected.mockReturnValue(false);
    expect((await checkBotConnection(bot, opts)).status).toBe("STOPPED");
    expect(opts.api.getMe).not.toHaveBeenCalled();
  });
  it("для работающего polling проверяет Telegram", async () => {
    const opts = options();
    expect((await checkBotConnection(bot, opts)).status).toBe("READY");
    expect(opts.api.getMe).toHaveBeenCalledOnce();
  });
  it("сообщает об ошибке Telegram даже при запущенном polling", async () => {
    const opts = options();
    opts.api.getMe.mockRejectedValue(new Error("unauthorized"));
    expect((await checkBotConnection(bot, opts)).status).toBe("ERROR");
  });
  it("не проверяет Telegram для приостановленного бота", async () => {
    const opts = options();
    expect((await checkBotConnection({ ...bot, isActive: false }, opts)).status).toBe("PAUSED");
    expect(opts.api.getMe).not.toHaveBeenCalled();
  });
  it("не считает чужой вебхук настроенным", async () => {
    const opts = options("webhook");
    opts.api.getWebhookInfo.mockResolvedValue({ url: "https://other.example.com" });
    expect((await checkBotConnection(bot, opts)).status).toBe("NOT_CONFIGURED");
  });
  it("различает корректный вебхук и отсутствие адреса сервера", async () => {
    const opts = options("webhook");
    expect((await checkBotConnection(bot, opts)).status).toBe("READY");
    expect((await checkBotConnection(bot, { ...opts, publicBaseUrl: "" })).status).toBe(
      "NOT_CONFIGURED",
    );
  });
});
