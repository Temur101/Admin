import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/client.js";
import { describeApiError } from "../src/utils/api-errors.js";
import { formatPlatformDate } from "../src/utils/dates.js";

describe("Понятные ошибки и даты", () => {
  it("показывает детали графа из ответа API", () => {
    const result = describeApiError(
      new ApiError(400, {
        ok: false,
        error: "Quiz DAG validation failed",
        details: ["Cycle detected: q1 -> q2 -> q1"],
      }),
    );
    expect(result.message).toContain("Проверьте переходы");
    expect(result.details).toEqual(["Cycle detected: q1 -> q2 -> q1"]);
  });
  it("указывает конкретное поле и номер услуги", () => {
    const result = describeApiError(
      new ApiError(400, {
        ok: false,
        error: "Invalid QuickBook configuration schema",
        issues: [
          {
            path: ["services", 0, "name", "uz"],
            code: "too_small",
            minimum: 1,
            message: "String must contain at least 1 character(s)",
          },
        ],
      }),
    );
    expect(result.details[0]).toContain("Услуги → №1 → Название → Узбекский");
    expect(result.details[0]).toContain("Заполните поле");
  });
  it("объясняет ограничение запросов и сетевую ошибку", () => {
    expect(
      describeApiError(new ApiError(429, { ok: false, error: "Too Many Requests" })).message,
    ).toContain("Подождите");
    expect(describeApiError(new TypeError("Failed to fetch")).message).toContain(
      "Не удалось связаться",
    );
  });
  it("показывает окончание триала в Ташкенте, включая смену даты", () => {
    expect(formatPlatformDate("2026-10-14T21:30:00Z")).toBe("15.10.2026, 02:30");
  });
});
