import { registerBookingSelectionHandlers } from "./booking-selection.js";
import { showBookingDates } from "./booking-dates.js";
import type { PlatformBotContext } from "../../gateway/types.js";
import { t } from "../shared/i18n.js";
import { isActualBotAdmin } from "../shared/user-service.js";
import { cancelBooking } from "./booking-service.js";
import {
  bookingNotification,
  enqueueAdminNotifications,
  dispatchQueuedNotifications,
} from "../shared/notification-outbox.js";
import { contactKeyboard } from "../shared/client-menu.js";
import { resetClientFlow } from "../shared/flow-reset.js";
import { registerAdminBookingHandlers, handleAdminBookingText } from "./admin-booking.js";
import { registerClientBookingsHandlers } from "./client-bookings.js";
import { registerOwnerSettingsHandlers } from "./owner-settings.js";
import { handleAdminBookingsList } from "./admin-bookings-list.js";

export {
  type QuickBookComposerOptions,
  startQuickBookFlow,
  handleQuickBookContact,
  promptQuickBookSummary,
  renderAlternativeSlots,
} from "./quickbook-handlers.js";
import {
  promptQuickBookSummary,
  startQuickBookFlow,
  type QuickBookComposerOptions,
} from "./quickbook-handlers.js";

export function registerQuickBookHandlers(
  bot: import("grammy").Bot<PlatformBotContext>,
  opts: QuickBookComposerOptions,
): void {
  const { prisma, redis } = opts;

  registerBookingSelectionHandlers(bot, opts);
  registerAdminBookingHandlers(bot, opts);
  registerClientBookingsHandlers(bot, opts);
  registerOwnerSettingsHandlers(bot, opts);

  bot.hears([t("RU", "btn_back"), t("UZ", "btn_back")], async (ctx, next) => {
    const session = ctx.session.quickbook;
    if (!session) return next();
    if (session.step === "summary") {
      delete session.phone;
      delete session.phoneVerified;
      session.step = "phone";
      await ctx.reply(t(ctx.session.lang, "qb_prompt_phone"), {
        reply_markup: contactKeyboard(ctx),
      });
      return;
    }
    if (session.slotTimeIso && session.serviceId && session.resourceId) {
      const { serviceId, resourceId } = session;
      if (!(await resetClientFlow(ctx, redis, opts.logger))) return;
      ctx.session.quickbook = {
        serviceId,
        resourceId,
        isAdminBooking: session.isAdminBooking,
        runId: session.runId,
      };
      await showBookingDates(ctx, serviceId, resourceId, 0);
      return;
    }
    await startQuickBookFlow(ctx, prisma, redis);
  });

  bot.hears(/^(📅 Записи|📅 Buyurtmalar)$/, async (ctx) => {
    if (!ctx.from) return;
    const isAdmin = await isActualBotAdmin(prisma, ctx.botMeta.id, ctx.from.id);
    if (!isAdmin) return;

    await handleAdminBookingsList(ctx, prisma);
  });

  bot.on("message:contact", async (ctx, next) => {
    const session = ctx.session.quickbook;
    if (session?.slotTimeIso && session.step !== "summary") {
      const contact = ctx.message.contact;
      const phone = contact?.phone_number;
      if (phone) {
        if (contact.user_id === undefined || contact.user_id !== ctx.from?.id) {
          await ctx.reply(t(ctx.session.lang, "contact_not_own"));
          return;
        }
        await promptQuickBookSummary(ctx, phone, true, opts);
        return;
      }
    }
    return next();
  });

  bot.on("message:text", async (ctx, next) => {
    const session = ctx.session.quickbook;
    if (
      session?.isAdminBooking &&
      (session.step === "admin_name" || session.step === "admin_phone")
    ) {
      const handled = await handleAdminBookingText(ctx, opts);
      if (handled) return;
    }
    if (session?.slotTimeIso && session.step !== "summary" && !session.isAdminBooking) {
      const text = ctx.message.text.trim();
      if (
        !text.startsWith("/") &&
        !text.startsWith("📋") &&
        !text.startsWith("💳") &&
        !text.startsWith("🌐") &&
        !text.startsWith("🏠") &&
        !text.startsWith("📝") &&
        !text.startsWith("📅") &&
        !text.startsWith("➕") &&
        !text.startsWith("🔄") &&
        !text.startsWith("⬅️") &&
        !text.startsWith("🔔") &&
        !text.startsWith("🔕")
      ) {
        await promptQuickBookSummary(ctx, text, false, opts);
        return;
      }
    }
    return next();
  });

  bot.on("message", async (ctx, next) => {
    const session = ctx.session.quickbook;
    if (session?.slotTimeIso && session.step !== "summary") {
      await ctx.reply(t(ctx.session.lang, "unexpected_input_booking"));
      return;
    }
    return next();
  });

  bot.callbackQuery(/^book:confirm:(.+)$/, async (ctx) => {
    const bookingId = ctx.match[1];
    if (!bookingId || !ctx.from) return;
    await ctx.answerCallbackQuery().catch(() => {});
    const lang = ctx.session.lang ?? "RU";

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
      include: { bot: true },
    });

    if (!booking || booking.botId !== ctx.botMeta.id) {
      await ctx.reply("Запись не найдена / Band topilmadi");
      return;
    }

    const isAdmin = await isActualBotAdmin(prisma, ctx.botMeta.id, ctx.from.id);
    const isOwner = booking.customerTgId === BigInt(ctx.from.id);
    if (!isOwner && !isAdmin) {
      await ctx.reply("Доступ запрещен / Ruxsat yo'q");
      return;
    }

    if (booking.status === "CANCELLED") {
      await ctx.reply(t(lang, "qb_cancelled_reply"));
      return;
    }

    const eventKey = `booking:${bookingId}:acknowledged`;
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${booking.botId}:${booking.staffId}`}));`;
      const current = await tx.booking.findUniqueOrThrow({ where: { id: bookingId } });
      if (current.status === "CANCELLED") return;
      if (current.status === "PENDING")
        await tx.booking.update({ where: { id: bookingId }, data: { status: "CONFIRMED" } });
      await enqueueAdminNotifications(
        tx,
        ctx.botMeta.id,
        eventKey,
        bookingNotification(current, "BOOKING_CONFIRMED"),
      );
    });
    await dispatchQueuedNotifications({
      prisma,
      transport: opts.transport,
      logger: opts.logger,
      eventKey,
    });

    await ctx.reply(t(lang, "qb_confirmed_reply"));
  });

  bot.callbackQuery(/^book:cancel:(.+)$/, async (ctx) => {
    const bookingId = ctx.match[1];
    if (!bookingId || !ctx.from) return;
    await ctx.answerCallbackQuery().catch(() => {});
    const lang = ctx.session.lang ?? "RU";

    const isAdmin = await isActualBotAdmin(prisma, ctx.botMeta.id, ctx.from.id);
    const result = await cancelBooking(prisma, redis, {
      bookingId,
      botId: ctx.botMeta.id,
      userId: ctx.from.id,
      isAdmin,
      notifications: { transport: opts.transport, logger: opts.logger },
    });

    if (!result.success) {
      if (result.error === "FORBIDDEN") {
        await ctx.reply("Доступ запрещен / Ruxsat yo'q");
      } else {
        await ctx.reply("Запись не найдена / Band topilmadi");
      }
      return;
    }

    await ctx.reply(t(lang, "qb_cancelled_reply"));
  });
}
