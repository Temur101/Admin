import { describe, expect, it } from "vitest";
import {
  CreateBotRequestSchema,
  QuickBookConfigSchema,
  createEmptyQuickBookConfig,
  createEmptyQuizConfig,
} from "@lcqb/contracts";
import { resolveInitialBotSettings } from "../src/admin-api/initial-bot-settings.js";
import { getQuickBookConfig } from "../src/bots/quickbook/config-resolver.js";
import { TEMPLATES_CATALOG } from "../src/admin-api/templates-catalog.js";

const request = {
  tenantId: "9a39b3ed-56d5-4498-af32-10f79a0895df",
  botType: "QUICKBOOK",
  botToken: "123456789:TestToken",
};

describe("Создание ботов без обязательной отрасли", () => {
  it("создаёт пустую конфигурацию записи, включая запросы старой админки", () => {
    const parsed = CreateBotRequestSchema.parse(request);
    const config = resolveInitialBotSettings(parsed);
    expect(config).toEqual(createEmptyQuickBookConfig());
    expect(JSON.stringify(config)).not.toMatch(/стрижк|haircut|Азиз|мастер/i);
    expect(QuickBookConfigSchema.safeParse(config).success).toBe(false);
  });
  it.each(["STAFF", "TABLE", "ROOM"] as const)(
    "сохраняет выбранный тип ресурса %s при настройке с нуля",
    (resourceType) => {
      expect(resolveInitialBotSettings({ botType: "QUICKBOOK", resourceType })).toEqual(
        createEmptyQuickBookConfig(resourceType),
      );
    },
  );
  it("создаёт пустой опросник при настройке LeadCatch с нуля", () => {
    expect(resolveInitialBotSettings({ botType: "LEADCATCH" })).toEqual(createEmptyQuizConfig());
  });
  it("не подставляет демонстрационный барбершоп при пустых или неверных настройках", () => {
    for (const settings of [null, {}, { services: "broken" }, { quickbook: {} }]) {
      const config = getQuickBookConfig(settings);
      expect(config.services).toHaveLength(0);
      expect(config.resources).toHaveLength(0);
    }
  });
  it.each(TEMPLATES_CATALOG.map((template) => [template.id, template.botType] as const))(
    "применяет выбранный шаблон %s и сохраняет его независимой копией",
    (templateId, botType) => {
      const template = TEMPLATES_CATALOG.find((item) => item.id === templateId)!;
      const config = resolveInitialBotSettings({ botType, templateId });
      expect(config).toEqual(template.config);
      expect(config).not.toBe(template.config);
      if ("services" in config) config.services[0]!.name.ru = "Изменено";
      else config.nodes[0]!.title.ru = "Изменено";
      expect(resolveInitialBotSettings({ botType, templateId })).toEqual(template.config);
    },
  );
  it("отклоняет неизвестный шаблон и шаблон другого типа", () => {
    expect(() =>
      resolveInitialBotSettings({ botType: "QUICKBOOK", templateId: "missing" }),
    ).toThrow("Шаблон не найден");
    expect(() =>
      resolveInitialBotSettings({ botType: "LEADCATCH", templateId: "restaurant_tables" }),
    ).toThrow("другого типа");
  });
  it("сохраняет старую конфигурацию барбершопа и вложенную конфигурацию", () => {
    const config = resolveInitialBotSettings({
      botType: "QUICKBOOK",
      templateId: "barbershop_2masters",
    });
    expect(getQuickBookConfig(config)).toEqual(config);
    expect(getQuickBookConfig({ quickbook: config })).toEqual(config);
  });
});
