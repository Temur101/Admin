import { registerBookingSelectionHandlers } from "./booking-selection.js";
import type { PlatformBotContext } from "../../gateway/types.js";
import { t } from "../shared/i18n.js";
import { isActualBotAdmin } from "../shared/user-service.js";
import { cancelBooking } from "./booking-service.js";

export {
  type QuickBookComposerOptions,
  startQuickBookFlow,
  handleQuickBookContact,
  renderAlternativeSlots,
} from "./quickbook-handlers.js";
import {
  handleQuickBookContact,
  startQuickBookFlow,
  type QuickBookComposerOptions,
} from "./quickbook-handlers.js";

export function registerQuickBookHandlers(
  bot: import("grammy").Bot<PlatformBotContext>,
  opts: QuickBookComposerOptions,
): void {
  const { prisma, redis } = opts;

  registerBookingSelectionHandlers(bot, opts);

  // Admin menu shortcuts for QuickBook
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

  // 5. Native Telegram contact received
  bot.on("message:contact", async (ctx, next) => {
    if (ctx.session.quickbook?.slotTimeIso) {
      const phone = ctx.message.contact?.phone_number;
      if (phone) {
        await handleQuickBookContact(ctx, phone, opts);
        return;
      }
    }
    return next();
  });

  // 6. Text message received (for manual phone entry)
  bot.on("message:text", async (ctx, next) => {
    if (ctx.session.quickbook?.slotTimeIso) {
      const text = ctx.message.text.trim();
      if (!text.startsWith("/")) {
        await handleQuickBookContact(ctx, text, opts);
        return;
      }
    }
    return next();
  });

  // 7. Booking reminder actions: Confirm and Cancel
  bot.callbackQuery(/^book:confirm:(.+)$/, async (ctx) => {
    const bookingId = ctx.match[1];
    if (!bookingId || !ctx.from) return;
    await ctx.answerCallbackQuery().catch(() => {});
    const lang = ctx.session.lang ?? "RU";

    const booking = await prisma.booking.findUnique({
      where: { id: bookingId },
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

    await ctx.reply(t(lang, "qb_cancelled_reply"));
  });
}
