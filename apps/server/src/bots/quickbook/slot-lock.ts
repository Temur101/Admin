import type { Redis } from "ioredis";

export interface SlotLockParams {
  botId: string;
  staffId: string;
  slotTime: Date | string;
  userId: string | number | bigint;
  ttlSec?: number;
}

export function formatSlotLockKey(
  botId: string,
  staffId: string,
  slotTime: Date | string,
): string {
  const ts = typeof slotTime === "string" ? new Date(slotTime).getTime() : slotTime.getTime();
  const tsSec = Math.floor(ts / 1000);
  return `lock:slot:${botId}:${staffId}:${tsSec}`;
}

const SAFE_RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/**
 * Attempts to acquire an atomic distributed lock for a booking slot.
 * Locks the slot for `ttlSec` (default 60s) for a specific user.
 */
export async function acquireSlotLock(
  redis: Redis,
  params: SlotLockParams,
): Promise<{ acquired: boolean; key: string }> {
  const key = formatSlotLockKey(params.botId, params.staffId, params.slotTime);
  const val = String(params.userId);
  const ttl = params.ttlSec ?? 60;

  const res = await redis.set(key, val, "EX", ttl, "NX");
  return {
    acquired: res === "OK",
    key,
  };
}

/**
 * Safely releases the slot lock using Lua script.
 * Only deletes the key if its current value matches the requesting user.
 * Returns true if the lock was released, false if the key was held by another user or expired.
 */
export async function releaseSlotLock(
  redis: Redis,
  params: SlotLockParams,
): Promise<boolean> {
  const key = formatSlotLockKey(params.botId, params.staffId, params.slotTime);
  const val = String(params.userId);

  const res = await redis.eval(SAFE_RELEASE_LUA, 1, key, val);
  return res === 1;
}

/**
 * Checks whether a given slot is currently locked in Redis.
 */
export async function isSlotLocked(
  redis: Redis,
  botId: string,
  staffId: string,
  slotTime: Date | string,
): Promise<boolean> {
  const key = formatSlotLockKey(botId, staffId, slotTime);
  const exists = await redis.exists(key);
  return exists === 1;
}
