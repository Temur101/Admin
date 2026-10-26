import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { createEmptyQuizConfig, type QuizConfig, type QuickBookConfig } from "@lcqb/contracts";
import { BotLaunchWizard } from "../src/components/bots/onboarding/BotLaunchWizard.js";
import { BotOverviewTab } from "../src/components/bots/BotOverviewTab.js";
import { BotsPage } from "../src/pages/BotsPage.js";
import { UnsavedChangesProvider } from "../src/context/UnsavedChangesContext.js";
import { checkBotSetup, launchBot, getBotHealth, getBots, type BotDetails } from "../src/api/bots.js";
import { getTenants } from "../src/api/tenants.js";
import { updateBotSettings } from "../src/api/templates.js";
import {
  readSetupStep,
  saveCreationDraft,
  newCreationDraft,
  readCreationDraft,
} from "../src/utils/onboarding-draft.js";

vi.mock("../src/api/bots.js", async (original) => ({
  ...(await original<typeof import("../src/api/bots.js")>()),
  checkBotSetup: vi.fn(),
  launchBot: vi.fn(),
  getBotHealth: vi.fn(),
  getBots: vi.fn(),
}));
vi.mock("../src/api/tenants.js", () => ({
  getTenants: vi.fn().mockResolvedValue([]),
  createTenant: vi.fn(),
}));
vi.mock("../src/api/templates.js", () => ({
  updateBotSettings: vi.fn(),
  getTemplates: vi.fn(),
  applyTemplate: vi.fn(),
}));
const booking: QuickBookConfig = {
  resourceType: "STAFF",
  resourceLabel: { ru: "Сотрудник", uz: "Xodim" },
  services: [
    { id: "s1", name: { ru: "Консультация", uz: "Maslahat" }, durationMin: 30, priceUzs: 0 },
  ],
  resources: [
    {
      id: "r1",
      name: { ru: "Сотрудник", uz: "Xodim" },
      workDays: [1],
      workHours: { start: "09:00", end: "18:00" },
    },
  ],
  slotIntervalMin: 30,
  bookingHorizonDays: 14,
  timezone: "Asia/Tashkent",
};
const quiz: QuizConfig = {
  ...createEmptyQuizConfig(),
  startNodeId: "q1",
  nodes: [1, 2, 3].map((number) => ({
    id: `q${number}`,
    title: { ru: `Вопрос ${number}`, uz: `Savol ${number}` },
    options: [
      {
        id: `o${number}`,
        text: { ru: "Ответ", uz: "Javob" },
        nextNodeId: number < 3 ? `q${number + 1}` : null,
      },
    ],
  })),
};
const bot: BotDetails = {
  id: "bot1",
  tenantId: "tenant1",
  tenantName: "Клиент",
  botType: "QUICKBOOK",
  botUsername: "example_bot",
  isActive: false,
  adminInviteCode: "test",
  createdAt: "2026-10-14",
  subscription: { status: "TRIAL", trialEndsAt: "2026-10-17", paidUntil: null },
  stats: { leadsCount: 0, bookingsCount: 0, usersCount: 0, receiptsCount: 0 },
  settings: booking,
  admins: [],
  inviteLink: "https://t.me/example_bot?start=adm_test",
};
let client: QueryClient;
beforeEach(() => {
  localStorage.clear();
  vi.mocked(checkBotSetup).mockResolvedValue({
    configurationReady: true,
    telegramReady: true,
    canLaunch: true,
    errors: [],
    checkedAt: "2026-10-14T12:00:00Z",
  });
  vi.mocked(launchBot).mockResolvedValue(undefined);
  vi.mocked(getBotHealth).mockResolvedValue({
    botId: "bot1",
    isActive: true,
    subscriptionStatus: "TRIAL",
    failedInboxCount: 0,
    connection: {
      mode: "polling",
      status: "READY",
      message: "Подключение проверено",
      checkedAt: "2026-10-14",
    },
  });
  vi.mocked(updateBotSettings).mockImplementation(async (_id, settings) => settings);
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.clearAllMocks();
});
function openWizard(type: "LEADCATCH" | "QUICKBOOK" = "QUICKBOOK") {
  const selected = { ...bot, botType: type, settings: type === "LEADCATCH" ? quiz : booking };
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["bot", bot.id], selected);
  const router = createMemoryRouter(
    [
      {
        element: (
          <UnsavedChangesProvider>
            <Outlet />
          </UnsavedChangesProvider>
        ),
        children: [
          { path: "/setup", element: <BotLaunchWizard bot={selected} draftScope="admin-a" /> },
          { path: "/bots/:id", element: <p>Карточка бота</p> },
        ],
      },
    ],
    { initialEntries: ["/setup"] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}
async function advanceToCheck() {
  fireEvent.click(screen.getByRole("button", { name: "Перейти к проверке" }));
  await screen.findByText("Можно запускать");
}

describe("Настройка → проверка → запуск", () => {
  it.each(["LEADCATCH", "QUICKBOOK"] as const)(
    "проводит %s до подтверждённой проверки диалога",
    async (type) => {
      saveCreationDraft("admin-a", { ...newCreationDraft(), createdBotId: bot.id });
      openWizard(type);
      expect(launchBot).not.toHaveBeenCalled();
      await advanceToCheck();
      fireEvent.click(screen.getByRole("button", { name: "Перейти к запуску" }));
      fireEvent.click(screen.getByRole("button", { name: "Запустить бота" }));
      expect(await screen.findByText("Бот включён")).toBeTruthy();
      const finish = screen.getByRole("button", {
        name: "Завершить настройку",
      }) as HTMLButtonElement;
      expect(finish.disabled).toBe(true);
      expect(
        screen.getByRole("link", { name: "Проверить диалог в Telegram" }).getAttribute("href"),
      ).toBe("https://t.me/example_bot");
      const checkboxes = screen.getAllByRole("checkbox");
      expect(checkboxes).toHaveLength(1);
      fireEvent.click(screen.getByRole("checkbox", { name: "Я проверил диалог в Telegram" }));
      fireEvent.click(finish);
      expect(await screen.findByText("Карточка бота")).toBeTruthy();
      expect(readCreationDraft("admin-a").createdBotId).toBeUndefined();
      expect(launchBot).toHaveBeenCalledOnce();
    },
  );
  it("не позволяет перейти к проверке с несохранёнными изменениями", async () => {
    openWizard();
    fireEvent.change(screen.getByDisplayValue("Консультация"), { target: { value: "Изменено" } });
    expect(
      (screen.getByRole("button", { name: "Перейти к проверке" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Перейти к проверке" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    expect(checkBotSetup).not.toHaveBeenCalled();
  });
  it("сохраняет шаг проверки и восстанавливает его после возвращения", async () => {
    openWizard();
    await advanceToCheck();
    expect(readSetupStep("admin-a", bot.id)).toBe(4);
    cleanup();
    client.clear();
    openWizard();
    expect(await screen.findByText("Проверка перед запуском")).toBeTruthy();
    expect(readSetupStep("admin-b", bot.id)).toBe(3);
  });
  it("блокирует запуск при замечаниях проверки", async () => {
    vi.mocked(checkBotSetup).mockResolvedValue({
      configurationReady: false,
      telegramReady: true,
      canLaunch: false,
      errors: ["Добавьте ресурсы"],
      checkedAt: "2026-10-14",
    });
    openWizard();
    fireEvent.click(screen.getByRole("button", { name: "Перейти к проверке" }));
    expect(await screen.findByText("Добавьте ресурсы")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Перейти к запуску" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(launchBot).not.toHaveBeenCalled();
  });
  it("не использует старую успешную проверку после сетевой ошибки", async () => {
    openWizard();
    await advanceToCheck();
    vi.mocked(checkBotSetup).mockRejectedValue(new TypeError("Failed to fetch"));
    fireEvent.click(screen.getByRole("button", { name: "Проверить ещё раз" }));
    await screen.findByText(/Не удалось связаться с сервером/);
    expect(screen.queryByText("Можно запускать")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Перейти к запуску" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it("не показывает включённый бот после ошибки запуска", async () => {
    vi.mocked(launchBot).mockRejectedValue(new Error("Не удалось запустить"));
    openWizard();
    await advanceToCheck();
    fireEvent.click(screen.getByRole("button", { name: "Перейти к запуску" }));
    fireEvent.click(screen.getByRole("button", { name: "Запустить бота" }));
    expect(await screen.findByText("Не удалось запустить")).toBeTruthy();
    expect(screen.queryByText("Бот включён")).toBeNull();
    expect(readSetupStep("admin-a", bot.id)).toBe(5);
  });
  it("отображает раздельные счётчики администраторов и пользователей в BotsPage и BotOverviewTab", async () => {
    const botWithCounts: BotDetails = {
      ...bot,
      stats: { leadsCount: 2, bookingsCount: 5, usersCount: 3, adminsCount: 1, receiptsCount: 0 },
    };
    vi.mocked(getBots).mockResolvedValue([botWithCounts]);
    vi.mocked(getTenants).mockResolvedValue([]);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter(
      [
        {
          path: "/bots",
          element: (
            <div>
              <BotsPage />
              <BotOverviewTab bot={botWithCounts} />
            </div>
          ),
        },
      ],
      { initialEntries: ["/bots"] },
    );
    render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Админы / Пользователи")).toBeTruthy();
    expect(await screen.findByText("1 адм. · 3 польз.")).toBeTruthy();
    expect(await screen.findByText("1 администраторов · 3 пользователей в боте")).toBeTruthy();
  });
});
