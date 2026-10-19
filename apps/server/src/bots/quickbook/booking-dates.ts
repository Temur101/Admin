import { InlineKeyboard } from "grammy";
import type { PlatformBotContext } from "../../gateway/types.js";
import { callbackId } from "../shared/callback-id.js";
import { t } from "../shared/i18n.js";
import { getQuickBookConfig } from "./config-resolver.js";
import { bookingWindow, tashkentDateString } from "./booking-horizon.js";
export const BOOKING_DATES_PAGE_SIZE = 7;
export async function showBookingDates(
  ctx: PlatformBotContext,
  serviceId: string,
  resourceId: string,
  page = 0,
): Promise<void> {
  const config = getQuickBookConfig(ctx.botMeta.settings);
  const horizon = config.bookingHorizonDays;
  const pages = Math.ceil(horizon / BOOKING_DATES_PAGE_SIZE);
  const offset = page * BOOKING_DATES_PAGE_SIZE;
  const { start } = bookingWindow(config);
  const lang = ctx.session.lang ?? "RU";
  const keyboard = new InlineKeyboard();
  const ids = `${callbackId(serviceId)}:${resourceId === "any" ? "any" : callbackId(resourceId)}`;
  for (let index = offset; index < Math.min(offset + BOOKING_DATES_PAGE_SIZE, horizon); index++) {
    const dateStr = tashkentDateString(new Date(start + index * 86400000));
    const dateLabel = `${dateStr.slice(8)}.${dateStr.slice(5, 7)}`;
    const label =
      index === 0
        ? `${t(lang, "qb_today")} · ${dateLabel}`
        : index === 1
          ? `${t(lang, "qb_tomorrow")} · ${dateLabel}`
          : dateLabel;
    keyboard.text(label, `qb:date:${ids}:${dateStr}`);
    if ((index - offset) % 2 === 1) keyboard.row();
  }
  keyboard.row();
  if (page > 0) keyboard.text(t(lang, "qb_dates_previous"), `qb:days:${ids}:${page - 1}`);
  if (page + 1 < pages) keyboard.text(t(lang, "qb_dates_next"), `qb:days:${ids}:${page + 1}`);
  const title =
    pages > 1 ? t(lang, "qb_date_page", { page: page + 1, pages }) : t(lang, "qb_choose_date");
  await ctx.reply(title, { reply_markup: keyboard });
}
