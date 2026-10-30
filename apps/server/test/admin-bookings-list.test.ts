import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { PlatformBotContext } from "../src/gateway/types.js";
import { handleAdminBookingsList } from "../src/bots/quickbook/admin-bookings-list.js";

describe("handleAdminBookingsList", () => {
  const mockConfig = {
    resourceType: "STAFF" as const,
    resourceLabel: { ru: "Мастер", uz: "Usta" },
    services: [
      {
        id: "haircut",
        name: { ru: "Мужская стрижка", uz: "Erkaklar soch turmagi" },
        durationMin: 30,
        priceUzs: 80000,
      },
    ],
    resources: [
      {
        id: "staff-1",
        name: { ru: "Рустам", uz: "Rustam" },
        workDays: [0, 1, 2, 3, 4, 5, 6],
        workHours: { start: "09:00", end: "20:00" },
      },
    ],
    slotIntervalMin: 30,
  };

  function createMockCtx(lang = "RU"): {
    ctx: PlatformBotContext;
    replyMock: ReturnType<typeof vi.fn>;
  } {
    const replyMock = vi.fn().mockResolvedValue({});
    const ctx = {
      botMeta: {
        id: "bot-1",
        settings: mockConfig,
      },
      session: {
        lang,
      },
      reply: replyMock,
    } as unknown as PlatformBotContext;
    return { ctx, replyMock };
  }

  it("shows empty message when no bookings exist", async () => {
    const { ctx, replyMock } = createMockCtx("RU");
    const prisma = {
      booking: {
        findMany: vi.fn().mockResolvedValue([]),
      },
    } as unknown as PrismaClient;

    await handleAdminBookingsList(ctx, prisma);

    expect(replyMock).toHaveBeenCalledWith("Предстоящих записей пока нет.");
  });

  it("splits upcoming and past bookings for today", async () => {
    const { ctx, replyMock } = createMockCtx("RU");
    const now = new Date();

    const pastSlot = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 hours ago
    const futureSlot = new Date(now.getTime() + 2 * 60 * 60 * 1000); // in 2 hours

    const prisma = {
      booking: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "b1",
            slotTime: pastSlot,
            serviceId: "haircut",
            serviceName: "Мужская стрижка",
            staffId: "staff-1",
            customerName: "Сардор",
            customerPhone: "+998901112233",
            source: "TELEGRAM",
            status: "CONFIRMED",
          },
          {
            id: "b2",
            slotTime: futureSlot,
            serviceId: "haircut",
            serviceName: "Мужская стрижка",
            staffId: "staff-1",
            customerName: "Тимур",
            customerPhone: "+998909998877",
            source: "MANUAL",
            status: "CONFIRMED",
          },
        ]),
      },
    } as unknown as PrismaClient;

    await handleAdminBookingsList(ctx, prisma);

    expect(replyMock).toHaveBeenCalledOnce();
    const replyText = String(replyMock.mock.calls[0]?.[0] ?? "");

    // Must have upcoming header
    expect(replyText).toContain("📅 <b>Предстоящие записи:</b>");
    expect(replyText).toContain("Тимур (+998909998877)");
    expect(replyText).toContain("[Ручная]");
    expect(replyText).toContain("Рустам");

    // Must have past header
    expect(replyText).toContain("⏳ <b>Прошедшие записи за сегодня:</b>");
    expect(replyText).toContain("Сардор (+998901112233)");

    // Must contain divider
    expect(replyText).toContain("──────────────────");
  });

  it("shows past bookings with note when no upcoming bookings exist", async () => {
    const { ctx, replyMock } = createMockCtx("RU");
    const now = new Date();
    const pastSlot = new Date(now.getTime() - 1 * 60 * 60 * 1000);

    const prisma = {
      booking: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "b1",
            slotTime: pastSlot,
            serviceId: "haircut",
            serviceName: "Мужская стрижка",
            staffId: "staff-1",
            customerName: "Азиз",
            customerPhone: "+998905554433",
            source: "TELEGRAM",
            status: "CONFIRMED",
          },
        ]),
      },
    } as unknown as PrismaClient;

    await handleAdminBookingsList(ctx, prisma);

    expect(replyMock).toHaveBeenCalledOnce();
    const replyText = String(replyMock.mock.calls[0]?.[0] ?? "");

    expect(replyText).toContain("<i>Предстоящих записей пока нет</i>");
    expect(replyText).toContain("⏳ <b>Прошедшие записи за сегодня:</b>");
    expect(replyText).toContain("Азиз (+998905554433)");
  });

  it("supports Uzbek language correctly", async () => {
    const { ctx, replyMock } = createMockCtx("UZ");
    const now = new Date();
    const pastSlot = new Date(now.getTime() - 1 * 60 * 60 * 1000);
    const futureSlot = new Date(now.getTime() + 1 * 60 * 60 * 1000);

    const prisma = {
      booking: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "b1",
            slotTime: pastSlot,
            serviceId: "haircut",
            serviceName: "Erkaklar soch turmagi",
            staffId: "staff-1",
            customerName: "Farrux",
            customerPhone: "+998901234567",
            source: "TELEGRAM",
            status: "CONFIRMED",
          },
          {
            id: "b2",
            slotTime: futureSlot,
            serviceId: "haircut",
            serviceName: "Erkaklar soch turmagi",
            staffId: "staff-1",
            customerName: "Jasur",
            customerPhone: "+998907654321",
            source: "TELEGRAM",
            status: "CONFIRMED",
          },
        ]),
      },
    } as unknown as PrismaClient;

    await handleAdminBookingsList(ctx, prisma);

    expect(replyMock).toHaveBeenCalledOnce();
    const replyText = String(replyMock.mock.calls[0]?.[0] ?? "");

    expect(replyText).toContain("📅 <b>Kutilayotgan buyurtmalar:</b>");
    expect(replyText).toContain("⏳ <b>Bugungi o'tgan buyurtmalar:</b>");
    expect(replyText).toContain("Xizmat: Erkaklar soch turmagi (Rustam)");
  });
});
