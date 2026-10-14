import { InlineKeyboard, Keyboard } from "grammy";
import type { PlatformBotContext } from "../../gateway/types.js";
import { t } from "../shared/i18n.js";
import { isActualBotAdmin } from "../shared/user-service.js";
import { getQuickBookConfig } from "./config-resolver.js";
import { acquireSlotLock } from "./slot-lock.js";
import {
  generateAvailableSlots,
  getAlternativeSlots,
} from "./slot-generator.js";
import {
  cancelBooking,
} from "./booking-service.js";

export {
  type QuickBookComposerOptions,
  startQuickBookFlow,
  handleQuickBookContact,
  renderAlternativeSlots,
} from "./quickbook-handlers.js";
import {
  handleQuickBookContact,
  renderAlternativeSlots,
  startQuickBookFlow,
  type QuickBookComposerOptions,
} from "./quickbook-handlers.js";

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
    const srv = config.services.find((s) => s.id === serviceId);

    // Acquire distributed lock for 60 seconds
    const lockRes = await acquireSlotLock(redis, {
      botId: ctx.botMeta.id,
      staffId,
      slotTime: slotTimeIso,
      userId: ctx.from.id,
      ttlSec: 60,
      durationMin: srv?.durationMin,
      slotIntervalMin: config.slotIntervalMin,
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
      lockToken: lockRes.lockToken,
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

  // Admin menu shortcuts for QuickBook
  bot.hears(/^(➕ Записать клиента|➕ Mijozni yozish)$/, async (ctx) => {
    if (!ctx.from) return;
    const isAdmin = await isActualBotAdmin(prisma, ctx.botMeta.id, ctx.from.id);
    if (!isAdmin) return;
    await startQuickBookFlow(ctx, prisma);
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

    await ctx.reply(
      `📅 <b>Предстоящие записи:</b>\n\n${lines.join("\n\n")}`,
      { parse_mode: "HTML" },
    );
  });
}
