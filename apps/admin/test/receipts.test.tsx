import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReceiptsPage } from "../src/pages/ReceiptsPage.js";
import {
  getReceipts,
  approveReceipt,
  rejectReceipt,
  type ReceiptItem,
} from "../src/api/receipts.js";
vi.mock("../src/api/receipts.js", () => ({
  getReceipts: vi.fn(),
  approveReceipt: vi.fn(),
  rejectReceipt: vi.fn(),
  getReceiptImageUrl: (id: string) => `/test-image/${id}`,
}));
const receipt: ReceiptItem = {
  id: "r1",
  botId: "b1",
  botUsername: "test_bot",
  botType: "LEADCATCH",
  tenantName: "Клиент",
  submittedByTgId: "42",
  kind: "TEXT",
  imagePath: null,
  textNote: "Оплата за подписку.\nНомер перевода: 1234567890",
  months: 1,
  amount: 100000,
  status: "PENDING",
  createdAt: "2026-10-16T10:00:00Z",
};
let client: QueryClient;
beforeEach(() => {
  vi.mocked(getReceipts).mockResolvedValue([receipt]);
  vi.mocked(approveReceipt).mockResolvedValue(undefined);
  vi.mocked(rejectReceipt).mockResolvedValue(undefined);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.clearAllMocks();
});
async function open() {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ReceiptsPage />
    </QueryClientProvider>,
  );
  await screen.findByText("Клиент");
}
describe("Модерация оплаты", () => {
  it("открывает полный текст с сохранением переносов строк", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Открыть текст" }));
    const modal = within(screen.getByRole("dialog", { name: "Детали оплаты" }));
    expect(modal.getByText(/Номер перевода: 1234567890/).textContent).toBe(receipt.textNote);
  });
  it("показывает комментарий вместе с изображением и объясняет ошибку загрузки", async () => {
    vi.mocked(getReceipts).mockResolvedValue([
      {
        ...receipt,
        kind: "PHOTO",
        imagePath: "receipt.png",
        textNote: "Перевод с карты владельца",
      },
    ]);
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Скриншот" }));
    const modal = within(screen.getByRole("dialog"));
    expect(modal.getByText("Перевод с карты владельца")).toBeTruthy();
    fireEvent.error(modal.getByRole("img", { name: "Чек оплаты" }));
    expect(modal.getByText(/Не удалось загрузить изображение/)).toBeTruthy();
  });
  it("показывает успех только после успешного одобрения и обновляет связанные данные", async () => {
    await open();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    fireEvent.click(screen.getByRole("button", { name: "Одобрить" }));
    expect(await screen.findByText("Оплата подтверждена. Данные подписки обновлены.")).toBeTruthy();
    expect(approveReceipt).toHaveBeenCalledWith("r1");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["bots"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard-metrics"] });
  });
  it("не показывает успех при ошибке одобрения", async () => {
    vi.mocked(approveReceipt).mockRejectedValue(new Error("Сервер не смог подтвердить чек"));
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Одобрить" }));
    expect(await screen.findByText("Сервер не смог подтвердить чек")).toBeTruthy();
    expect(screen.queryByText("Оплата подтверждена. Данные подписки обновлены.")).toBeNull();
  });
  it("сохраняет причину при ошибке отклонения и позволяет повторить запрос", async () => {
    vi.mocked(rejectReceipt).mockRejectedValueOnce(new Error("Не удалось отклонить чек"));
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Отклонить" }));
    fireEvent.change(screen.getByLabelText("Причина отклонения чека"), {
      target: { value: "Платёж не поступил" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Отклонить чек" }));
    expect(await screen.findByText("Не удалось отклонить чек")).toBeTruthy();
    expect((screen.getByLabelText("Причина отклонения чека") as HTMLTextAreaElement).value).toBe(
      "Платёж не поступил",
    );
    fireEvent.click(screen.getByRole("button", { name: "Отклонить чек" }));
    expect(await screen.findByText("Чек отклонен, срок подписки скорректирован.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("блокирует обе операции, пока одобрение в процессе", async () => {
    let complete: () => void = () => {};
    vi.mocked(approveReceipt).mockReturnValue(
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
    );
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Одобрить" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Отклонить" }) as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    complete();
    await screen.findByText("Оплата подтверждена. Данные подписки обновлены.");
  });
  it("объясняет ошибку получения списка вместо сообщения об отсутствии чеков", async () => {
    vi.mocked(getReceipts).mockRejectedValue(new Error("Не удалось получить список чеков"));
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ReceiptsPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("Не удалось получить список чеков")).toBeTruthy();
    expect(screen.queryByText("Чеки с выбранным статусом отсутствуют.")).toBeNull();
    expect(screen.getByRole("button", { name: "Повторить загрузку" })).toBeTruthy();
  });
});
