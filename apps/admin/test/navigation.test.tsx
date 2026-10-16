import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { getReceipts } from "../src/api/receipts.js";
import { AdminLayout } from "../src/components/layout/AdminLayout.js";

vi.mock("../src/api/receipts.js", () => ({ getReceipts: vi.fn().mockResolvedValue([]) }));
vi.mock("../src/context/AuthContext.js", () => ({
  useAuth: () => ({ user: { name: "Администратор", email: "owner@example.com" }, logout: vi.fn() }),
}));
let client: QueryClient;
beforeEach(() => {
  vi.mocked(getReceipts).mockResolvedValue([]);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      {
        element: <AdminLayout />,
        children: [
          { path: "/dashboard", element: <h1>Обзор платформы</h1> },
          { path: "/tenants", element: <h1>Список клиентов</h1> },
        ],
      },
    ],
    { initialEntries: ["/dashboard"] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
});
afterEach(() => {
  cleanup();
  client.clear();
});

it("открывает меню по кнопке и закрывает после перехода к клиентам", async () => {
  expect(screen.queryByRole("button", { name: "Закрыть навигацию" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Открыть меню" }));
  expect(screen.getByRole("button", { name: "Закрыть навигацию" })).toBeTruthy();
  fireEvent.click(screen.getByRole("link", { name: "Клиенты" }));
  expect(await screen.findByRole("heading", { name: "Список клиентов" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Закрыть навигацию" })).toBeNull();
});
it("закрывает открытое меню клавишей Escape", () => {
  fireEvent.click(screen.getByRole("button", { name: "Открыть меню" }));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("button", { name: "Закрыть навигацию" })).toBeNull();
});
