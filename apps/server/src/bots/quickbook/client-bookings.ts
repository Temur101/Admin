import { escapeTelegramHtml as html, telegramHtmlPages } from "../../core/telegram-text.js";
import { randomBytes } from "node:crypto";
import { InlineKeyboard } from "grammy";
import type { PlatformBotContext } from "../../gateway/types.js";
import { t } from "../shared/i18n.js";
import { formatTashkentDateTime } from "../shared/payment-service.js";
import { cancelBooking } from "./booking-cancel-service.js";
import { rescheduleBooking } from "./reschedule-service.js";
import { generateAvailableSlots } from "./slot-generator.js";
import { getQuickBookConfig } from "./config-resolver.js";
import { bookingWindow, tashkentDateString } from "./booking-horizon.js";
import { BOOKING_DATES_PAGE_SIZE } from "./booking-dates.js";
import type { QuickBookComposerOptions } from "./quickbook-handlers.js";

export async function showMyBookings(
  ctx: PlatformBotContext,
  opts: QuickBookComposerOptions,
): Promise<void> {
  if (!ctx.from) return;
  const { prisma } = opts;
  const lang = ctx.session.lang ?? "RU";

  const now = new Date();
  const bookings = await prisma.booking.findMany({
    where: {
      botId: ctx.botMeta.id,
      customerTgId: BigInt(ctx.from.id),
      status: { in: ["PENDING", "CONFIRMED"] },
      slotTime: { gte: now },
    },
    orderBy: { slotTime: "asc" },
  });

  if (bookings.length === 0) {
    await ctx.reply(t(lang, "my_bookings_empty"));
    return;
  }

  const config = getQuickBookConfig(ctx.botMeta.settings);
  const loc = lang === "UZ" ? "uz" : "ru";

  await ctx.reply(t(lang, "my_bookings_title"), { parse_mode: "HTML" });

  for (const b of bookings) {
    const service = config.services.find((s) => s.id === b.serviceId);
    const staff = config.resources.find((r) => r.id === b.staffId);
    const serviceName = service?.name[loc] || b.serviceName;
    const staffName = staff?.name[loc] || b.staffId;
    const timeFormatted = formatTashkentDateTime(b.slotTime);

    const text = `🔹 <b>${html(serviceName)}</b>\n👤 ${html(staffName)}\n⏰ ${timeFormatted}`;
    const kb = new InlineKeyboard()
      .text(t(lang, "btn_reschedule_booking"), `qb:my:resched:${b.id}`)
      .text(t(lang, "btn_cancel_booking"), `qb:my:cancel:${b.id}`);

    for (const page of telegramHtmlPages(text))
      await ctx.reply(page, { parse_mode: "HTML", reply_markup: kb });
  }
}

export function registerClientBookingsHandlers(
  bot: import("grammy").Bot<PlatformBotContext>,
  opts: QuickBookComposerOptions,
): void {
  const { prisma, redis, transport, logger } = opts;

  bot.hears(/^(📅 Мои записи|📅 Mening buyurtmalarim)$/, async (ctx) => {
    await showMyBookings(ctx, opts);
  });

  bot.callbackQuery(/^qb:my:cancel:(.+)$/, async (ctx) => {
    const bookingId = ctx.match[1];
    if (!bookingId || !ctx.from) return;
    await ctx.answerCallbackQuery().catch(() => {});
    const lang = ctx.session.lang ?? "RU";

    const res = await cancelBooking(prisma, redis, {
      bookingId,
      botId: ctx.botMeta.id,
      userId: ctx.from.id,
      notifications: { transport, logger },
    });

    if (!res.success) {
      await ctx.reply("Запись не найдена / Band topilmadi");
      return;
    }

    await ctx.reply(t(lang, "qb_cancelled_reply"));
  });

  bot.callbackQuery(/^qb:my:resched:(.+)$/, async (ctx) => {
    const bookingId = ctx.match[1];
    if (!bookingId || !ctx.from) return;
    await ctx.answerCallbackQuery().catch(() => {});
    await showRescheduleDates(ctx, bookingId, 0, opts);
  });

  bot.callbackQuery(/^qb:rs:d:(.+):(\d+)$/, async (ctx) => {
    const bookingId = ctx.match[1];
    const page = Number(ctx.match[2]);
    if (!bookingId) return;
    await ctx.answerCallbackQuery().catch(() => {});
    await showRescheduleDates(ctx, bookingId, page, opts);
  });

  bot.callbackQuery(/^qb:rs:s:(.+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    const bookingId = ctx.match[1];
    const dateStr = ctx.match[2];
    if (!bookingId || !dateStr) return;
    await ctx.answerCallbackQuery().catch(() => {});
    await showRescheduleSlots(ctx, bookingId, dateStr, opts);
  });

  bot.callbackQuery(/^qb:rs:c:([a-f0-9]{12}):(\d{13})$/, async (ctx) => {
    const selection = ctx.session.reschedule;
    const slotIso = new Date(Number(ctx.match[2])).toISOString();
    if (
      !selection ||
      selection.token !== ctx.match[1] ||
      selection.expiresAt < Date.now() ||
      !selection.slots.includes(slotIso)
    ) {
      await ctx
        .answerCallbackQuery({ text: t(ctx.session.lang, "qb_stale_selection"), show_alert: true })
        .catch(() => {});
      return;
    }
    const bookingId = selection.bookingId;
    if (!bookingId || !slotIso || !ctx.from) return;
    await ctx.answerCallbackQuery().catch(() => {});
    const lang = ctx.session.lang ?? "RU";
    const config = getQuickBookConfig(ctx.botMeta.settings);

    const res = await rescheduleBooking({
      prisma,
      redis,
      transport,
      logger,
      botId: ctx.botMeta.id,
      bookingId,
      newSlotTime: slotIso,
      userId: ctx.from.id,
      config,
      lang,
    });

    if (res.success) {
      delete ctx.session.reschedule;
      await ctx.reply(
        t(lang, "reschedule_success", { time: formatTashkentDateTime(new Date(slotIso)) }),
      );
    } else {
      await ctx.reply(t(lang, "reschedule_failed"));
    }
  });
}

