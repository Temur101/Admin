import { ApiError } from "../api/client.js";

const messages: Record<string, string> = {
  "Quiz DAG validation failed":
    "Проверьте переходы между вопросами: сценарий должен быть связным, без циклов, от 3 до 5 вопросов в каждом пути.",
  "Invalid LeadCatch Quiz configuration schema":
    "Проверьте вопросы и ответы: заполните тексты на русском и узбекском языках.",
  "Invalid QuickBook configuration schema":
    "Проверьте услуги и расписание: заполните названия, длительность и стоимость.",
  "Invalid bot token": "Токен бота не принят. Скопируйте его заново из @BotFather.",
  "Bot not found": "Бот не найден. Обновите список ботов.",
};

function formatIssue(issue: unknown): string | null {
  if (!issue || typeof issue !== "object") return null;
  const { path, message, code, minimum, maximum } = issue as Record<string, unknown>;
  if (typeof message !== "string") return null;
  const labels: Record<string, string> = {
    services: "Услуги",
    resources: "Ресурсы",
    nodes: "Вопросы",
    options: "Ответы",
    name: "Название",
    title: "Текст вопроса",
    text: "Текст ответа",
    ru: "Русский",
    uz: "Узбекский",
    durationMin: "Длительность (мин)",
    priceUzs: "Цена (UZS)",
    workDays: "Рабочие дни",
    workHours: "Часы работы",
    start: "Начало",
    end: "Конец",
    startNodeId: "Первый вопрос",
    slotIntervalMin: "Интервал записи",
    bookingHorizonDays: "Количество дней для записи",
    botToken: "Токен бота",
    tenantId: "Клиент",
  };
  const field = Array.isArray(path)
    ? path
        .map((part: string | number) =>
          typeof part === "number" ? `№${part + 1}` : (labels[part] ?? part),
        )
        .join(" → ")
    : "Поле";
  let explanation = message;
  if (code === "too_small")
    explanation =
      minimum === 1
        ? "Заполните поле или добавьте хотя бы один элемент."
        : `Минимальное значение: ${minimum}.`;
  if (code === "too_big") explanation = `Максимальное значение: ${maximum}.`;
  if (code === "invalid_type") explanation = "Укажите значение нужного типа.";
  if (code === "invalid_string") explanation = "Проверьте формат значения.";
  return `${field}: ${explanation}`;
}

export function describeApiError(error: unknown): { message: string; details: string[] } {
  if (!(error instanceof ApiError)) {
    return {
      message:
        error instanceof TypeError
          ? "Не удалось связаться с сервером. Проверьте подключение и повторите попытку."
          : error instanceof Error
            ? error.message
            : "Не удалось выполнить действие.",
      details: [],
    };
  }
  const data = error.errorData;
  const details = Array.isArray(data.details)
    ? data.details.filter((item): item is string => typeof item === "string")
    : [];
  const issues = Array.isArray(data.issues)
    ? data.issues.map(formatIssue).filter((item): item is string => item !== null)
    : [];
  return {
    message:
      error.statusCode === 429
        ? "Слишком много запросов. Подождите немного и повторите попытку."
        : (messages[data.error] ?? data.message ?? data.error),
    details: [...details, ...issues],
  };
}
