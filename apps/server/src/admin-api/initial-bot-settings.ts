import {
  MIN_LEAD_MINUTES_FLOOR,
  createEmptyQuickBookConfig,
  createEmptyQuizConfig,
  type CreateBotRequest,
} from "@lcqb/contracts";
import { TEMPLATES_CATALOG } from "./templates-catalog.js";

export class InitialBotSettingsError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function resolveInitialBotSettings(
  request: Pick<CreateBotRequest, "botType" | "templateId" | "resourceType">,
) {
  if (request.templateId) {
    const template = TEMPLATES_CATALOG.find((item) => item.id === request.templateId);
    if (!template) throw new InitialBotSettingsError(404, "Шаблон не найден. Обновите каталог.");
    if (template.botType !== request.botType)
      throw new InitialBotSettingsError(400, "Этот шаблон предназначен для другого типа бота.");
    const config = structuredClone(template.config);
    if ("services" in config && config.minLeadMinutes === undefined) {
      config.minLeadMinutes = MIN_LEAD_MINUTES_FLOOR;
    }
    return config;
  }
  return request.botType === "QUICKBOOK"
    ? createEmptyQuickBookConfig(request.resourceType)
    : createEmptyQuizConfig();
}
