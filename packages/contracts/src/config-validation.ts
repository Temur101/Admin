import { QuickBookConfigSchema, QuizConfigSchema, type QuizConfig } from "./index.js";
import { validateQuizDag } from "./quiz-dag.js";
export { validateQuizDag, type DagValidationResult } from "./quiz-dag.js";

function schemaIssues(issues: { path: (string | number)[] }[], type: "quiz" | "booking"): string[] {
  return issues
    .map(({ path }) => {
      const [collection, index, field, lang] = path;
      const item = `${collection === "services" ? "Услуга" : collection === "resources" ? "Ресурс" : "Вопрос"} №${Number(index) + 1}`;
      if (typeof index !== "number") {
        if (collection === "services") return "Добавьте хотя бы одну услугу.";
        if (collection === "resources") return "Добавьте хотя бы один ресурс.";
        if (collection === "nodes")
          return "Добавьте вопросы: каждый путь должен содержать 3–5 вопросов.";
        if (collection === "slotIntervalMin")
          return "Интервал начала записей должен быть целым числом от 5 до 120 минут.";
        if (collection === "bookingHorizonDays")
          return "Запись вперёд должна быть целым числом от 1 до 60 дней.";
        if (collection === "resourceLabel")
          return "Заполните название категории ресурса на двух языках.";
        return type === "quiz"
          ? "Проверьте структуру опросника и первый вопрос."
          : "Проверьте структуру услуг и расписания.";
      }
      if (field === "name" || field === "title")
        return `${item}: заполните ${field === "name" ? "название" : "текст"} (${String(lang ?? "RU/UZ").toUpperCase()}).`;
      if (field === "durationMin") return `${item}: длительность — целое число от 5 до 480 минут.`;
      if (field === "priceUzs") return `${item}: цена — целое число от 0.`;
      if (field === "options")
        return `${item}: добавьте ответы с текстом на двух языках и корректными переходами.`;
      if (field === "workHours" || field === "breakHours")
        return `${item}: заполните время начала и окончания.`;
      return `${item}: проверьте поля в JSON.`;
    })
    .filter((value, index, all) => all.indexOf(value) === index);
}

export function quizSetupIssues(settings: unknown): string[] {
  const result = QuizConfigSchema.safeParse(settings);
  if (!result.success) return schemaIssues(result.error.issues, "quiz");
  const config = result.data;
  const errors = validateQuizDag(config).errors;
  const name = (id: string) => {
    const index = config.nodes.findIndex((node) => node.id === id);
    return index < 0
      ? "удалённый вопрос"
      : `вопрос №${index + 1} «${config.nodes[index]!.title.ru}»`;
  };
  return errors.map((error) => {
    if (error.startsWith("Cycle"))
      return "Есть круговой переход: клиент возвращается к уже заданному вопросу. Измените переходы ответов.";
    if (error.startsWith("Quiz path is too short"))
      return "Один из ответов завершает опрос раньше третьего вопроса. Каждый путь должен содержать 3–5 вопросов.";
    if (error.startsWith("Quiz path is too long"))
      return "Один из путей длиннее пяти вопросов. Сократите его до 3–5 вопросов.";
    if (error.startsWith("Unreachable")) {
      const missing = error
        .slice(error.lastIndexOf(":") + 1)
        .trim()
        .split(", ")
        .map(name);
      return `Клиент не может попасть на ${missing.join(", ")}. Добавьте переход к нему или удалите вопрос.`;
    }
    if (error.startsWith("Start")) return "Выберите первый вопрос кнопкой «Сделать стартом».";
    if (error.includes("non-existent"))
      return "Ответ ведёт на удалённый вопрос. Выберите следующий вопрос заново.";
    if (error.includes("duplicate") || error.startsWith("Duplicate"))
      return "Есть повторяющиеся идентификаторы вопросов или ответов. Проверьте JSON.";
    return "Проверьте вопросы и переходы между ними.";
  });
}

export function bookingSetupIssues(settings: unknown): string[] {
  const result = QuickBookConfigSchema.safeParse(settings);
  if (!result.success) return schemaIssues(result.error.issues, "booking");
  const config = result.data;
  const errors: string[] = [];
  if (
    new Set(config.services.map((s) => s.id)).size !== config.services.length ||
    new Set(config.resources.map((r) => r.id)).size !== config.resources.length
  )
    errors.push("Есть повторяющиеся идентификаторы услуг или ресурсов. Проверьте JSON.");
  const minutes = (value: string) => {
    const [hour, minute] = value.split(":").map(Number);
    return hour! >= 0 && hour! <= 23 && minute! >= 0 && minute! <= 59 ? hour! * 60 + minute! : NaN;
  };
  for (const resource of config.resources) {
    if (resource.workDays.length === 0)
      errors.push(`Для «${resource.name.ru}» выберите рабочие дни.`);
    const start = minutes(resource.workHours.start),
      end = minutes(resource.workHours.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
      errors.push(
        `Для «${resource.name.ru}» укажите корректные часы работы: начало должно быть раньше окончания.`,
      );
    if (resource.breakHours) {
      const from = minutes(resource.breakHours.start),
        to = minutes(resource.breakHours.end);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || from < start || to > end)
        errors.push(`Для «${resource.name.ru}» перерыв должен находиться внутри рабочего времени.`);
    }
    if (resource.serviceIds?.some((id) => !config.services.some((service) => service.id === id)))
      errors.push(`Для «${resource.name.ru}» выбрана удалённая услуга.`);
  }
  for (const service of config.services) {
    const fits = config.resources.some((resource) => {
      if (resource.serviceIds?.length && !resource.serviceIds.includes(service.id)) return false;
      if (!resource.workDays.length) return false;
      const start = minutes(resource.workHours.start),
        end = minutes(resource.workHours.end);
      if (resource.breakHours)
        return (
          Math.max(
            minutes(resource.breakHours.start) - start,
            end - minutes(resource.breakHours.end),
          ) >= service.durationMin
        );
      return end - start >= service.durationMin;
    });
    if (!fits)
      errors.push(
        `Для услуги «${service.name.ru}» нет подходящего ресурса с достаточным временем. Проверьте назначение услуг, часы и перерывы.`,
      );
  }
  return errors;
}

export function createQuizChain(): QuizConfig {
  const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  return {
    startNodeId: ids[0]!,
    nodes: ids.map((id, index) => ({
      id,
      title: { ru: `Новый вопрос ${index + 1}`, uz: `Yangi savol ${index + 1}` },
      options: [
        {
          id: crypto.randomUUID(),
          text: { ru: "Вариант ответа", uz: "Javob varianti" },
          nextNodeId: ids[index + 1] ?? null,
        },
      ],
    })),
  };
}
