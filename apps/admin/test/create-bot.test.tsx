import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { CreateBotModal } from "../src/components/bots/CreateBotModal.js";
import { createBot } from "../src/api/bots.js";
import { createTenant } from "../src/api/tenants.js";
import { getTemplates } from "../src/api/templates.js";
import { readCreationDraft } from "../src/utils/onboarding-draft.js";

vi.mock("../src/api/bots.js", () => ({ createBot: vi.fn() }));
vi.mock("../src/api/tenants.js", () => ({ createTenant: vi.fn() }));
vi.mock("../src/api/templates.js", () => ({ getTemplates: vi.fn() }));
const tenant = {
  id: "tenant1",
  clientName: "Клиент",
  contactPhone: "+998901234567",
  status: "ACTIVE" as const,
  createdAt: "2026-10-14",
  botsCount: 0,
};
let client: QueryClient;
beforeEach(() => {
  localStorage.clear();
  vi.mocked(getTemplates).mockResolvedValue([
    {
      id: "restaurant_tables",
      name: "Ресторан",
      description: "Бронирование столов",
      botType: "QUICKBOOK",
    },
    {
      id: "education_center",
      name: "Учебный центр",
      description: "Заявки на занятия",
      botType: "LEADCATCH",
    },
  ]);
  vi.mocked(createBot).mockResolvedValue({
    id: "bot1",
    inviteLink: null,
    trialEndsAt: "2026-10-17T12:00:00Z",
  });
  vi.mocked(createTenant).mockResolvedValue({
    id: "new-client",
    clientName: "Новый клиент",
    contactPhone: "+998901234567",
    createdAt: "2026-10-14",
  });
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.clearAllMocks();
});
function renderForm(scope?: string) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CreateBotModal isOpen onClose={() => {}} tenants={[tenant]} draftScope={scope} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
async function openForm(
  type: "LEADCATCH" | "QUICKBOOK" = "LEADCATCH",
  waitForTemplates = true,
  scope?: string,
) {
  renderForm(scope);
  fireEvent.change(screen.getByLabelText("Клиент"), { target: { value: tenant.id } });
  fireEvent.click(screen.getByRole("button", { name: "Далее" }));
  if (type === "QUICKBOOK")
    fireEvent.click(screen.getByRole("button", { name: /Принимать записи/ }));
  fireEvent.click(screen.getByRole("button", { name: "Далее" }));
  if (waitForTemplates)
    await screen.findByRole("option", {
      name: type === "LEADCATCH" ? "Учебный центр" : "Ресторан",
    });
  fireEvent.change(screen.getByLabelText("Токен Telegram-бота (из @BotFather)"), {
    target: { value: "123456789:TestToken" },
  });
}

describe("Создание через мастер", () => {
  it("по умолчанию предлагает настройку с нуля и подключает бот приостановленным", async () => {
    await openForm("QUICKBOOK");
    expect((screen.getByLabelText("Начальная настройка") as HTMLSelectElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("На что принимаете запись?"), {
      target: { value: "ROOM" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Подключить и настроить" }));
    await waitFor(() =>
      expect(vi.mocked(createBot).mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          botType: "QUICKBOOK",
          templateId: undefined,
          resourceType: "ROOM",
          startPaused: true,
        }),
      ),
    );
  });
  it("передаёт выбранный шаблон в один запрос создания", async () => {
    await openForm("QUICKBOOK");
    expect(screen.queryByRole("option", { name: "Учебный центр" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Начальная настройка"), {
      target: { value: "restaurant_tables" },
    });
    expect(screen.getByText("Бронирование столов")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Подключить и настроить" }));
    await waitFor(() =>
      expect(vi.mocked(createBot).mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({ templateId: "restaurant_tables", resourceType: undefined }),
      ),
    );
    expect(createBot).toHaveBeenCalledOnce();
  });
  it("сбрасывает несовместимый шаблон при смене задачи", async () => {
    await openForm();
    fireEvent.change(screen.getByLabelText("Начальная настройка"), {
      target: { value: "education_center" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Назад" }));
    fireEvent.click(screen.getByRole("button", { name: /Принимать записи/ }));
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    expect((screen.getByLabelText("Начальная настройка") as HTMLSelectElement).value).toBe("");
    expect(screen.queryByRole("option", { name: "Учебный центр" })).toBeNull();
  });
  it("позволяет настройку с нуля при ошибке каталога", async () => {
    vi.mocked(getTemplates).mockRejectedValue(new TypeError("Failed to fetch"));
    await openForm("LEADCATCH", false);
    expect(await screen.findByText("Можно продолжить настройку с нуля.")).toBeTruthy();
  });
  it("восстанавливает шаг после возвращения, но не сохраняет токен", async () => {
    await openForm("QUICKBOOK", true, "admin-a");
    fireEvent.change(screen.getByLabelText("Начальная настройка"), {
      target: { value: "restaurant_tables" },
    });
    expect(localStorage.getItem("lcqb:onboarding:admin-a")).not.toContain("TestToken");
    cleanup();
    client.clear();
    renderForm("admin-a");
    expect(
      (screen.getByLabelText("Токен Telegram-бота (из @BotFather)") as HTMLInputElement).value,
    ).toBe("");
    expect((screen.getByLabelText("Начальная настройка") as HTMLSelectElement).value).toBe(
      "restaurant_tables",
    );
    expect(readCreationDraft("admin-b").step).toBe(0);
  });
  it("создаёт клиента один раз даже при ошибке подключения бота", async () => {
    renderForm("admin-a");
    fireEvent.click(screen.getByRole("button", { name: "Создать клиента" }));
    fireEvent.change(screen.getByLabelText("Имя клиента или компания"), {
      target: { value: "Новый клиент" },
    });
    fireEvent.change(screen.getByLabelText("Телефон клиента"), {
      target: { value: "+998901234567" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    await screen.findByText("Что должен делать бот?");
    fireEvent.click(screen.getByRole("button", { name: "Далее" }));
    fireEvent.change(screen.getByLabelText("Токен Telegram-бота (из @BotFather)"), {
      target: { value: "123456789:TestToken" },
    });
    vi.mocked(createBot).mockRejectedValue(new Error("Токен не принят"));
    fireEvent.click(screen.getByRole("button", { name: "Подключить и настроить" }));
    await screen.findByText("Токен не принят");
    fireEvent.click(screen.getByRole("button", { name: "Подключить и настроить" }));
    await waitFor(() => expect(createBot).toHaveBeenCalledTimes(2));
    expect(createTenant).toHaveBeenCalledOnce();
    expect(readCreationDraft("admin-a").tenantId).toBe("new-client");
  });
  it("предлагает продолжить уже созданный бот без повторного POST и позволяет начать новый", async () => {
    await openForm("LEADCATCH", true, "admin-a");
    fireEvent.click(screen.getByRole("button", { name: "Подключить и настроить" }));
    await screen.findByRole("button", { name: "Продолжить настройку" });
    cleanup();
    client.clear();
    renderForm("admin-a");
    expect(screen.getByRole("button", { name: "Продолжить настройку" })).toBeTruthy();
    expect(createBot).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Подключить другого бота" }));
    expect(screen.getByLabelText("Клиент")).toBeTruthy();
    expect(readCreationDraft("admin-a").createdBotId).toBeUndefined();
  });
});
