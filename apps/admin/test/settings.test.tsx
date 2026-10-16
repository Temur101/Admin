import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Link, Outlet, RouterProvider } from "react-router-dom";
import { UnsavedChangesProvider } from "../src/context/UnsavedChangesContext.js";
import { SettingsPage } from "../src/pages/SettingsPage.js";
import { getPlatformSettings, updatePlatformSettings } from "../src/api/settings.js";

vi.mock("../src/api/settings.js", () => ({
  getPlatformSettings: vi.fn(),
  updatePlatformSettings: vi.fn(),
  sendTestAlert: vi.fn(),
}));
const settings = {
  paymentDetails: "Карта",
  supportContact: "@support",
  maintenanceMode: false,
  alertChatId: "123",
  tariffs: [
    { months: 1, amountUzs: 100000 },
    { months: 6, amountUzs: 500000 },
    { months: 12, amountUzs: 900000 },
  ],
};
let client: QueryClient;
beforeEach(() => {
  vi.mocked(getPlatformSettings).mockResolvedValue(settings);
  vi.mocked(updatePlatformSettings).mockResolvedValue(settings);
});
afterEach(() => {
  cleanup();
  client?.clear();
  vi.clearAllMocks();
});
async function openSettings() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      {
        element: (
          <UnsavedChangesProvider>
            <Link to="/other">Другая страница</Link>
            <Outlet />
          </UnsavedChangesProvider>
        ),
        children: [
          { path: "/settings", element: <SettingsPage /> },
          { path: "/other", element: <p>Другая страница открыта</p> },
        ],
      },
    ],
    { initialEntries: ["/settings"] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  await screen.findByDisplayValue("Карта");
}
it("повторная загрузка настроек не заменяет несохранённую форму", async () => {
  await openSettings();
  fireEvent.change(screen.getByDisplayValue("Карта"), { target: { value: "Новые реквизиты" } });
  await act(async () => {
    client.setQueryData(["platform-settings"], { ...settings, paymentDetails: "Данные с сервера" });
  });
  expect(screen.getByDisplayValue("Новые реквизиты")).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "Другая страница" }));
  expect(await screen.findByText("Изменения не сохранены")).toBeTruthy();
});
it("успешное сохранение снимает защиту формы", async () => {
  await openSettings();
  fireEvent.change(screen.getByDisplayValue("Карта"), { target: { value: "Новые реквизиты" } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить настройки" }));
  await waitFor(() => expect(screen.queryByText("Есть несохранённые изменения")).toBeNull());
  expect(vi.mocked(updatePlatformSettings).mock.calls[0]?.[0].paymentDetails).toBe(
    "Новые реквизиты",
  );
  fireEvent.click(screen.getByRole("link", { name: "Другая страница" }));
  expect(await screen.findByText("Другая страница открыта")).toBeTruthy();
});
