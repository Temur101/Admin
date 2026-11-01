import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import type { BotDetails } from "../src/api/bots.js";
import { updateBotSettings } from "../src/api/templates.js";
import { BotScheduleEditorTab } from "../src/components/bots/BotScheduleEditorTab.js";
import { UnsavedChangesProvider } from "../src/context/UnsavedChangesContext.js";
vi.mock("../src/api/templates.js", () => ({
  updateBotSettings: vi.fn(async (_id, settings) => settings),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const initial = {
  id: "bot1",
  botType: "QUICKBOOK",
  settingsRevision: "revision-A",
  settings: {
    resourceType: "STAFF",
    slotIntervalMin: 30,
    bookingHorizonDays: 14,
    minLeadMinutes: 60,
    timezone: "Asia/Tashkent",
    services: [{ id: "s1", name: { ru: "Стрижка", uz: "Soch" }, durationMin: 30, priceUzs: 50000 }],
    resources: [
      {
        id: "r1",
        name: { ru: "Мастер", uz: "Usta" },
        workDays: [1, 2, 3, 4, 5],
        workHours: { start: "09:00", end: "18:00" },
      },
    ],
  },
} as unknown as BotDetails;
function open() {
  let setBot: (bot: BotDetails) => void;
  function Page() {
    const [bot, update] = useState(initial);
    setBot = update;
    return (
      <UnsavedChangesProvider>
        <BotScheduleEditorTab bot={bot} />
      </UnsavedChangesProvider>
    );
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: "/", element: <Page /> }]);
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  const refreshed = {
    ...initial,
    settingsRevision: "revision-B",
    settings: {
      ...(initial.settings as Record<string, unknown>),
      resources: [
        {
          id: "r1",
          name: { ru: "Мастер", uz: "Usta" },
          workDays: [1, 2, 3, 4, 5],
          workHours: { start: "10:00", end: "18:00" },
        },
      ],
    },
  } as BotDetails;
  return () => act(() => setBot(refreshed));
}
describe("Editor revision belongs to the visible form", () => {
  it("does not attach a newer background revision to unsaved old data", async () => {
    const refresh = open();
    fireEvent.change(screen.getByLabelText("Услуга 1: длительность (мин)"), {
      target: { value: "22" },
    });
    refresh();
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(updateBotSettings).toHaveBeenCalledWith(
        "bot1",
        expect.objectContaining({
          resources: [expect.objectContaining({ workHours: { start: "09:00", end: "18:00" } })],
        }),
        "revision-A",
      ),
    );
  });
  it("refreshes a clean form and its revision together", async () => {
    const refresh = open();
    refresh();
    await waitFor(() =>
      expect((screen.getByLabelText("Ресурс 1: начало работы") as HTMLInputElement).value).toBe(
        "10:00",
      ),
    );
    fireEvent.change(screen.getByLabelText("Услуга 1: длительность (мин)"), {
      target: { value: "22" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    await waitFor(() =>
      expect(updateBotSettings).toHaveBeenCalledWith(
        "bot1",
        expect.objectContaining({
          resources: [expect.objectContaining({ workHours: { start: "10:00", end: "18:00" } })],
        }),
        "revision-B",
      ),
    );
  });
});
