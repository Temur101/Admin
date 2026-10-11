import { describe, expect, it } from "vitest";
import { assertTestEnvironment, safeCleanTestRedis } from "./helpers/test-env.js";
import { createPrismaClient } from "../src/core/prisma.js";
import { createRedisClient } from "../src/core/redis.js";
import { env } from "../src/core/env.js";
import { logger } from "../src/core/logger.js";

describe("B00: Safe Test Environment Verification", () => {
  it("1. should succeed with valid test credentials and separate URLs", () => {
    expect(() => assertTestEnvironment()).not.toThrow();
    expect(env.TEST_DATABASE_URL).not.toBe(env.DATABASE_URL);
    expect(env.TEST_REDIS_URL).not.toBe(env.REDIS_URL);
    expect(env.TEST_DATABASE_URL.toLowerCase()).toContain("test");
  });

  it("2. createPrismaClient should reject connection to dev/prod DATABASE_URL during tests", () => {
    expect(() => {
      createPrismaClient(env.DATABASE_URL);
    }).toThrow(/Safety check failed/i);
  });

  it("3. createPrismaClient should reject database URL without 'test' during tests", () => {
    expect(() => {
      createPrismaClient("postgresql://user:pass@127.0.0.1:5432/my_production_db");
    }).toThrow(/Safety check failed/i);
  });

  it("4. createRedisClient should reject connection to dev/prod REDIS_URL during tests", () => {
    expect(() => {
      createRedisClient({
        url: env.REDIS_URL,
        logger,
        name: "malicious-test-redis",
      });
    }).toThrow(/Safety check failed/i);
  });

  it("5. safeCleanTestRedis should reject flushing if client URL points to dev REDIS_URL", async () => {
    const fakeClient = {
      options: { url: env.REDIS_URL },
      flushdb: async () => "OK",
    } as unknown as Parameters<typeof safeCleanTestRedis>[0];

    await expect(safeCleanTestRedis(fakeClient)).rejects.toThrow(/Refusing to flush Redis/i);
  });
});
