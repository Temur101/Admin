import type { PrismaClient } from "@prisma/client";
import { InlineKeyboard } from "grammy";
import type { Redis } from "ioredis";
import type { TelegramTransport } from "../../adapters/telegram/transport.js";
import type { Logger } from "../../core/logger.js";
import type { PlatformBotContext } from "../../gateway/types.js";
import { t } from "../shared/i18n.js";
import { parseAndNormalizePhone } from "../shared/phone.js";
import { getQuickBookConfig } from "./config-resolver.js";
import { type TimeSlot } from "./slot-generator.js";
import { createBooking, formatTashkentDateTime } from "./booking-service.js";

export interface QuickBookComposerOptions {
  prisma: PrismaClient;
  redis: Redis;
  transport: TelegramTransport;
  logger: Logger;
}

export async function startQuickBookFlow(
  ctx: PlatformBotContext,
  _prisma: PrismaClient,
): Promise<void> {
  const lang = ctx.session.lang ?? "RU";
  const config = getQuickBookConfig(ctx.botMeta.settings);

  ctx.session.quickbook = {};

  const keyboard = new InlineKeyboard();
  for (const srv of config.services) {
    const srvName = lang === "UZ" ? srv.name.uz : srv.name.ru;
    const label = `${srvName} (${srv.durationMin} мин, ${srv.priceUzs.toLocaleString()} сум)`;
    keyboard.text(label, `qb:srv:${srv.id}`).row();
  }

  const title = t(lang, "qb_choose_service");
  await ctx.reply(title, { reply_markup: keyboard });
}

export async function renderAlternativeSlots(
  ctx: PlatformBotContext,
  slots: TimeSlot[],
  serviceId: string,
  _staffId: string,
): Promise<void> {
  const lang = ctx.session.lang ?? "RU";
  const keyboard = new InlineKeyboard();

  for (const slot of slots.slice(0, 4)) {
    const label = `${slot.timeLabel} (${slot.staffName})`;
    keyboard.text(label, `qb:slot:${serviceId}:${slot.staffId}:${slot.slotTimeIso}`).row();
  }

  await ctx.reply(t(lang, "qb_slot_taken"), { reply_markup: keyboard });
}

export async function handleQuickBookContact(
  ctx: PlatformBotContext,
  rawPhone: string,
  opts: QuickBookComposerOptions,
): Promise<void> {
  const lang = ctx.session.lang ?? "RU";
  const session = ctx.session.quickbook;

  if (!session?.serviceId || !session.resourceId || !session.slotTimeIso || !ctx.from) {
    return;
  }

  const phoneRes = parseAndNormalizePhone(rawPhone);
  if (!phoneRes.isValid) {
    await ctx.reply(t(lang, "quiz_invalid_phone"));
    return;
  }

  const config = getQuickBookConfig(ctx.botMeta.settings);
  const bookingRes = await createBooking({
    prisma: opts.prisma,
    redis: opts.redis,
    transport: opts.transport,
    logger: opts.logger,
    botId: ctx.botMeta.id,
    customerTgId: ctx.from.id,
    customerName: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" "),
    customerPhone: phoneRes.normalized ?? rawPhone,
    serviceId: session.serviceId,
    staffId: session.resourceId,
    slotTime: session.slotTimeIso,
    lockToken: session.lockToken,
    config,
    lang,
  });

  if (bookingRes.success) {
    delete ctx.session.quickbook;

    const srv = config.services.find((s) => s.id === bookingRes.booking.serviceId);
    const staff = config.resources.find((r) => r.id === bookingRes.booking.staffId);
    const srvName = srv ? (lang === "UZ" ? srv.name.uz : srv.name.ru) : bookingRes.booking.serviceName;
    const staffName = staff ? (lang === "UZ" ? staff.name.uz : staff.name.ru) : bookingRes.booking.staffId;
    const label = config.resourceLabel
      ? lang === "UZ"
        ? config.resourceLabel.uz
        : config.resourceLabel.ru
      : lang === "UZ"
        ? "Mutaxassis"
        : "Специалист";

    const timeStr = formatTashkentDateTime(bookingRes.booking.slotTime);
    const successMsg = t(lang, "qb_booking_success", {
      service: srvName,
      label,
      resource: staffName,
      time: timeStr,
    });

    await ctx.reply(successMsg, {
      reply_markup: { remove_keyboard: true },
    });
  } else if ("alternativeSlots" in bookingRes) {
    await renderAlternativeSlots(ctx, bookingRes.alternativeSlots, session.serviceId, session.resourceId);
  } else {
    await ctx.reply(t(lang, "quiz_invalid_phone"));
  }
}
