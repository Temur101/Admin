import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { BotDetailsPage } from "../src/pages/BotDetailsPage.js";
import { UnsavedChangesProvider } from "../src/context/UnsavedChangesContext.js";
import { getBot, getBotHealth, type BotDetails } from "../src/api/bots.js";
import { applyTemplate, getTemplates, updateBotSettings } from "../src/api/templates.js";
import {
  createEmptyQuickBookConfig,
  createEmptyQuizConfig,
  type QuickBookConfig,
} from "@lcqb/contracts";

vi.mock("../src/api/bots.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api/bots.js")>()),
  getBot: vi.fn(),
  getBotHealth: vi.fn(),
}));
vi.mock("../src/api/templates.js", () => ({
  getTemplates: vi.fn(),
  applyTemplate: vi.fn(),
  updateBotSettings: vi.fn(),
}));

const initialConfig: QuickBookConfig = {
  resourceType: "STAFF",
  services: [
    { id: "s1", name: { ru: "Консультация", uz: "Maslahat" }, durationMin: 30, priceUzs: 10000 },
  ],
  resources: [
    {
      id: "r1",
      name: { ru: "Специалист", uz: "Mutaxassis" },
      workDays: [1],
      workHours: { start: "09:00", end: "18:00" },
    },
  ],
  slotIntervalMin: 30,
  bookingHorizonDays: 14,
  timezone: "Asia/Tashkent",
};
const bot: BotDetails = {
  id: "bot1",
  tenantId: "tenant1",
  tenantName: "Клиент",
  botType: "QUICKBOOK",
  botUsername: null,
  isActive: true,
  adminInviteCode: "code",
  createdAt: "2026-10-14T00:00:00Z",
  subscription: null,
  stats: { leadsCount: 0, bookingsCount: 0, usersCount: 0, receiptsCount: 0 },
  inviteLink: null,
  settings: initialConfig,
  admins: [],
};
let serverSettings: unknown;
let client: QueryClient;

beforeEach(() => {
  serverSettings = structuredClone(initialConfig);
  vi.mocked(getBot).mockImplementation(async () => ({ ...bot, settings: serverSettings }));
  vi.mocked(getBotHealth).mockResolvedValue({
    botId: bot.id,
    isActive: true,
    subscriptionStatus: "UNKNOWN",
    failedInboxCount: 0,
  });
  vi.mocked(updateBotSettings).mockImplementation(async (_id, settings) => {
    serverSettings = settings;
    return settings;
  });
  vi.mocked(getTemplates).mockResolvedValue([
    { id: "template", name: "Новый шаблон", description: "Описание", botType: "QUICKBOOK" },
  ]);
  vi.mocked(applyTemplate).mockImplementation(async () => {
    serverSettings = {
      ...initialConfig,
      services: [{ ...initialConfig.services[0], name: { ru: "Из шаблона", uz: "Shablon" } }],
    };
    return serverSettings;
  });
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.clearAllMocks();
});

async function openEditor() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      {
        element: (
          <UnsavedChangesProvider>
            <Outlet />
          </UnsavedChangesProvider>
        ),
        children: [
          { path: "/bots/:id", element: <BotDetailsPage /> },
          { path: "/bots", element: <p>Список ботов</p> },
        ],
      },
    ],
    { initialEntries: ["/bots/bot1"] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByText("Связь не проверена");
  fireEvent.click(screen.getByRole("button", { name: "Настройка бота" }));
}

function editService() {
  fireEvent.change(screen.getByDisplayValue("Консультация"), { target: { value: "Мой черновик" } });
}

