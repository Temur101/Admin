import type { PrismaClient } from "@prisma/client";
import { InlineKeyboard, Keyboard } from "grammy";
import type { Redis } from "ioredis";
import type { TelegramTransport } from "../../adapters/telegram/transport.js";
import type { Logger } from "../../core/logger.js";
import type { PlatformBotContext } from "../../gateway/types.js";
import { t } from "../shared/i18n.js";
import { parseAndNormalizePhone } from "../shared/phone.js";
import { getQuickBookConfig } from "./config-resolver.js";
import { acquireSlotLock } from "./slot-lock.js";
import {
  generateAvailableSlots,
  getAlternativeSlots,
  type TimeSlot,
} from "./slot-generator.js";
import {
  cancelBooking,
  createBooking,
  formatTashkentDateTime,
} from "./booking-service.js";

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
    config,
    lang,
  });

  if (bookingRes.success) {
    delete ctx.session.quickbook;

    const srv = config.services.find((s) => s.id === bookingRes.booking.serviceId);
    const staff = config.resources.find((r) => r.id === bookingRes.booking.staffId);
    const srvName = srv ? (lang === "UZ" ? srv.name.uz : srv.name.ru) : bookingRes.booking.serviceName;
    const staffName = staff ? (lang === "UZ" ? staff.name.uz : staff.name.ru) : bookingRes.booking.staffId;
    const label = config.resourceLabel ? (lang === "UZ" ? config.resourceLabel.uz : config.resourceLabel.ru) : (lang === "UZ" ? "Mutaxassis" : "Специалист");

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
  } else if (bookingRes.error === "SLOT_TAKEN") {
    await renderAlternativeSlots(ctx, bookingRes.alternativeSlots, session.serviceId, session.resourceId);
  } else {
    await ctx.reply(t(lang, "quiz_invalid_phone"));
  }
}

