import crypto from "node:crypto";
import type { Redis } from "ioredis";

export interface SlotLockParams {
  botId: string;
  staffId: string;
  slotTime: Date | string;
  userId: string | number | bigint;
  ttlSec?: number;
  lockToken?: string;
  durationMin?: number;
  slotIntervalMin?: number;
}

export interface AcquireSlotLockResult {
  acquired: boolean;
  key: string;
  lockToken: string;
}

export interface ReleaseSlotLockParams {
  botId: string;
  staffId: string;
  slotTime: Date | string;
  userId?: string | number | bigint;
  lockToken?: string;
  durationMin?: number;
  slotIntervalMin?: number;
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

export function getSlotLockKeys(
  botId: string,
  staffId: string,
  slotTime: Date | string,
  durationMin?: number,
  slotIntervalMin?: number,
): string[] {
  const startMs = typeof slotTime === "string" ? new Date(slotTime).getTime() : slotTime.getTime();
  const keys: string[] = [];
  const interval = (slotIntervalMin && slotIntervalMin > 0) ? slotIntervalMin : 30;
  const duration = (durationMin && durationMin > 0) ? durationMin : interval;

  for (let offset = 0; offset < duration; offset += interval) {
    const t = new Date(startMs + offset * 60000);
    keys.push(formatSlotLockKey(botId, staffId, t));
  }

  return keys.length > 0 ? keys : [formatSlotLockKey(botId, staffId, slotTime)];
}

const ATOMIC_ACQUIRE_MULTI_LUA = `
local ttl = tonumber(ARGV[1])
local val = ARGV[2]

for i = 1, #KEYS do
  if redis.call("exists", KEYS[i]) == 1 then
    return 0
  end
end

for i = 1, #KEYS do
  redis.call("set", KEYS[i], val, "EX", ttl)
end
return 1
`;

const SAFE_RELEASE_MULTI_LUA = `
local expected = ARGV[1]
local isLegacy = ARGV[2] == "legacy_user"
local deletedCount = 0

for i = 1, #KEYS do
  local val = redis.call("get", KEYS[i])
  if val then
    local shouldDel = false
    if val == expected then
      shouldDel = true
    elseif string.find(val, ":" .. expected, 1, true) then
      shouldDel = true
    elseif isLegacy and (val == expected or string.sub(val, 1, string.len(expected) + 1) == expected .. ":") then
      shouldDel = true
    end

    if shouldDel then
      redis.call("del", KEYS[i])
      deletedCount = deletedCount + 1
    end
  end
end

return deletedCount > 0 and 1 or 0
`;

/**
 * Attempts to acquire an atomic distributed lock for a booking slot.
 * Locks the slot (and any overlapping interval sub-slots) for `ttlSec` (default 60s)
 * with a unique capture token.
 */
export async function acquireSlotLock(
  redis: Redis,
  params: SlotLockParams,
): Promise<AcquireSlotLockResult> {
  const keys = getSlotLockKeys(
    params.botId,
    params.staffId,
    params.slotTime,
    params.durationMin,
    params.slotIntervalMin,
  );
  const primaryKey = keys[0] ?? formatSlotLockKey(params.botId, params.staffId, params.slotTime);
  const lockToken = params.lockToken ?? crypto.randomUUID();
  const val = `${params.userId}:${lockToken}`;
  const ttl = params.ttlSec ?? 60;

  if (keys.length === 1) {
    const res = await redis.set(primaryKey, val, "EX", ttl, "NX");
    return {
      acquired: res === "OK",
      key: primaryKey,
      lockToken,
    };
  }

  const res = await redis.eval(ATOMIC_ACQUIRE_MULTI_LUA, keys.length, ...keys, ttl, val);
  return {
    acquired: res === 1,
    key: primaryKey,
    lockToken,
  };
}

/**
 * Safely releases the slot lock using Lua script.
 * Only deletes keys if their value matches the provided lockToken or requesting user.
 * If lockToken is provided, prevents releasing a recaptured lock when old lock had expired.
 */
export async function releaseSlotLock(
  redis: Redis,
  params: ReleaseSlotLockParams,
): Promise<boolean> {
  const keys = getSlotLockKeys(
    params.botId,
    params.staffId,
    params.slotTime,
    params.durationMin,
    params.slotIntervalMin,
  );

  let expected = "";
  let isLegacy = "0";

  if (params.lockToken) {
    expected = params.lockToken;
  } else if (params.userId !== undefined && params.userId !== null) {
    expected = String(params.userId);
    isLegacy = "legacy_user";
  } else {
    return false;
  }

  const res = await redis.eval(SAFE_RELEASE_MULTI_LUA, keys.length, ...keys, expected, isLegacy);
  return res === 1;
}

/**
 * Checks whether a given slot (or any of its intervals) is currently locked in Redis.
 */
export async function isSlotLocked(
  redis: Redis,
  botId: string,
  staffId: string,
  slotTime: Date | string,
  durationMin?: number,
  slotIntervalMin?: number,
): Promise<boolean> {
  const keys = getSlotLockKeys(botId, staffId, slotTime, durationMin, slotIntervalMin);
  if (keys.length === 1) {
    const exists = await redis.exists(keys[0]!);
    return exists === 1;
  }

  const exists = await redis.exists(...keys);
  return exists > 0;
}
