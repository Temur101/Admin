import type { Bot as DbBot, PrismaClient } from "@prisma/client";
import type { Bot } from "grammy";
import type { PollingManager } from "../gateway/polling-manager.js";

export interface ActivationOptions {
  mode: "polling" | "webhook";
  publicBaseUrl: string;
  pollingManager?: Pick<PollingManager, "start" | "stop">;
  getTelegramBot: (bot: DbBot) => Bot;
  invalidate: (bot: DbBot) => void;
}
export async function activateBot(
  prisma: PrismaClient,
  bot: DbBot,
  options: ActivationOptions,
  strict = false,
): Promise<string | null> {
  if (strict && options.mode === "polling" && !options.pollingManager)
    throw new Error("Обработчик Telegram не запущен на сервере.");
  if (strict && options.mode === "webhook" && !options.publicBaseUrl)
    throw new Error("Не настроен адрес сервера для Telegram.");
  await prisma.bot.update({ where: { id: bot.id }, data: { isActive: true } });
  options.invalidate(bot);
  try {
    if (options.mode === "polling") {
      if (options.pollingManager && !(await options.pollingManager.start(bot.id)))
        throw new Error("Не удалось запустить получение сообщений.");
      return options.pollingManager ? null : "Обработчик Telegram не запущен на сервере.";
    }
    if (!options.publicBaseUrl) return "Не настроен адрес сервера для Telegram.";
    await options
      .getTelegramBot(bot)
      .api.setWebhook(`${options.publicBaseUrl}/api/v1/tg/webhook/${bot.botTokenHash}`, {
        secret_token: bot.webhookSecret,
        drop_pending_updates: false,
      });
    return null;
  } catch (error) {
    await prisma.bot.update({ where: { id: bot.id }, data: { isActive: bot.isActive } });
    options.invalidate(bot);
    if (!bot.isActive) await options.pollingManager?.stop(bot.id);
    throw error;
  }
}
