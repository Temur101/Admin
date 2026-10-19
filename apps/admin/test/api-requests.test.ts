import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest, ApiError, setStoredToken, getStoredToken } from "../src/api/client.js";
import { approveReceipt, rejectReceipt } from "../src/api/receipts.js";
import { launchBot } from "../src/api/bots.js";
const fetcher = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockResolvedValue(json({ ok: true }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
describe("HTTP запросы админки", () => {
  it.each(["approve", "launch"])("%s не отправляет заголовок JSON без тела", async (action) => {
    setStoredToken("local-test-token");
    await (action === "approve" ? approveReceipt("r1") : launchBot("b1"));
    const [url, options] = fetcher.mock.calls[0]!;
    expect(url).toBe(
      action === "approve" ? "/api/v1/receipts/r1/approve" : "/api/v1/bots/b1/launch",
    );
    expect(options?.method).toBe("POST");
    expect(options?.body).toBeUndefined();
    const headers = new Headers(options?.headers);
    expect(headers.has("content-type")).toBe(false);
    expect(headers.get("authorization")).toBe("Bearer local-test-token");
  });
  it("отправляет причину отклонения как JSON", async () => {
    await rejectReceipt("r1", { reason: "Платёж не найден" });
    const options = fetcher.mock.calls[0]![1]!;
    expect(new Headers(options.headers).get("content-type")).toBe("application/json");
    expect(JSON.parse(options.body as string)).toEqual({ reason: "Платёж не найден" });
  });
  it("удаляет даже явно заданный JSON заголовок у пустого запроса", async () => {
    await apiRequest("/api/v1/bots/b1/suspend", {
      method: "POST",
      body: "",
      headers: { "content-type": "application/json" },
    });
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).has("content-type")).toBe(false);
  });
  it("не навязывает JSON заголовок для FormData", async () => {
    const body = new FormData();
    body.append("name", "value");
    await apiRequest("/upload", { method: "POST", body });
    expect(new Headers(fetcher.mock.calls[0]![1]?.headers).has("content-type")).toBe(false);
  });
  it("обновляет авторизацию пустым POST и повторяет одобрение с новым токеном", async () => {
    setStoredToken("expired-test-token");
    fetcher
      .mockResolvedValueOnce(json({ ok: false, error: "Unauthorized" }, 401))
      .mockResolvedValueOnce(json({ ok: true, accessToken: "refreshed-test-token" }))
      .mockResolvedValueOnce(json({ ok: true }));
    await approveReceipt("r1");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/v1/auth/refresh");
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).has("content-type")).toBe(false);
    expect(new Headers(fetcher.mock.calls[2]?.[1]?.headers).get("authorization")).toBe(
      "Bearer refreshed-test-token",
    );
    expect(getStoredToken()).toBe("refreshed-test-token");
  });
  it("сохраняет сообщение сервера при ошибке модерации", async () => {
    fetcher.mockResolvedValue(json({ ok: false, error: "Чек уже отклонён" }, 409));
    await expect(approveReceipt("r1")).rejects.toMatchObject({
      statusCode: 409,
      message: "Чек уже отклонён",
      name: ApiError.name,
    });
  });
});