async function renderAlternativeSlots(
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

export function registerQuickBookHandlers(
  bot: import("grammy").Bot<PlatformBotContext>,
  opts: QuickBookComposerOptions,
): void {
  const { prisma, redis } = opts;

  // 1. Service selected -> show resources
  bot.callbackQuery(/^qb:srv:(.+)$/, async (ctx) => {
    const serviceId = ctx.match[1];
    if (!serviceId) return;
    await ctx.answerCallbackQuery().catch(() => {});

    ctx.session.quickbook = { serviceId };
    const lang = ctx.session.lang ?? "RU";
    const config = getQuickBookConfig(ctx.botMeta.settings);

    const eligibleResources = config.resources.filter(
      (r) => !r.serviceIds || r.serviceIds.length === 0 || r.serviceIds.includes(serviceId),
    );

    const label = config.resourceLabel
      ? (lang === "UZ" ? config.resourceLabel.uz : config.resourceLabel.ru)
      : (lang === "UZ" ? "Mutaxassis" : "Специалиста");

    const keyboard = new InlineKeyboard();
    keyboard.text(t(lang, "qb_any_resource"), `qb:res:${serviceId}:any`).row();

    for (const res of eligibleResources) {
      const name = lang === "UZ" ? res.name.uz : res.name.ru;
      keyboard.text(name, `qb:res:${serviceId}:${res.id}`).row();
    }

    const title = t(lang, "qb_choose_resource", { label });
    await ctx.reply(title, { reply_markup: keyboard });
  });

  // 2. Resource selected -> show dates (next 7 days)
  bot.callbackQuery(/^qb:res:([^:]+):([^:]+)$/, async (ctx) => {
    const serviceId = ctx.match[1];
    const resourceId = ctx.match[2];
    if (!serviceId || !resourceId) return;
    await ctx.answerCallbackQuery().catch(() => {});

    ctx.session.quickbook = { ...ctx.session.quickbook, serviceId, resourceId };
    const lang = ctx.session.lang ?? "RU";

    const keyboard = new InlineKeyboard();
    const now = new Date();

    for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
      const d = new Date(now.getTime() + dayOffset * 86400000 + 5 * 3600 * 1000);
      const dateStr = d.toISOString().slice(0, 10);
      const day = String(d.getUTCDate()).padStart(2, "0");
      const month = String(d.getUTCMonth() + 1).padStart(2, "0");
      const label = dayOffset === 0 ? "Сегодня" : dayOffset === 1 ? "Завтра" : `${day}.${month}`;

      keyboard.text(label, `qb:date:${serviceId}:${resourceId}:${dateStr}`);
      if (dayOffset % 2 === 1 || dayOffset === 6) {
        keyboard.row();
      }
    }

    await ctx.reply(t(lang, "qb_choose_date"), { reply_markup: keyboard });
  });

  // 3. Date selected -> generate & show slots
  bot.callbackQuery(/^qb:date:([^:]+):([^:]+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    const serviceId = ctx.match[1];
    const resourceId = ctx.match[2];
    const dateStr = ctx.match[3];
    if (!serviceId || !resourceId || !dateStr) return;
    await ctx.answerCallbackQuery().catch(() => {});

    ctx.session.quickbook = { ...ctx.session.quickbook, serviceId, resourceId, dateStr };
    const lang = ctx.session.lang ?? "RU";
    const config = getQuickBookConfig(ctx.botMeta.settings);

    const slots = await generateAvailableSlots({
      botId: ctx.botMeta.id,
      config,
      serviceId,
      staffId: resourceId === "any" ? undefined : resourceId,
      dateStr,
      prisma,
      redis,
      lang,
    });

    if (slots.length === 0) {
      await ctx.reply(t(lang, "qb_no_slots"));
      return;
    }

    const keyboard = new InlineKeyboard();
    let col = 0;
    for (const slot of slots) {
      const label = resourceId === "any" ? `${slot.timeLabel} (${slot.staffName})` : slot.timeLabel;
      keyboard.text(label, `qb:slot:${serviceId}:${slot.staffId}:${slot.slotTimeIso}`);
      col++;
      if (col % 2 === 0) {
        keyboard.row();
      }
    }

    await ctx.reply(t(lang, "qb_choose_time"), { reply_markup: keyboard });
  });

  // 4. Slot selected -> acquire lock and ask for phone
  bot.callbackQuery(/^qb:slot:([^:]+):([^:]+):(.+)$/, async (ctx) => {
    const serviceId = ctx.match[1];
    const staffId = ctx.match[2];
    const slotTimeIso = ctx.match[3];
    if (!serviceId || !staffId || !slotTimeIso || !ctx.from) return;
    await ctx.answerCallbackQuery().catch(() => {});

    const lang = ctx.session.lang ?? "RU";
    const config = getQuickBookConfig(ctx.botMeta.settings);

    // Acquire distributed lock for 60 seconds
    const lockRes = await acquireSlotLock(redis, {
      botId: ctx.botMeta.id,
      staffId,
      slotTime: slotTimeIso,
      userId: ctx.from.id,
      ttlSec: 60,
    });

    if (!lockRes.acquired) {
      // Slot taken by someone else right now
      const altSlots = await getAlternativeSlots({
        botId: ctx.botMeta.id,
        config,
        serviceId,
        staffId,
        dateStr: slotTimeIso.slice(0, 10),
        prisma,
        redis,
        lang,
      });
      await renderAlternativeSlots(ctx, altSlots, serviceId, staffId);
      return;
    }

    ctx.session.quickbook = {
      serviceId,
      resourceId: staffId,
      slotTimeIso,
      lockedUntil: Date.now() + 60000,
    };

    const phoneKeyboard = new Keyboard()
      .requestContact(t(lang, "quiz_btn_share_phone"))
      .resized()
      .oneTime();

    await ctx.reply(t(lang, "qb_prompt_phone"), {
      reply_markup: phoneKeyboard,
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
    await ctx.answerCallbackQuery().catch(() => {});
    const lang = ctx.session.lang ?? "RU";
    await ctx.reply(t(lang, "qb_confirmed_reply"));
  });

  bot.callbackQuery(/^book:cancel:(.+)$/, async (ctx) => {
    const bookingId = ctx.match[1];
    await ctx.answerCallbackQuery().catch(() => {});
    if (bookingId) {
      await cancelBooking(prisma, redis, bookingId);
    }
    const lang = ctx.session.lang ?? "RU";
    await ctx.reply(t(lang, "qb_cancelled_reply"));
  });
}
