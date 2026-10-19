import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import type { PrismaClient } from "@prisma/client";
import { normalizeTariffs } from "@lcqb/contracts/tariffs";
import { registerSettingsRoutes } from "../src/admin-api/settings.js";
import { resolveTariffPrices, buildTariffInlineKeyboard } from "../src/bots/shared/admin-menu.js";
vi.mock("../src/core/env.js", () => ({
  env: { TARIFF_1M_UZS: 111000, TARIFF_6M_UZS: 555000, TARIFF_12M_UZS: 1111000 },
}));
let app: FastifyInstance;
let token: string;
let row: Record<string, unknown> | null;
const write = vi.fn();
beforeEach(async () => {
  row = {
    id: 1,
    paymentDetails: "Карта",
    tariffs: [
      { months: 1, priceUzs: 150000 },
      { months: 3, priceUzs: 400000 },
      { months: 12, priceUzs: 1400000 },
    ],
    supportContact: "@support",
    maintenanceMode: false,
    updatedAt: new Date(),
  };
  write.mockImplementation(
    async ({
      create,
      update,
      data,
    }: {
      create?: Record<string, unknown>;
      update?: Record<string, unknown>;
      data?: Record<string, unknown>;
    }) => {
      row = { ...(row ?? create ?? data), ...(row ? update : {}), updatedAt: new Date() };
      return row;
    },
  );
  const prisma = {
    platformSettings: { findUnique: vi.fn(async () => row), create: write, upsert: write },
  } as unknown as PrismaClient;
  app = Fastify();
  await app.register(jwt, { secret: "tariffs-api-test-only" });
  registerSettingsRoutes(app, prisma);
  await app.ready();
  token = app.jwt.sign({ sub: "admin", tokenType: "access" });
});
afterEach(async () => {
  await app.close();
  vi.clearAllMocks();
});
const headers = () => ({ authorization: `Bearer ${token}` });
describe("Единые тарифы", () => {
  it("API и бот читают одинаковые цены из старой записи без подмены 3 месяцев на 6", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/settings",
      headers: headers(),
    });
    const tariffs = response.json().settings.tariffs;
    expect(tariffs).toEqual([
      { months: 1, amountUzs: 150000 },
      { months: 6, amountUzs: 555000 },
      { months: 12, amountUzs: 1400000 },
    ]);
    expect(resolveTariffPrices(row)).toEqual({
      tariff1m: 150000,
      tariff6m: 555000,
      tariff12m: 1400000,
    });
    expect(write).not.toHaveBeenCalled();
  });
  it("новая платформа создаёт канонические тарифы из окружения", async () => {
    row = null;
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/settings",
      headers: headers(),
    });
    expect(response.json().settings.tariffs).toEqual([
      { months: 1, amountUzs: 111000 },
      { months: 6, amountUzs: 555000 },
      { months: 12, amountUzs: 1111000 },
    ]);
    expect(write.mock.calls[0]![0].data.tariffs).toEqual(response.json().settings.tariffs);
  });
  it("новые сохранённые цены видны в API и кнопках оплаты бота", async () => {
    const tariffs = [
      { months: 1, amountUzs: 120000 },
      { months: 6, amountUzs: 600000 },
      { months: 12, amountUzs: 1200000 },
    ];
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: headers(),
      payload: { tariffs },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().settings.tariffs).toEqual(tariffs);
    expect(resolveTariffPrices(row)).toEqual({
      tariff1m: 120000,
      tariff6m: 600000,
      tariff12m: 1200000,
    });
    expect(JSON.stringify(buildTariffInlineKeyboard("RU", resolveTariffPrices(row)))).toContain(
      "120 000",
    );
  });
  it.each(
    [
      [],
      [{ months: 1, amountUzs: 100000 }],
      [
        { months: 1, amountUzs: 100000 },
        { months: 1, amountUzs: 200000 },
        { months: 12, amountUzs: 900000 },
      ],
    ].map((tariffs) => ({ tariffs })),
  )("не сохраняет неполный или дублированный набор тарифов: $tariffs", async ({ tariffs }) => {
    const response = await app.inject({
      method: "PUT",
      url: "/api/v1/settings",
      headers: headers(),
      payload: { tariffs },
    });
    expect(response.statusCode).toBe(400);
    expect(write).not.toHaveBeenCalled();
  });
  it("читает старые объекты и отбрасывает некорректные цены", () => {
    expect(normalizeTariffs({ "1m": 160000, tariff6m: 700000, tariff12m: 1300000 })).toEqual([
      { months: 1, amountUzs: 160000 },
      { months: 6, amountUzs: 700000 },
      { months: 12, amountUzs: 1300000 },
    ]);
    expect(
      normalizeTariffs([
        { months: 1, amountUzs: -1 },
        { months: 6, amountUzs: NaN },
      ]).map((t) => t.amountUzs),
    ).toEqual([100000, 500000, 1000000]);
  });
});