describe("Защита настройки бота", () => {
  it("сохраняет черновик при переключении вкладок и отменяет выход", async () => {
    await openEditor();
    editService();
    fireEvent.click(screen.getByRole("button", { name: "Обзор" }));
    fireEvent.click(screen.getByRole("button", { name: "Настройка бота" }));
    expect(screen.getByDisplayValue("Мой черновик")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Все боты" }));
    await screen.findByText("Изменения не сохранены");
    fireEvent.click(screen.getByRole("button", { name: "Остаться" }));
    expect(screen.getByDisplayValue("Мой черновик")).toBeTruthy();
    expect(screen.queryByText("Список ботов")).toBeNull();
  });

  it("предупреждает при перезагрузке и разрешает подтверждённый выход", async () => {
    await openEditor();
    editService();
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole("link", { name: "Все боты" }));
    await screen.findByText("Изменения не сохранены");
    fireEvent.click(screen.getByRole("button", { name: "Уйти без сохранения" }));
    expect(await screen.findByText("Список ботов")).toBeTruthy();
  });

  it("после сохранения снимает предупреждение", async () => {
    await openEditor();
    editService();
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await screen.findByText("Расписание и услуги QuickBook успешно сохранены.");
    await waitFor(() => expect(screen.queryByText("Есть несохранённые изменения")).toBeNull());
    fireEvent.click(screen.getByRole("link", { name: "Все боты" }));
    expect(await screen.findByText("Список ботов")).toBeTruthy();
  });

  it("не стирает JSON при повторном выборе режима и не переключает неверную структуру", async () => {
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: '{"services": []}' } });
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    expect((input as HTMLTextAreaElement).value).toBe('{"services": []}');
    fireEvent.click(screen.getByRole("button", { name: "Визуальный" }));
    expect(screen.getByText(/Структура JSON не соответствует/)).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe('{"services": []}');
  });

  it("после явного применения шаблона заменяет прежний черновик", async () => {
    await openEditor();
    editService();
    fireEvent.click(screen.getByRole("button", { name: "Шаблоны" }));
    await screen.findByText("Новый шаблон");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Применить этот шаблон" }));
    await screen.findByText('Шаблон "Новый шаблон" успешно применен к боту!');
    fireEvent.click(screen.getByRole("button", { name: "Настройка бота" }));
    expect(screen.getByDisplayValue("Из шаблона")).toBeTruthy();
    expect(screen.queryByDisplayValue("Мой черновик")).toBeNull();
    expect(screen.queryByText("Есть несохранённые изменения")).toBeNull();
  });
});

it.each(["STAFF", "TABLE", "ROOM"] as const)(
  "пустой редактор %s добавляет ресурс нужного типа без мастеров",
  async (resourceType) => {
    serverSettings = createEmptyQuickBookConfig(resourceType);
    await openEditor();
    const add =
      resourceType === "STAFF"
        ? "Добавить сотрудника"
        : resourceType === "TABLE"
          ? "Добавить стол"
          : "Добавить помещение";
    expect(screen.queryByDisplayValue("Стрижка мужская")).toBeNull();
    expect(screen.getByText("Настройка с нуля")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: add }));
    const placeholder =
      resourceType === "STAFF"
        ? "Имя сотрудника (RU)"
        : resourceType === "TABLE"
          ? "Название стола (RU)"
          : "Название помещения (RU)";
    expect(screen.getByPlaceholderText(placeholder)).toBeTruthy();
    expect(screen.queryByText("Добавить мастера")).toBeNull();
  },
);

it("смена типа ресурсов меняет подписи и сохраняемое название категории", async () => {
  await openEditor();
  fireEvent.change(screen.getByLabelText("Тип ресурсов"), { target: { value: "TABLE" } });
  expect(screen.getByRole("button", { name: "Добавить стол" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await waitFor(() =>
    expect(updateBotSettings).toHaveBeenCalledWith(
      bot.id,
      expect.objectContaining({ resourceType: "TABLE", resourceLabel: { ru: "Стол", uz: "Stol" } }),
    ),
  );
});

it("первый вопрос пустого опросника автоматически становится стартовым", async () => {
  vi.mocked(getBot).mockImplementation(async () => ({
    ...bot,
    botType: "LEADCATCH",
    settings: createEmptyQuizConfig(),
  }));
  await openEditor();
  fireEvent.click(screen.getByRole("button", { name: "Добавить вопрос" }));
  expect(screen.getByText("Старт")).toBeTruthy();
  expect(screen.getAllByText("Новый вопрос 1").length).toBeGreaterThan(0);
});
