import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import { pino } from "pino";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import type { TelegramTransport } from "../src/adapters/telegram/transport.js";
import { registerReceiptsRoutes } from "../src/admin-api/receipts.js";
vi.mock("../src/core/env.js", () => ({ env: {} }));
let app: FastifyInstance;
let token: string;
let receipt: {
  id: string;
  botId: string;
  status: string;
  textNote: string;
  kind: string;
  imagePath: null;
  months: number;
  amount: number;
  submittedByTgId: bigint;
  createdAt: Date;
  reviewedAt: Date | null;
  grantedUntil: Date;
  prevPaidUntil: Date | null;
  rejectionReason: string | null;
  bot: {
    id: string;
    botTokenHash: string;
    botUsername: string;
    botType: string;
    tenant: { clientName: string };
    subscription: typeof subscription;
    users: [];
  };
};
let subscription: { id: string; status: string; paidUntil: Date; failedReceiptAttempts: number };
const save = vi.fn();
beforeEach(async () => {
  subscription = {
    id: "sub1",
    status: "ACTIVE",
    paidUntil: new Date(Date.now() + 365 * 86400000),
    failedReceiptAttempts: 1,
  };
  receipt = {
    id: "r1",
    botId: "b1",
    status: "PENDING",
    kind: "TEXT",
    textNote: "Перевод за подписку, номер 1234567890",
    imagePath: null,
    months: 1,
    amount: 100000,
    submittedByTgId: 42n,
    createdAt: new Date(),
    reviewedAt: null,
    grantedUntil: subscription.paidUntil,
    prevPaidUntil: null,
    rejectionReason: null,
    bot: {
      id: "b1",
      botTokenHash: "hash",
      botUsername: "test_bot",
      botType: "LEADCATCH",
      tenant: { clientName: "Клиент" },
      subscription,
      users: [],
    },
  };
  save.mockImplementation(async ({ data }: { data: Partial<typeof receipt> }) => {
    Object.assign(receipt, data);
    return receipt;
  });
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    paymentReceipt: { findUnique: vi.fn(async () => receipt), update: save },
    subscription: {
      findUniqueOrThrow: vi.fn(async () => subscription),
      update: vi.fn(async ({ data }: { data: Partial<typeof subscription> }) =>
        Object.assign(subscription, data),
      ),
    },
  };
  const prisma = {
    paymentReceipt: { findMany: vi.fn(async () => [receipt]) },
    subscription: { findUnique: vi.fn(async () => subscription) },
    $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx),
  } as unknown as PrismaClient;
  app = Fastify();
  await app.register(jwt, { secret: "payments-api-test-only" });
  registerReceiptsRoutes(
    app,
    prisma,
    { del: vi.fn(async () => 1) } as unknown as Redis,
    {} as TelegramTransport,
    pino({ level: "silent" }),
  );
  await app.ready();
  token = app.jwt.sign({ sub: "admin", tokenType: "access" });
});
afterEach(async () => {
  await app.close();
  vi.clearAllMocks();
});
const headers = () => ({ authorization: `Bearer ${token}` });
describe("HTTP модерация оплаты", () => {
  it("одобряет чек пустым POST без JSON заголовка", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/receipts/r1/approve",
      headers: headers(),
    });
    expect(response.statusCode).toBe(200);
    expect(receipt.status).toBe("APPROVED");
    expect(subscription.failedReceiptAttempts).toBe(0);
  });
  it("воспроизводит исходную ошибку Fastify при пустом JSON запросе", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/receipts/r1/approve",
      headers: { ...headers(), "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("Body cannot be empty");
    expect(save).not.toHaveBeenCalled();
  });
  it("возвращает полный текст оплаты для просмотра", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/receipts?status=PENDING",
      headers: headers(),
    });
    expect(response.json().receipts[0].textNote).toBe(receipt.textNote);
  });
  it("не сообщает об успешном одобрении уже отклонённого чека", async () => {
    receipt.status = "REJECTED";
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/receipts/r1/approve",
      headers: headers(),
    });
    expect(response.statusCode).toBe(409);
    expect(save).not.toHaveBeenCalled();
  });
  it("не сообщает об успешном отклонении уже одобренного чека", async () => {
    receipt.status = "APPROVED";
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/receipts/r1/reject",
      headers: headers(),
      payload: { reason: "Платёж не найден" },
    });
    expect(response.statusCode).toBe(409);
    expect(save).not.toHaveBeenCalled();
  });
  it("отклоняет чек с причиной и сохраняет её", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/receipts/r1/reject",
      headers: headers(),
      payload: { reason: "Платёж не найден" },
    });
    expect(response.statusCode).toBe(200);
    expect(receipt.status).toBe("REJECTED");
    expect(receipt.rejectionReason).toBe("Платёж не найден");
  });
  it("повторное одобрение не выполняет повторное сохранение", async () => {
    for (let i = 0; i < 2; i++)
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/receipts/r1/approve",
            headers: headers(),
          })
        ).statusCode,
      ).toBe(200);
    expect(save).toHaveBeenCalledOnce();
  });
});
