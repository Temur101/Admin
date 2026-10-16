import type { Bot } from "grammy";
import type { PollingManager } from "../gateway/polling-manager.js";

interface ConnectionBot {
  id: string;
  isActive: boolean;
  botTokenHash: string;
}

export async function checkBotConnection(
  bot: ConnectionBot,
  options: {
    mode: "polling" | "webhook";
    publicBaseUrl: string;
    pollingManager?: Pick<PollingManager, "isConnected">;
    getTelegramBot?: () => Bot;
  },
) {
  const base = { mode: options.mode, checkedAt: new Date().toISOString() };
  if (!bot.isActive) return { ...base, status: "PAUSED" as const, message: "Бот приостановлен." };
  if (!options.getTelegramBot)
    return { ...base, status: "UNKNOWN" as const, message: "Проверка связи недоступна." };
  if (options.mode === "polling" && !options.pollingManager?.isConnected(bot.id)) {
    return {
      ...base,
      status: "STOPPED" as const,
      message: "Получение сообщений не запущено или ещё запускается.",
    };
  }
  if (options.mode === "webhook" && !options.publicBaseUrl) {
    return {
      ...base,
      status: "NOT_CONFIGURED" as const,
      message: "Не задан адрес сервера для подключения Telegram.",
    };
  }
  try {
    const tgBot = options.getTelegramBot();
    if (options.mode === "polling") {
      await tgBot.api.getMe();
      return {
        ...base,
        status: "READY" as const,
        message: "Telegram доступен, получение сообщений запущено.",
      };
    }
    const info = await tgBot.api.getWebhookInfo();
    const expectedUrl = `${options.publicBaseUrl}/api/v1/tg/webhook/${bot.botTokenHash}`;
    if (info.url !== expectedUrl) {
      return {
        ...base,
        status: "NOT_CONFIGURED" as const,
        message: "Адрес вебхука в Telegram не соответствует этому серверу.",
      };
    }
    if (info.last_error_date && info.last_error_date * 1000 > Date.now() - 5 * 60 * 1000) {
      return {
        ...base,
        status: "ERROR" as const,
        message: "Telegram недавно сообщил об ошибке доставки. Откройте диагностику.",
      };
    }
    return {
      ...base,
      status: "READY" as const,
      message: "Telegram доступен, вебхук настроен. Проверьте ответ бота в Telegram.",
    };
  } catch {
    return {
      ...base,
      status: "ERROR" as const,
      message: "Не удалось проверить связь с Telegram. Проверьте токен и подключение сервера.",
    };
  }
}