async function showRescheduleDates(
  ctx: PlatformBotContext,
  bookingId: string,
  page: number,
  opts: QuickBookComposerOptions,
): Promise<void> {
  if (!(await findClientBooking(ctx, bookingId, opts))) return;
  const config = getQuickBookConfig(ctx.botMeta.settings);
  const horizon = config.bookingHorizonDays;
  const pages = Math.ceil(horizon / BOOKING_DATES_PAGE_SIZE);
  const offset = page * BOOKING_DATES_PAGE_SIZE;
  const { start } = bookingWindow(config);
  const lang = ctx.session.lang ?? "RU";

  const keyboard = new InlineKeyboard();
  for (let index = offset; index < Math.min(offset + BOOKING_DATES_PAGE_SIZE, horizon); index++) {
    const dateStr = tashkentDateString(new Date(start + index * 86400000));
    const dateLabel = `${dateStr.slice(8)}.${dateStr.slice(5, 7)}`;
    const label =
      index === 0
        ? `${t(lang, "qb_today")} · ${dateLabel}`
        : index === 1
          ? `${t(lang, "qb_tomorrow")} · ${dateLabel}`
          : dateLabel;
    keyboard.text(label, `qb:rs:s:${bookingId}:${dateStr}`);
    if ((index - offset) % 2 === 1) keyboard.row();
  }
  keyboard.row();
  if (page > 0) keyboard.text(t(lang, "qb_dates_previous"), `qb:rs:d:${bookingId}:${page - 1}`);
  if (page + 1 < pages) keyboard.text(t(lang, "qb_dates_next"), `qb:rs:d:${bookingId}:${page + 1}`);

  await ctx.reply(t(lang, "reschedule_choose_date"), { reply_markup: keyboard });
}

async function showRescheduleSlots(
  ctx: PlatformBotContext,
  bookingId: string,
  dateStr: string,
  opts: QuickBookComposerOptions,
): Promise<void> {
  const { prisma, redis } = opts;
  const lang = ctx.session.lang ?? "RU";
  const config = getQuickBookConfig(ctx.botMeta.settings);

  const booking = await findClientBooking(ctx, bookingId, opts);
  if (!booking) {
    await ctx.reply("Запись не найдена / Band topilmadi");
    return;
  }

  const slots = await generateAvailableSlots({
    botId: ctx.botMeta.id,
    config,
    serviceId: booking.serviceId,
    staffId: booking.staffId,
    dateStr,
    prisma,
    redis,
    lang,
  });

  if (slots.length === 0) {
    await ctx.reply(t(lang, "qb_no_slots"));
    return;
  }

  const token = randomBytes(6).toString("hex");
  ctx.session.reschedule = {
    bookingId,
    token,
    expiresAt: Date.now() + 5 * 60000,
    slots: slots.map((s) => s.slotTimeIso),
  };
  const keyboard = new InlineKeyboard();
  slots.forEach((slot, index) => {
    keyboard.text(slot.timeLabel, `qb:rs:c:${token}:${slot.slotTime.getTime()}`);
    if (index % 3 === 2) keyboard.row();
  });

  await ctx.reply(t(lang, "qb_choose_time"), { reply_markup: keyboard });
}

async function findClientBooking(
  ctx: PlatformBotContext,
  bookingId: string,
  opts: QuickBookComposerOptions,
) {
  if (!ctx.from || !/^[0-9a-f-]{36}$/i.test(bookingId)) return null;
  const booking = await opts.prisma.booking.findFirst({
    where: {
      id: bookingId,
      botId: ctx.botMeta.id,
      customerTgId: BigInt(ctx.from.id),
      status: { in: ["PENDING", "CONFIRMED"] },
    },
  });
  if (!booking) await ctx.reply("Запись не найдена / Band topilmadi");
  return booking;
}
