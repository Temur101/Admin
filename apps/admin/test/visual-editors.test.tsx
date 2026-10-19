import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import {
  createEmptyQuickBookConfig,
  createEmptyQuizConfig,
  type QuickBookConfig,
} from "@lcqb/contracts";
import {
  createQuizChain,
  quizSetupIssues,
  validateQuizDag,
  bookingSetupIssues,
} from "@lcqb/contracts/validation";
import { BotScheduleEditorTab } from "../src/components/bots/BotScheduleEditorTab.js";
import { BotQuizEditorTab } from "../src/components/bots/BotQuizEditorTab.js";
import { UnsavedChangesProvider } from "../src/context/UnsavedChangesContext.js";
import { updateBotSettings } from "../src/api/templates.js";
import { previewBookingTimes } from "../src/utils/booking-preview.js";
import type { BotDetails } from "../src/api/bots.js";
vi.mock("../src/api/templates.js", () => ({ updateBotSettings: vi.fn() }));
const booking: QuickBookConfig = {
  ...createEmptyQuickBookConfig(),
  services: [
    { id: "s1", name: { ru: "Консультация", uz: "Maslahat" }, durationMin: 30, priceUzs: 0 },
    { id: "s2", name: { ru: "Обследование", uz: "Tekshiruv" }, durationMin: 45, priceUzs: 80000 },
  ],
  resources: [
    {
      id: "r1",
      name: { ru: "Врач", uz: "Shifokor" },
      workDays: [1, 2, 3, 4, 5],
      workHours: { start: "09:00", end: "18:00" },
    },
  ],
};
let client: QueryClient;
beforeEach(() =>
  vi.mocked(updateBotSettings).mockImplementation(async (_id, settings) => settings),
);
afterEach(() => {
  cleanup();
  client?.clear();
  vi.clearAllMocks();
});
function open(settings: unknown = booking, type: "LEADCATCH" | "QUICKBOOK" = "QUICKBOOK") {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const bot = { id: "bot1", settings, botType: type } as BotDetails;
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <UnsavedChangesProvider>
          {type === "QUICKBOOK" ? (
            <BotScheduleEditorTab bot={bot} />
          ) : (
            <BotQuizEditorTab bot={bot} />
          )}
        </UnsavedChangesProvider>
      ),
    },
  ]);
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}
function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
function save() {
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
}
describe("Визуальная настройка записи", () => {
  it("сохраняет произвольную длительность, перерыв и название категории", async () => {
    open();
    change("Услуга 1: длительность (мин)", "22");
    fireEvent.click(screen.getByRole("checkbox", { name: "Ресурс 1: добавить перерыв" }));
    change("Ресурс 1: начало перерыва", "12:00");
    change("Ресурс 1: окончание перерыва", "13:00");
    change("Название категории (RU)", "Врач");
    save();
    await waitFor(() =>
      expect(updateBotSettings).toHaveBeenCalledWith(
        "bot1",
        expect.objectContaining({
          resourceLabel: { ru: "Врач", uz: "Xodim" },
          services: expect.arrayContaining([expect.objectContaining({ durationMin: 22 })]),
          resources: [expect.objectContaining({ breakHours: { start: "12:00", end: "13:00" } })],
        }),
      ),
    );
  });
  it("показывает пустое назначение как все услуги и запрещает снять последний выбранный пункт", async () => {
    open({ ...booking, resources: [{ ...booking.resources[0], serviceIds: [] }] });
    const all = screen.getByRole("checkbox", {
      name: "Все услуги, включая добавленные позже",
    }) as HTMLInputElement;
    expect(all.checked).toBe(true);
    fireEvent.click(all);
    fireEvent.click(screen.getByRole("button", { name: "+ Обследование" }));
    fireEvent.click(screen.getByRole("button", { name: "✓ Консультация" }));
    expect(
      (screen.getByRole("button", { name: "✓ Обследование" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(all);
    save();
    await waitFor(() =>
      expect(updateBotSettings).toHaveBeenCalledWith(
        "bot1",
        expect.objectContaining({
          resources: [expect.objectContaining({ serviceIds: undefined })],
        }),
      ),
    );
  });
  it("дублирует расписание с новым идентификатором без общей ссылки на дни", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Дублировать ресурс 1" }));
    change("Ресурс 2: начало работы", "10:00");
    expect((screen.getByLabelText("Ресурс 1: начало работы") as HTMLInputElement).value).toBe(
      "09:00",
    );
    expect((screen.getByLabelText("Ресурс 2: начало работы") as HTMLInputElement).value).toBe(
      "10:00",
    );
  });
  it("после удаления услуги очищает назначения, а отмена удаления сохраняет её", async () => {
    open({ ...booking, resources: [{ ...booking.resources[0], serviceIds: ["s1", "s2"] }] });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Удалить услугу 1" }));
    expect(screen.getByLabelText("Услуга 2: название (RU)")).toBeTruthy();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Удалить услугу 1" }));
    save();
    await waitFor(() =>
      expect(updateBotSettings).toHaveBeenCalledWith(
        "bot1",
        expect.objectContaining({
          services: [expect.objectContaining({ id: "s2" })],
          resources: [expect.objectContaining({ serviceIds: ["s2"] })],
        }),
      ),
    );
  });
  it("блокирует сохранение ошибочного перерыва и показывает причину", () => {
    open();
    fireEvent.click(screen.getByRole("checkbox", { name: "Ресурс 1: добавить перерыв" }));
    change("Ресурс 1: окончание перерыва", "20:00");
    save();
    expect(updateBotSettings).not.toHaveBeenCalled();
    expect(screen.getAllByText(/перерыв должен находиться/).length).toBeGreaterThan(0);
  });
  it("применяет те же проверки к JSON, не отправляя неправильную цену", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    const invalid = { ...booking, services: [{ ...booking.services[0], priceUzs: -1 }] };
    fireEvent.change(screen.getByRole("textbox"), { target: { value: JSON.stringify(invalid) } });
    save();
    expect(updateBotSettings).not.toHaveBeenCalled();
    expect(screen.getByText(/цена — целое число от 0/)).toBeTruthy();
  });
});
describe("Настройка опросника", () => {
  it("создаёт связанный сценарий и показывает правильные номера переходов", async () => {
    open(createEmptyQuizConfig(), "LEADCATCH");
    fireEvent.click(screen.getByRole("button", { name: "Создать цепочку из 3 вопросов" }));
    const next = screen.getByLabelText("Вопрос 1, ответ 1: следующий шаг") as HTMLSelectElement;
    expect(next.selectedOptions[0]?.textContent).toBe("Вопрос 2: Новый вопрос 2");
    save();
    await waitFor(() => expect(updateBotSettings).toHaveBeenCalledOnce());
    const config = vi.mocked(updateBotSettings).mock.calls[0]![1];
    expect(quizSetupIssues(config)).toEqual([]);
    const preview = within(screen.getByRole("region", { name: "Предпросмотр диалога" }));
    for (let i = 0; i < 3; i++)
      fireEvent.click(preview.getByRole("button", { name: "Вариант ответа" }));
    expect(preview.getByText("Следующий шаг — контакт клиента")).toBeTruthy();
  });
  it("добавляет свой ответ с переходом и сохраняет тип через переключение JSON", async () => {
    const config = createQuizChain();
    open(config, "LEADCATCH");
    fireEvent.click(screen.getByRole("button", { name: "Вопрос 1: добавить свой ответ" }));
    expect(
      (screen.getByLabelText("Вопрос 1, ответ 2: тип ответа") as HTMLSelectElement).value,
    ).toBe("TEXT");
    expect(
      (screen.getByLabelText("Вопрос 1, ответ 2: следующий шаг") as HTMLSelectElement).value,
    ).toBe(config.nodes[1]!.id);
    fireEvent.click(screen.getByRole("button", { name: "JSON" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain(
      '"inputType": "TEXT"',
    );
    fireEvent.click(screen.getByRole("button", { name: "Визуальный" }));
    expect(
      (screen.getByLabelText("Вопрос 1, ответ 2: тип ответа") as HTMLSelectElement).value,
    ).toBe("TEXT");
    save();
    await waitFor(() => expect(updateBotSettings).toHaveBeenCalledOnce());
    const saved = vi.mocked(updateBotSettings).mock.calls[0]![1] as typeof config;
    expect(saved.nodes[0]!.options[1]).toEqual(
      expect.objectContaining({
        inputType: "TEXT",
        text: { ru: "Свой ответ", uz: "O‘z javobim" },
        nextNodeId: config.nodes[1]!.id,
      }),
    );
  });
  it("предпросмотр ждёт непустой текст своего ответа и продолжает выбранную ветку", () => {
    const config = createQuizChain();
    config.nodes[0]!.options.push({
      id: "custom",
      text: { ru: "Свой ответ", uz: "O‘z javobim" },
      inputType: "TEXT",
      nextNodeId: config.nodes[1]!.id,
    });
    open(config, "LEADCATCH");
    const preview = within(screen.getByRole("region", { name: "Предпросмотр диалога" }));
    fireEvent.click(preview.getByRole("button", { name: "Свой ответ" }));
    expect(preview.getByText("Новый вопрос 1")).toBeTruthy();
    fireEvent.click(preview.getByRole("button", { name: "Отправить ответ" }));
    expect(preview.getByText("Введите от 1 до 1000 символов.")).toBeTruthy();
    fireEvent.change(preview.getByLabelText("Ваш ответ"), {
      target: { value: "Можно другую услугу?" },
    });
    fireEvent.click(preview.getByRole("button", { name: "Отправить ответ" }));
    expect(preview.getByText("Новый вопрос 2")).toBeTruthy();
    expect(preview.getByText("Можно другую услугу?")).toBeTruthy();
    expect(updateBotSettings).not.toHaveBeenCalled();
  });
  it("возврат из текстового предпросмотра не отправляет черновик и доступен на UZ", () => {
    const config = createQuizChain();
    config.nodes[0]!.options[0]!.inputType = "TEXT";
    open(config, "LEADCATCH");
    const preview = within(screen.getByRole("region", { name: "Предпросмотр диалога" }));
    fireEvent.click(preview.getByRole("button", { name: "UZ" }));
    fireEvent.click(preview.getByRole("button", { name: "Javob varianti" }));
    fireEvent.change(preview.getByLabelText("Javobingiz"), { target: { value: "Boshqa savol" } });
    fireEvent.click(preview.getByRole("button", { name: "Variantlarga qaytish" }));
    expect(preview.getByText("Yangi savol 1")).toBeTruthy();
    expect(preview.queryByText("Boshqa savol")).toBeNull();
    fireEvent.click(preview.getByRole("button", { name: "Javob varianti" }));
    expect((preview.getByLabelText("Javobingiz") as HTMLTextAreaElement).value).toBe("");
  });
  it("можно превратить обычную кнопку в свой ответ и обратно", () => {
    open(createQuizChain(), "LEADCATCH");
    const type = screen.getByLabelText("Вопрос 1, ответ 1: тип ответа");
    fireEvent.change(type, { target: { value: "TEXT" } });
    const preview = within(screen.getByRole("region", { name: "Предпросмотр диалога" }));
    fireEvent.click(preview.getByRole("button", { name: "Вариант ответа" }));
    expect(preview.getByLabelText("Ваш ответ")).toBeTruthy();
    fireEvent.change(type, { target: { value: "CHOICE" } });
    const updatedPreview = within(screen.getByRole("region", { name: "Предпросмотр диалога" }));
    fireEvent.click(updatedPreview.getByRole("button", { name: "Вариант ответа" }));
    expect(updatedPreview.getByText("Новый вопрос 2")).toBeTruthy();
  });
  it("объясняет круговой переход и не сохраняет такой опрос", () => {
    const config = createQuizChain();
    config.nodes[2]!.options[0]!.nextNodeId = config.startNodeId;
    open(config, "LEADCATCH");
    save();
    expect(updateBotSettings).not.toHaveBeenCalled();
    const preview = within(screen.getByRole("region", { name: "Предпросмотр диалога" }));
    for (let i = 0; i < 3; i++)
      fireEvent.click(preview.getByRole("button", { name: "Вариант ответа" }));
    expect(preview.getByText(/Найден круговой переход/)).toBeTruthy();
  });
  it("после смены первого вопроса предпросмотр начинает с нового старта", () => {
    open(createQuizChain(), "LEADCATCH");
    fireEvent.click(screen.getAllByRole("button", { name: "Сделать стартом" })[0]!);
    const preview = within(screen.getByRole("region", { name: "Предпросмотр диалога" }));
    expect(preview.getByText("Новый вопрос 2")).toBeTruthy();
  });
});
describe("Проверки сценария", () => {
  it("выявляет ранний терминальный ответ рядом с правильной веткой", () => {
    const config = createQuizChain();
    config.nodes[0]!.options.push({
      id: "early",
      text: { ru: "Пропустить", uz: "Skip" },
      nextNodeId: null,
    });
    expect(validateQuizDag(config).errors.join(" ")).toContain("too short");
    expect(quizSetupIssues(config).join(" ")).toContain("раньше третьего");
  });
  it("предпросмотр исключает пересечение услуги с перерывом и учитывает день и назначения", () => {
    const config = {
      ...booking,
      resources: [
        {
          ...booking.resources[0]!,
          breakHours: { start: "12:00", end: "13:00" },
          serviceIds: ["s2"],
        },
      ],
    };
    const times = previewBookingTimes(config, "s2", "r1", 1);
    expect(times).toContain("11:00");
    expect(times).not.toContain("11:30");
    expect(times).not.toContain("12:30");
    expect(times).toContain("13:00");
    expect(previewBookingTimes(config, "s2", "r1", 0)).toEqual([]);
    expect(previewBookingTimes(config, "s1", "r1", 1)).toEqual([]);
  });
  it("не считает готовой услугу длиннее любого свободного участка расписания", () => {
    const config = {
      ...booking,
      services: [{ ...booking.services[0]!, durationMin: 480 }],
      resources: [{ ...booking.resources[0]!, breakHours: { start: "12:00", end: "13:00" } }],
    };
    expect(bookingSetupIssues(config).join(" ")).toContain("нет подходящего ресурса");
  });
});
