import { PrismaClient } from "@prisma/client";
import { env } from "../../src/core/env.js";
import { createRedisClient, type Redis } from "../../src/core/redis.js";
import { pino } from "pino";

const nullLogger = pino({ level: "silent" });

/**
 * Validates that test environment variables are safely configured.
 * Aborts immediately if:
 * 1. TEST_DATABASE_URL is missing or empty.
 * 2. TEST_REDIS_URL is missing or empty.
 * 3. TEST_DATABASE_URL matches DATABASE_URL.
 * 4. TEST_REDIS_URL matches REDIS_URL.
 * 5. TEST_DATABASE_URL does not contain "test" in URL.
 */
export function assertTestEnvironment(): void {
  if (process.env.NODE_ENV !== "test") {
    process.env.NODE_ENV = "test";
  }

  const testDb = env.TEST_DATABASE_URL?.trim();
  const devDb = env.DATABASE_URL?.trim();

  if (!testDb) {
    throw new Error(
      "FATAL (B00): TEST_DATABASE_URL is not set or empty. Tests cannot run to protect dev/prod databases."
    );
  }

  if (testDb === devDb) {
    throw new Error(
      "FATAL (B00): TEST_DATABASE_URL matches DATABASE_URL. Refusing to run tests to prevent wiping dev/prod database."
    );
  }

  const dbUrlLower = testDb.toLowerCase();
  if (!dbUrlLower.includes("test")) {
    throw new Error(
      `FATAL (B00): TEST_DATABASE_URL does not appear to be a test database (missing 'test' in URL: ${testDb}). Refusing to run.`
    );
  }

  const testRedis = env.TEST_REDIS_URL?.trim();
  const devRedis = env.REDIS_URL?.trim();

  if (!testRedis) {
    throw new Error(
      "FATAL (B00): TEST_REDIS_URL is not set or empty. Tests cannot run to protect dev/prod Redis."
    );
  }

  if (testRedis === devRedis) {
    throw new Error(
      "FATAL (B00): TEST_REDIS_URL matches REDIS_URL. Refusing to run tests to prevent wiping dev/prod Redis."
    );
  }
}

let sharedTestPrisma: PrismaClient | null = null;

export function getTestPrismaClient(): PrismaClient {
  assertTestEnvironment();
  if (!sharedTestPrisma) {
    let url = env.TEST_DATABASE_URL;
    if (!url.includes("connection_limit=")) {
      const sep = url.includes("?") ? "&" : "?";
      url = `${url}${sep}connection_limit=10`;
    }
    sharedTestPrisma = new PrismaClient({
      datasources: { db: { url } },
      log: ["error"],
    });
  }
  return sharedTestPrisma;
}

export function createTestRedisClient(name = "test-redis"): Redis {
  assertTestEnvironment();
  return createRedisClient({
    url: env.TEST_REDIS_URL,
    logger: nullLogger,
    name,
  });
}

export async function safeCleanTestDb(prisma: PrismaClient): Promise<void> {
  assertTestEnvironment();
  await prisma.webhookInbox.deleteMany();
  await prisma.booking.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.paymentReceipt.deleteMany();
  await prisma.botUser.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.bot.deleteMany();
  await prisma.tenant.deleteMany();
}

export async function safeCleanTestRedis(redis: Redis): Promise<void> {
  assertTestEnvironment();
  const clientOptions = (redis as unknown as { options?: { url?: string } }).options;
  const clientUrl = clientOptions?.url ?? "";
  if (clientUrl && clientUrl === env.REDIS_URL) {
    throw new Error("FATAL (B00): Refusing to flush Redis because client URL matches dev REDIS_URL!");
  }
  await redis.flushdb();
}
