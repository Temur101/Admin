import { registerBookingSelectionHandlers } from "./booking-selection.js";
import { showBookingDates } from "./booking-dates.js";
import type { PlatformBotContext } from "../../gateway/types.js";
import { t } from "../shared/i18n.js";
import { isActualBotAdmin } from "../shared/user-service.js";
import { cancelBooking, formatTashkentDateTime } from "./booking-service.js";
import { notifyAdmins } from "../shared/notification.js";
import { getQuickBookConfig } from "./config-resolver.js";
import { contactKeyboard } from "../shared/client-menu.js";
import { resetClientFlow } from "../shared/flow-reset.js";

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

function resolveBookingDetails(
  booking: {
    bot?: { settings: unknown } | null;
    serviceId: string;
    serviceName: string;
    staffId: string;
    slotTime: Date;
  },
  settings: unknown,
  lang: "RU" | "UZ",
) {
  const config = getQuickBookConfig(
    (booking.bot?.settings ?? settings) as Record<string, unknown> | null | undefined,
  );
  const loc = lang === "UZ" ? "uz" : "ru";
  const service = config.services.find((s) => s.id === booking.serviceId);
  const resource = config.resources.find((r) => r.id === booking.staffId);
  return {
    serviceName: service?.name[loc] || booking.serviceName,
    staffName: resource?.name[loc] || booking.staffId,
    timeFormatted: formatTashkentDateTime(booking.slotTime),
  };
}

export function registerQuickBookHandlers(
  bot: import("grammy").Bot<PlatformBotContext>,
  opts: QuickBookComposerOptions,
): void {
  const { prisma, redis } = opts;

  registerBookingSelectionHandlers(bot, opts);

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
      ctx.session.quickbook = { serviceId, resourceId };
      await showBookingDates(ctx, serviceId, resourceId, 0);
      return;
    }
    await startQuickBookFlow(ctx, prisma, redis);
  });

  bot.hears(/^(➕ Записать клиента|➕ Mijozni yozish)$/, async (ctx) => {
    if (!ctx.from) return;
    const isAdmin = await isActualBotAdmin(prisma, ctx.botMeta.id, ctx.from.id);
    if (!isAdmin) return;
    await startQuickBookFlow(ctx, prisma, redis);
  });

  bot.hears(/^(📅 Записи|📅 Buyurtmalar)$/, async (ctx) => {
    if (!ctx.from) return;
    const isAdmin = await isActualBotAdmin(prisma, ctx.botMeta.id, ctx.from.id);
    if (!isAdmin) return;

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const upcoming = await prisma.booking.findMany({
      where: {
        botId: ctx.botMeta.id,
        status: { in: ["CONFIRMED", "PENDING"] },
        slotTime: { gte: startOfToday },
      },
      orderBy: { slotTime: "asc" },
      take: 10,
    });

    if (upcoming.length === 0) {
      await ctx.reply(
        ctx.session.lang === "UZ"
          ? "Yaqin orada buyurtmalar yo'q."
          : "Предстоящих записей пока нет.",
      );
      return;
    }

    const lines = upcoming.map((b, i: number) => {
      const timeStr = b.slotTime.toLocaleDateString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Asia/Tashkent",
      });
      const src = b.source === "MANUAL" ? " [Ручная]" : "";
      const customer = b.customerName ?? b.customerPhone;
      return `${i + 1}. ${timeStr} — ${customer} (${b.customerPhone})\n   Услуга: ${b.serviceName} (${b.staffId})${src}`;
    });

    await ctx.reply(`📅 <b>Предстоящие записи:</b>\n\n${lines.join("\n\n")}`, {
      parse_mode: "HTML",
    });
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
    if (session?.slotTimeIso && session.step !== "summary") {
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

    if (booking.status === "PENDING") {
      await prisma.booking.update({
        where: { id: bookingId },
        data: { status: "CONFIRMED" },
      });
    }

    const lockKey = `booking:confirm_notified:${bookingId}`;
    const setRes = await redis.set(lockKey, "1", "EX", 86400, "NX").catch(() => null);
    if (setRes === "OK") {
      const details = resolveBookingDetails(booking, ctx.botMeta.settings, lang);
      const sentCount = await notifyAdmins(
        ctx.botMeta.id,
        {
          kind: "BOOKING_CONFIRMED",
          name: booking.customerName,
          phone: booking.customerPhone,
          service: details.serviceName,
          staff: details.staffName,
          time: details.timeFormatted,
          serviceId: booking.serviceId,
          staffId: booking.staffId,
        },
        { prisma, transport: opts.transport, logger: opts.logger },
      ).catch((err) => {
        opts.logger.error(
          { err: (err as Error).message },
          "Failed to notify admins of booking confirmation",
        );
        return 0;
      });

      if (sentCount === 0) {
        await redis.del(lockKey).catch(() => {});
      }
    }

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
    });

    if (!result.success) {
      if (result.error === "FORBIDDEN") {
        await ctx.reply("Доступ запрещен / Ruxsat yo'q");
      } else {
        await ctx.reply("Запись не найдена / Band topilmadi");
      }
      return;
    }

    if (!result.alreadyCancelled) {
      const details = resolveBookingDetails(result.booking, ctx.botMeta.settings, lang);
      await notifyAdmins(
        ctx.botMeta.id,
        {
          kind: "BOOKING_CANCELLED",
          name: result.booking.customerName,
          phone: result.booking.customerPhone,
          service: details.serviceName,
          staff: details.staffName,
          time: details.timeFormatted,
          serviceId: result.booking.serviceId,
          staffId: result.booking.staffId,
        },
        { prisma, transport: opts.transport, logger: opts.logger },
      ).catch((err) => {
        opts.logger.error(
          { err: (err as Error).message },
          "Failed to notify admins of booking cancellation",
        );
      });
    }

    await ctx.reply(t(lang, "qb_cancelled_reply"));
  });
}
