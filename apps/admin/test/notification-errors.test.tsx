import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NotificationFailures } from "../src/components/bots/NotificationFailures.js";
import { getFailedNotifications, retryNotification } from "../src/api/bots.js";
vi.mock("../src/api/bots.js", () => ({ getFailedNotifications: vi.fn(), retryNotification: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it("shows failed deliveries and requeues the selected notification", async () => {
  vi.mocked(getFailedNotifications).mockResolvedValue([{ id: "d1", botId: "b1", attempts: 5, lastError: "Telegram unavailable", createdAt: new Date().toISOString() }]);
  vi.mocked(retryNotification).mockResolvedValue();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><NotificationFailures botId="b1" count={1} /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole("button", { name: "Повторить доставку" }));
  await waitFor(() => expect(retryNotification).toHaveBeenCalledWith("d1", expect.anything()));
  expect(getFailedNotifications).toHaveBeenCalledWith("b1");
});
it("does not request the queue when there are no failures", () => {
  render(<QueryClientProvider client={new QueryClient()}><NotificationFailures botId="b1" count={0} /></QueryClientProvider>);
  expect(getFailedNotifications).not.toHaveBeenCalled();
});
