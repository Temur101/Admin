import type { Redis } from "ioredis";
import type { PlatformBotContext } from "../../gateway/types.js";
import { releaseSlotLock } from "./slot-lock.js";
import { getQuickBookConfig } from "./config-resolver.js";
/** Release only this captured token, never a replacement hold or an existing booking. */
export async function releaseHeldBooking(ctx: PlatformBotContext, redis?: Redis): Promise<void> {
  const held = ctx.session.quickbook;
  if (!held?.slotTimeIso || !held.resourceId || !held.lockToken) return;
  if (!redis) throw new Error("Redis is required to release a booking hold");
  const config = getQuickBookConfig(ctx.botMeta.settings);
  const service = config.services.find((item) => item.id === held.serviceId);
  await releaseSlotLock(redis, {
    botId: ctx.botMeta.id,
    staffId: held.resourceId,
    slotTime: held.slotTimeIso,
    lockToken: held.lockToken,
    durationMin: held.lockDurationMin ?? service?.durationMin,
    slotIntervalMin: held.lockIntervalMin ?? config.slotIntervalMin,
  });
}
