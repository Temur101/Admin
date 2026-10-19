import type { MiddlewareFn } from "grammy";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import type { Logger } from "../../core/logger.js";
import type { PlatformBotContext } from "../../gateway/types.js";
import { releaseHeldBooking } from "../quickbook/booking-session.js";
import { navigationKeyboard } from "./client-menu.js";
import { t } from "./i18n.js";
/** Shared by webhook, inbox retries and polling. Read the current flag, without stale caches. */
export function maintenanceMiddleware(
  prisma: PrismaClient,
  redis: Redis,
  logger: Logger,
): MiddlewareFn<PlatformBotContext> {
  return async (ctx, next) => {
    const settings = await prisma.platformSettings.findUnique({
      where: { id: 1 },
      select: { maintenanceMode: true },
    });
    if (!settings?.maintenanceMode) return next();
    if (!ctx.from) return;
    const user = await prisma.botUser.findUnique({
      where: { botId_tgId: { botId: ctx.botMeta.id, tgId: BigInt(ctx.from.id) } },
      select: { lang: true, isAdmin: true },
    });
    ctx.session.isAdmin = user?.isAdmin ?? false;
    ctx.session.lang = user?.lang ?? ctx.session.lang;
    // Owners retain administration/payment access; existing bookings may still be confirmed/cancelled.
    if (user?.isAdmin || /^book:(?:confirm|cancel):[^:]+$/.test(ctx.callbackQuery?.data ?? ""))
      return next();
    if (ctx.session.quickbook?.lockToken) {
      try {
        await releaseHeldBooking(ctx, redis);
        delete ctx.session.quickbook;
      } catch (error) {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error), botId: ctx.botMeta.id },
          "Could not release booking hold during maintenance",
        );
      }
    }
    const text = t(ctx.session.lang, "platform_maintenance");
    if (ctx.callbackQuery) {
      try {
        await ctx.answerCallbackQuery({ text, show_alert: true });
        return;
      } catch {
        // An expired callback still needs a visible maintenance response.
      }
    }
    await ctx.api.sendMessage(ctx.chat?.id ?? ctx.from.id, text, {
      reply_markup: navigationKeyboard(ctx),
    });
  };
}
