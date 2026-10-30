import { InlineKeyboard } from "grammy";
import type { PlatformBotContext } from "../../gateway/types.js";
import { formatTashkentDateTime } from "../shared/payment-service.js";
import { isActualBotAdmin } from "../shared/user-service.js";
import { getQuickBookConfig } from "./config-resolver.js";
import {
  createTimeBlock,
  deleteTimeBlock,
  listTimeBlocks,
} from "./time-block-service.js";
import type { QuickBookComposerOptions } from "./quickbook-handlers.js";

export function registerOwnerSettingsHandlers(
  bot: import("grammy").Bot<PlatformBotContext>,
  opts: QuickBookComposerOptions,
): void {
  const { prisma } = opts;

  // 1. TimeBlocks Menu
  bot.hears(/^(🔒 Блокировки|🔒 Blokirovkalar)$/, async (ctx) => {
    if (!ctx.from) return;
    const isAdmin = await isActualBotAdmin(prisma, ctx.botMeta.id, ctx.from.id);
    if (!isAdmin) return;

    const lang = ctx.session.lang ?? "RU";
    const now = new Date();
    const blocks = await listTimeBlocks(prisma, {
      botId: ctx.botMeta.id,
      from: now,
    });

    const config = getQuickBookConfig(ctx.botMeta.settings);
    const loc = lang === "UZ" ? "uz" : "ru";

    if (blocks.length === 0) {
      const kb = new InlineKeyboard().text(
        lang === "UZ" ? "➕ Blokirovka qo'shish" : "➕ Закрыть день / интервал",
        "tb:menu:add",
      );
      await ctx.reply(
        lang === "UZ"
          ? "Faol vaqt blokirovkalari yo'q."
          : "Активных блокировок времени пока нет.",
        { reply_markup: kb },
      );
      return;
    }

    await ctx.reply(
      lang === "UZ" ? "🔒 <b>Faol blokirovkalar:</b>" : "🔒 <b>Активные блокировки:</b>",
      { parse_mode: "HTML" },
    );

    for (const b of blocks.slice(0, 10)) {
      const staff = config.resources.find((r) => r.id === b.resourceId);
      const staffName = b.resourceId === "all" ? (lang === "UZ" ? "Barcha mutaxassislar" : "Все мастера") : (staff?.name[loc] || b.resourceId);
      const fromStr = formatTashkentDateTime(b.startsAt);
      const toStr = formatTashkentDateTime(b.endsAt);
      const reasonStr = b.reason ? `\nSabab / Причина: ${b.reason}` : "";

      const text = `👤 ${staffName}\n⏰ ${fromStr} — ${toStr}${reasonStr}`;
      const kb = new InlineKeyboard().text(
        lang === "UZ" ? "🗑 O'chirish" : "🗑 Удалить",
        `tb:del:${b.id}`,
      );
      await ctx.reply(text, { reply_markup: kb });
    }

    const addKb = new InlineKeyboard().text(
      lang === "UZ" ? "➕ Yangi blokirovka" : "➕ Новая блокировка",
      "tb:menu:add",
    );
    await ctx.reply(lang === "UZ" ? "Amallar:" : "Действия:", { reply_markup: addKb });
  });

  // Delete TimeBlock callback
  bot.callbackQuery(/^tb:del:(.+)$/, async (ctx) => {
    const blockId = ctx.match[1];
    if (!blockId || !ctx.from) return;
    await ctx.answerCallbackQuery().catch(() => {});
    const isAdmin = await isActualBotAdmin(prisma, ctx.botMeta.id, ctx.from.id);
    if (!isAdmin) return;

    await deleteTimeBlock(prisma, { botId: ctx.botMeta.id, blockId });
    await ctx.reply(
      ctx.session.lang === "UZ" ? "Blokirovka o'chirildi." : "Блокировка удалена.",
    );
  });

  // Add TimeBlock quick menu
  bot.callbackQuery(/^tb:menu:add$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const lang = ctx.session.lang ?? "RU";
    const config = getQuickBookConfig(ctx.botMeta.settings);
    const loc = lang === "UZ" ? "uz" : "ru";

    const kb = new InlineKeyboard();
    kb.text(lang === "UZ" ? "👥 Barcha mutaxassislar" : "👥 Все мастера", "tb:add:res:all").row();
    for (const r of config.resources) {
      kb.text(r.name[loc], `tb:add:res:${r.id}`).row();
    }

    await ctx.reply(
      lang === "UZ" ? "Kim uchun blokirovka o'rnatmoqchisiz?" : "Для кого установить блокировку?",
      { reply_markup: kb },
    );
  });

  // Close today/tomorrow for selected resource
  bot.callbackQuery(/^tb:add:res:(.+)$/, async (ctx) => {
    const resourceId = ctx.match[1];
    if (!resourceId || !ctx.from) return;
    await ctx.answerCallbackQuery().catch(() => {});
    const lang = ctx.session.lang ?? "RU";

    const kb = new InlineKeyboard()
      .text(lang === "UZ" ? "Bugun butun kun" : "Сегодня на весь день", `tb:create:${resourceId}:today`)
      .row()
      .text(lang === "UZ" ? "Ertaga butun kun" : "Завтра на весь день", `tb:create:${resourceId}:tomorrow`);

    await ctx.reply(
      lang === "UZ" ? "Qaysi kunga blokirovka o'rnatilsin?" : "На какой день установить блокировку?",
      { reply_markup: kb },
    );
  });

  // Create block execution
  bot.callbackQuery(/^tb:create:([^:]+):(today|tomorrow)$/, async (ctx) => {
    const resourceId = ctx.match[1];
    const when = ctx.match[2];
    if (!resourceId || !ctx.from) return;
    await ctx.answerCallbackQuery().catch(() => {});

    const dayOffset = when === "tomorrow" ? 1 : 0;
    const now = new Date();
    const targetDate = new Date(now.getTime() + dayOffset * 86400000);

    const year = targetDate.getFullYear();
    const month = targetDate.getMonth();
    const date = targetDate.getDate();

    // Tashkent is UTC+5, full day 00:00 to 23:59:59
    const startsAt = new Date(Date.UTC(year, month, date, 0 - 5, 0, 0, 0));
    const endsAt = new Date(Date.UTC(year, month, date, 24 - 5, 0, 0, 0));

    await createTimeBlock(prisma, {
      botId: ctx.botMeta.id,
      resourceId,
      startsAt,
      endsAt,
      reason: when === "tomorrow" ? "Выходной (завтра)" : "Выходной (сегодня)",
      createdByTgId: ctx.from.id,
    });

    await ctx.reply(
      ctx.session.lang === "UZ"
        ? "✅ Blokirovka muvaffaqiyatli saqlandi!"
        : "✅ Блокировка времени успешно установлена!",
    );
  });

  // 2. Owner Settings Menu
  bot.hears(/^(⚙️ Настройки|⚙️ Sozlamalar)$/, async (ctx) => {
    if (!ctx.from) return;
    const isAdmin = await isActualBotAdmin(prisma, ctx.botMeta.id, ctx.from.id);
    if (!isAdmin) return;

    const lang = ctx.session.lang ?? "RU";
    const config = getQuickBookConfig(ctx.botMeta.settings);
    const loc = lang === "UZ" ? "uz" : "ru";

    const servicesStr = config.services
      .map((s) => `• ${s.name[loc]}: ${s.priceUzs.toLocaleString("ru-RU")} сум`)
      .join("\n");

    const workHoursStr = config.resources
      .map((r) => `• ${r.name[loc]}: ${r.workHours.start} - ${r.workHours.end}`)
      .join("\n");

    const text =
      lang === "UZ"
        ? `⚙️ <b>Bot sozlamalari:</b>\n\n<b>Xizmatlar narxi:</b>\n${servicesStr}\n\n<b>Ish vaqtlari:</b>\n${workHoursStr}\n\n<i>To'liq va qulay tahrirlash uchun veb-boshqaruv panelidan foydalaning.</i>`
        : `⚙️ <b>Настройки бота:</b>\n\n<b>Цены услуг:</b>\n${servicesStr}\n\n<b>Рабочие часы:</b>\n${workHoursStr}\n\n<i>Для быстрого изменения цен и часов используйте веб-панель или обратитесь к администратору.</i>`;

    await ctx.reply(text, { parse_mode: "HTML" });
  });
}
