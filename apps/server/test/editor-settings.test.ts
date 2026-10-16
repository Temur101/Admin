import { QuickBookConfigSchema } from "@lcqb/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import type { PrismaClient } from "@prisma/client";
import { createQuizChain, bookingSetupIssues } from "@lcqb/contracts/validation";
import { registerTemplatesRoutes, TEMPLATES_CATALOG } from "../src/admin-api/templates.js";
import { resolveInitialBotSettings } from "../src/admin-api/initial-bot-settings.js";
vi.mock("../src/core/env.js", () => ({ env: {} }));
let app: FastifyInstance;
let token: string;
let type: "QUICKBOOK" | "LEADCATCH";
const update = vi.fn();
beforeEach(async () => {
  type = "QUICKBOOK";
  const prisma = {
    bot: {
      findUnique: vi.fn(async () => ({ id: "bot1", botType: type, botTokenHash: "test-hash" })),
      update,
    },
  } as unknown as PrismaClient;
  update.mockImplementation(async ({ data }: { data: { settings: unknown } }) => ({
    settings: data.settings,
  }));
  app = Fastify();
  await app.register(jwt, { secret: "editor-test-only" });
  registerTemplatesRoutes(app, prisma);
  await app.ready();
  token = app.jwt.sign({ sub: "admin1", tokenType: "access" });
});
afterEach(async () => {
  await app.close();
  vi.clearAllMocks();
});
const send = (payload: unknown) =>
  app.inject({
    method: "PUT",
    url: "/api/v1/bots/bot1/settings",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    payload: JSON.stringify(payload),
  });
describe("Сохранение настройки на сервере", () => {
  it("не принимает перерыв вне рабочего времени, даже при прямом запросе", async () => {
    const config = QuickBookConfigSchema.parse(
      resolveInitialBotSettings({
        botType: "QUICKBOOK",
        templateId: "restaurant_tables",
      }),
    );
    const resource = config.resources[0]!;
    resource.breakHours = { start: "00:00", end: "01:00" };
    const response = await send(config);
    expect(response.statusCode).toBe(400);
    expect(response.json().details.join(" ")).toContain("перерыв должен");
    expect(update).not.toHaveBeenCalled();
  });
  it("сохраняет произвольную длительность и остальные поля", async () => {
    const config = QuickBookConfigSchema.parse(
      resolveInitialBotSettings({
        botType: "QUICKBOOK",
        templateId: "restaurant_tables",
      }),
    );
    config.services[0]!.durationMin = 22;
    const response = await send(config);
    expect(response.statusCode).toBe(200);
    expect(response.json().settings.services[0].durationMin).toBe(22);
    expect(response.json().settings.resourceType).toBe("TABLE");
    expect(update).toHaveBeenCalledOnce();
  });
  it("отклоняет опрос с ранним завершением одной из веток", async () => {
    type = "LEADCATCH";
    const config = createQuizChain();
    config.nodes[0]!.options.push({
      id: "early",
      text: { ru: "Короткий путь", uz: "Short" },
      nextNodeId: null,
    });
    const response = await send(config);
    expect(response.statusCode).toBe(400);
    expect(response.json().details.join(" ")).toContain("too short");
    expect(update).not.toHaveBeenCalled();
  });
  it("сохраняет корректную связанную цепочку", async () => {
    type = "LEADCATCH";
    const response = await send(createQuizChain());
    expect(response.statusCode).toBe(200);
    expect(response.json().settings.nodes).toHaveLength(3);
  });
  it("готовые шаблоны записи проходят обновлённую проверку", () => {
    for (const template of TEMPLATES_CATALOG.filter((template) => template.botType === "QUICKBOOK"))
      expect(bookingSetupIssues(template.config), template.id).toEqual([]);
  });
});
