import type { Redis } from "ioredis";
import type { Logger } from "../../core/logger.js";
import type { PlatformBotContext } from "../../gateway/types.js";
import { releaseHeldBooking } from "../quickbook/booking-session.js";
import { navigationKeyboard } from "./client-menu.js";
import { t } from "./i18n.js";
export async function resetClientFlow(
  ctx: PlatformBotContext,
  redis?: Redis,
  logger?: Logger,
): Promise<boolean> {
  try {
    await releaseHeldBooking(ctx, redis);
  } catch (error) {
    logger?.warn(
      { err: error instanceof Error ? error.message : String(error), botId: ctx.botMeta.id },
      "Could not release client booking hold",
    );
    await ctx.api.sendMessage(
      ctx.chat?.id ?? ctx.from!.id,
      t(ctx.session.lang, "client_reset_failed"),
      { reply_markup: navigationKeyboard(ctx) },
    );
    return false;
  }
  ctx.session.quiz = undefined;
  ctx.session.quickbook = undefined;
  ctx.session.payment = undefined;
  ctx.session.reschedule = undefined;
  return true;
}
