import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import type { PrismaClient } from "@prisma/client";
import type { Bot } from "grammy";
import { createEmptyQuickBookConfig } from "@lcqb/contracts";
import { registerBotSetupRoutes } from "../src/admin-api/bots-setup.js";
import { resolveInitialBotSettings } from "../src/admin-api/initial-bot-settings.js";
import { validateBotSetup } from "../src/admin-api/bot-setup-validation.js";
import type { ActivationOptions } from "../src/admin-api/bot-activation.js";

// The real authentication hook is used with a local test JWT; no runtime secrets or DB are needed.
vi.mock("../src/core/env.js", () => ({ env: {} }));
let app: FastifyInstance;
let current: {
  id: string;
  tenantId: string;
  botType: "QUICKBOOK";
  isActive: boolean;
  botTokenEnc: string;
  botTokenHash: string;
  webhookSecret: string;
  settings: unknown;
  tenant: { status: string };
  subscription: { status: string; trialEndsAt: Date; paidUntil: Date | null };
};
let token: string;
const update = vi.fn();
const getMe = vi.fn();
const setWebhook = vi.fn();
const start = vi.fn();
const stop = vi.fn();
let options: ActivationOptions;
beforeEach(async () => {
  current = {
    id: "bot1",
    tenantId: "tenant1",
    botType: "QUICKBOOK",
    isActive: false,
    botTokenEnc: "encrypted-test",
    botTokenHash: "hash",
    webhookSecret: "test-webhook",
    settings: resolveInitialBotSettings({ botType: "QUICKBOOK", templateId: "restaurant_tables" }),
    tenant: { status: "ACTIVE" },
    subscription: {
      status: "TRIAL",
      trialEndsAt: new Date(Date.now() + 86400000),
      paidUntil: null,
    },
  };
  update.mockImplementation(async ({ data }: { data: { isActive: boolean } }) => {
    current.isActive = data.isActive;
    return structuredClone(current);
  });
  getMe.mockResolvedValue({ id: 1 });
  setWebhook.mockResolvedValue(true);
  stop.mockResolvedValue(true);
  start.mockImplementation(async () => current.isActive);
  const prisma = {
    bot: { findUnique: vi.fn(async () => structuredClone(current)), update },
  } as unknown as PrismaClient;
  options = {
    mode: "polling",
    publicBaseUrl: "https://example.com",
    pollingManager: { start, stop },
    getTelegramBot: () => ({ api: { getMe, setWebhook } }) as unknown as Bot,
    invalidate: vi.fn(),
  };
  app = Fastify();
  await app.register(jwt, { secret: "launch-unit-test-only" });
  registerBotSetupRoutes(app, prisma, options);
  await app.ready();
  token = app.jwt.sign({ sub: "admin1", tokenType: "access" });
});
afterEach(async () => {
  await app.close();
  vi.clearAllMocks();
});
const headers = () => ({ authorization: `Bearer ${token}` });

describe("Проверка и запуск без подключения к реальной БД", () => {
  it.each(["GET", "POST"] as const)("закрывает %s от неавторизованного доступа", async (method) => {
    const response = await app.inject({
      method,
      url: `/api/v1/bots/bot1/${method === "GET" ? "setup-check" : "launch"}`,
    });
    expect(response.statusCode).toBe(401);
    expect(getMe).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
  it("не принимает refresh-токен вместо access-токена", async () => {
    token = app.jwt.sign({ sub: "admin1", tokenType: "refresh" });
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/bots/bot1/launch", headers: headers() }))
        .statusCode,
    ).toBe(401);
  });
  it("проверяет приостановленный бот без его включения", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/bots/bot1/setup-check",
      headers: headers(),
    });
    expect(response.json().check.canLaunch).toBe(true);
    expect(current.isActive).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
  it("повторно проверяет настройки на запуске, даже если предыдущая проверка была успешной", async () => {
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/bots/bot1/setup-check",
          headers: headers(),
        })
      ).json().check.canLaunch,
    ).toBe(true);
    current.settings = createEmptyQuickBookConfig();
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/bots/bot1/launch", headers: headers() }))
        .statusCode,
    ).toBe(409);
    expect(current.isActive).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
  it("включает запись в БД до вызова менеджера polling", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/bots/bot1/launch",
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    expect(start).toHaveBeenCalledWith("bot1");
    expect(current.isActive).toBe(true);
  });
  it("восстанавливает приостановку при ошибке запуска polling", async () => {
    start.mockResolvedValue(false);
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/bots/bot1/launch", headers: headers() }))
        .statusCode,
    ).toBe(502);
    expect(current.isActive).toBe(false);
    expect(stop).toHaveBeenCalledWith("bot1");
  });
  it("восстанавливает приостановку при ошибке вебхука", async () => {
    options.mode = "webhook";
    setWebhook.mockRejectedValue(new Error("Telegram unavailable"));
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/bots/bot1/launch", headers: headers() }))
        .statusCode,
    ).toBe(502);
    expect(current.isActive).toBe(false);
  });
  it("не запускает бот с недоступным Telegram", async () => {
    getMe.mockRejectedValue(new Error("token-sensitive-error"));
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/bots/bot1/launch",
      headers: headers(),
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).not.toContain("token-sensitive-error");
    expect(update).not.toHaveBeenCalled();
  });
  it.each(["client-paused", "trial-expired", "server-not-configured"])(
    "блокирует запуск: %s",
    async (reason) => {
      if (reason === "client-paused") current.tenant.status = "SUSPENDED";
      if (reason === "trial-expired")
        current.subscription.trialEndsAt = new Date(Date.now() - 1000);
      if (reason === "server-not-configured") {
        options.mode = "webhook";
        options.publicBaseUrl = "";
      }
      expect(
        (await app.inject({ method: "POST", url: "/api/v1/bots/bot1/launch", headers: headers() }))
          .statusCode,
      ).toBe(409);
      expect(update).not.toHaveBeenCalled();
    },
  );
});
describe("Готовность сохранённого сценария", () => {
  it.each(["LEADCATCH", "QUICKBOOK"] as const)("не считает пустой %s готовым", (type) => {
    expect(validateBotSetup(type, resolveInitialBotSettings({ botType: type }))).not.toHaveLength(
      0,
    );
  });
  it("выявляет невозможное расписание и удалённые услуги", () => {
    const settings = {
      ...createEmptyQuickBookConfig(),
      services: [{ id: "s1", name: { ru: "Услуга", uz: "Xizmat" }, durationMin: 30, priceUzs: 0 }],
      resources: [
        {
          id: "r1",
          name: { ru: "Ресурс", uz: "Resurs" },
          workDays: [],
          workHours: { start: "25:00", end: "10:00" },
          serviceIds: ["deleted"],
        },
      ],
    };
    expect(validateBotSetup("QUICKBOOK", settings)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("рабочие дни"),
        expect.stringContaining("часы работы"),
        expect.stringContaining("удалённая услуга"),
      ]),
    );
  });
});
