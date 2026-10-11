import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { connectRedis, type Redis } from "../src/core/redis.js";
import {
  acquireSlotLock,
  isSlotLocked,
  releaseSlotLock,
} from "../src/bots/quickbook/slot-lock.js";
import { createTestRedisClient, safeCleanTestRedis } from "./helpers/test-env.js";

let redis: Redis;

describe("QuickBook Distributed Slot Lock Tests", () => {
  const botId = "bot_lock_test";
  const staffId = "staff_alisher";
  const slotTime = new Date("2026-10-15T10:00:00Z");

  beforeAll(async () => {
    redis = createTestRedisClient("test-lock");
    await connectRedis(redis);
  });

  afterAll(async () => {
    if (redis && redis.status !== "end") {
      await redis.quit();
    }
  });

  beforeEach(async () => {
    await safeCleanTestRedis(redis);
  });

  it("1. should acquire slot lock successfully for first user", async () => {
    const res = await acquireSlotLock(redis, {
      botId,
      staffId,
      slotTime,
      userId: 1001,
      ttlSec: 10,
    });

    expect(res.acquired).toBe(true);
    const locked = await isSlotLocked(redis, botId, staffId, slotTime);
    expect(locked).toBe(true);
  });

  it("2. should reject second user while lock is held", async () => {
    // User 1 acquires lock
    const res1 = await acquireSlotLock(redis, {
      botId,
      staffId,
      slotTime,
      userId: 1001,
      ttlSec: 10,
    });
    expect(res1.acquired).toBe(true);

    // User 2 attempts to acquire same slot
    const res2 = await acquireSlotLock(redis, {
      botId,
      staffId,
      slotTime,
      userId: 2002,
      ttlSec: 10,
    });
    expect(res2.acquired).toBe(false);
  });

  it("3. should NOT allow another user to release someone else's lock (safe Lua release)", async () => {
    // User 1 acquires lock
    await acquireSlotLock(redis, {
      botId,
      staffId,
      slotTime,
      userId: 1001,
      ttlSec: 10,
    });

    // User 2 attempts to release User 1's lock
    const releaseByStranger = await releaseSlotLock(redis, {
      botId,
      staffId,
      slotTime,
      userId: 2002,
    });

    // Should return false and NOT delete lock
    expect(releaseByStranger).toBe(false);
    const stillLocked = await isSlotLocked(redis, botId, staffId, slotTime);
    expect(stillLocked).toBe(true);
  });

  it("4. should allow the lock owner to safely release the lock", async () => {
    // User 1 acquires lock
    await acquireSlotLock(redis, {
      botId,
      staffId,
      slotTime,
      userId: 1001,
      ttlSec: 10,
    });

    // User 1 releases own lock
    const released = await releaseSlotLock(redis, {
      botId,
      staffId,
      slotTime,
      userId: 1001,
    });

    expect(released).toBe(true);
    const stillLocked = await isSlotLocked(redis, botId, staffId, slotTime);
    expect(stillLocked).toBe(false);

    // Now User 2 can acquire it
    const res2 = await acquireSlotLock(redis, {
      botId,
      staffId,
      slotTime,
      userId: 2002,
      ttlSec: 10,
    });
    expect(res2.acquired).toBe(true);
  });
});
