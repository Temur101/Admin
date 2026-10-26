import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { BotSubscriptionCard } from "../src/components/bots/BotSubscriptionCard.js";
import { BotResetSection } from "../src/components/bots/BotResetSection.js";
import type { BotDetails } from "../src/api/bots.js";
import * as botsApi from "../src/api/bots.js";

vi.mock("../src/api/bots.js", async (original) => ({
  ...(await original<typeof import("../src/api/bots.js")>()),
  extendBotSubscription: vi.fn(),
  reduceBotSubscription: vi.fn(),
  grantBotTrial: vi.fn(),
  resetBot: vi.fn(),
}));

const mockNavigate = vi.fn();
vi.mock("react-router-dom", async (original) => {
  const actual = await original<typeof import("react-router-dom")>();
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function createMockBot(overrides: Partial<BotDetails> = {}): BotDetails {
  return {
    id: "bot-123",
    tenantId: "tenant-456",
    tenantName: "Тестовый клиент",
    botType: "LEADCATCH",
    botUsername: "testbot",
    isActive: true,
    adminInviteCode: "invite-code-123",
    createdAt: new Date().toISOString(),
    subscription: {
      status: "TRIAL",
      trialEndsAt: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
      paidUntil: null,
    },
    stats: {
      leadsCount: 10,
      bookingsCount: 0,
      usersCount: 50,
      adminsCount: 2,
      receiptsCount: 1,
    },
    admins: [],
    ...overrides,
  };
}

describe("BotSubscriptionCard & BotResetSection", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.clearAllMocks();
    vi.spyOn(window, "confirm").mockImplementation(() => true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  describe("BotSubscriptionCard", () => {
    it("renders subscription status and handles quick extensions", async () => {
      vi.mocked(botsApi.extendBotSubscription).mockResolvedValue();
      const bot = createMockBot();

      render(
        <QueryClientProvider client={queryClient}>
          <BotSubscriptionCard bot={bot} />
        </QueryClientProvider>,
      );

      expect(screen.getByText("Статус подписки")).toBeTruthy();
      expect(screen.getByText("+30 дней")).toBeTruthy();
      expect(screen.getByText("+180 дней")).toBeTruthy();
      expect(screen.getByText("+365 дней")).toBeTruthy();

      // Click +180 days
      fireEvent.click(screen.getByText("+180 дней"));
      await waitFor(() => {
        expect(botsApi.extendBotSubscription).toHaveBeenCalledWith("bot-123", { days: 180 });
      });
    });

    it("handles custom extension and reduction with confirmation", async () => {
      vi.mocked(botsApi.extendBotSubscription).mockResolvedValue();
      vi.mocked(botsApi.reduceBotSubscription).mockResolvedValue();
      const bot = createMockBot();

      render(
        <QueryClientProvider client={queryClient}>
          <BotSubscriptionCard bot={bot} />
        </QueryClientProvider>,
      );

      const daysInput = screen.getByPlaceholderText("Дней");
      fireEvent.change(daysInput, { target: { value: "45" } });

      // Extend 45 days
      fireEvent.click(screen.getByText("Продлить"));
      await waitFor(() => {
        expect(botsApi.extendBotSubscription).toHaveBeenCalledWith("bot-123", { days: 45 });
      });

      // Reduce 45 days
      fireEvent.click(screen.getByText("Уменьшить"));
      await waitFor(() => {
        expect(window.confirm).toHaveBeenCalled();
        expect(botsApi.reduceBotSubscription).toHaveBeenCalledWith("bot-123", { days: 45 });
      });
    });

    it("grants trial period and disables button when active paid subscription exists", async () => {
      vi.mocked(botsApi.grantBotTrial).mockResolvedValue();

      // Bot with active paid subscription
      const paidBot = createMockBot({
        subscription: {
          status: "ACTIVE",
          trialEndsAt: new Date(Date.now() - 1000).toISOString(),
          paidUntil: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
        },
      });

      const { rerender } = render(
        <QueryClientProvider client={queryClient}>
          <BotSubscriptionCard bot={paidBot} />
        </QueryClientProvider>,
      );

      const trialBtn = screen.getByText("Выдать пробный");
      expect((trialBtn.closest("button") as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByText(/Недоступно: у бота действует оплаченная подписка/)).toBeTruthy();

      // Rerender with expired subscription
      const expiredBot = createMockBot({
        subscription: {
          status: "EXPIRED",
          trialEndsAt: new Date(Date.now() - 1000).toISOString(),
          paidUntil: null,
        },
      });

      rerender(
        <QueryClientProvider client={queryClient}>
          <BotSubscriptionCard bot={expiredBot} />
        </QueryClientProvider>,
      );

      const enabledTrialBtn = screen.getByText("Выдать пробный");
      expect((enabledTrialBtn.closest("button") as HTMLButtonElement).disabled).toBe(false);

      const trialInput = screen.getByPlaceholderText("7");
      fireEvent.change(trialInput, { target: { value: "14" } });
      fireEvent.click(enabledTrialBtn);

      await waitFor(() => {
        expect(botsApi.grantBotTrial).toHaveBeenCalledWith("bot-123", { days: 14 });
      });
    });
  });

  describe("BotResetSection", () => {
    it("opens confirmation modal and requires exact username to confirm reset", async () => {
      vi.mocked(botsApi.resetBot).mockResolvedValue({ clearedSessions: 3 });
      const bot = createMockBot({ botUsername: "myawesomebot" });

      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <BotResetSection bot={bot} />
          </MemoryRouter>
        </QueryClientProvider>,
      );

      expect(screen.getByText("Сброс настроек бота")).toBeTruthy();

      // Click "Сбросить бота" button to open modal
      fireEvent.click(screen.getByRole("button", { name: "Сбросить бота" }));

      expect(screen.getByText("Подтверждение сброса")).toBeTruthy();
      const confirmInput = screen.getByPlaceholderText("@myawesomebot");
      const submitBtn = screen.getByRole("button", { name: "Сбросить настройки" });
      expect((submitBtn as HTMLButtonElement).disabled).toBe(true);

      // Typing wrong username
      fireEvent.change(confirmInput, { target: { value: "@wrongbot" } });
      expect((submitBtn as HTMLButtonElement).disabled).toBe(true);

      // Typing exact username
      fireEvent.change(confirmInput, { target: { value: "@myawesomebot" } });
      expect((submitBtn as HTMLButtonElement).disabled).toBe(false);

      // Submit reset
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(botsApi.resetBot).toHaveBeenCalledWith("bot-123");
        expect(mockNavigate).toHaveBeenCalledWith("/bots/bot-123?setup=1");
      });
    });
  });
});
