import { describe, expect, it } from "vitest";
import { buildApp } from "../src/index.js";

describe("Health Route", () => {
  it("should return 200 and ok status", async () => {
    const app = await buildApp();
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; timestamp: string; uptime: number }>();
    expect(body.status).toBe("ok");
    expect(typeof body.timestamp).toBe("string");
    expect(typeof body.uptime).toBe("number");
    await app.close();
  });
});
