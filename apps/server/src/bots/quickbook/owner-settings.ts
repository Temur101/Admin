import { randomBytes } from "node:crypto";
import { tashkentDateString } from "./booking-horizon.js";
import { parseTashkentDate } from "./slot-generator.js";
import { InlineKeyboard } from "grammy";
import type { PlatformBotContext } from "../../gateway/types.js";
import { formatTashkentDateTime } from "../shared/payment-service.js";
import type { BotAdminAction } from "../shared/permissions.js";
import { isActualBotAdmin } from "../shared/user-service.js";
import { getQuickBookConfig } from "./config-resolver.js";
import {
  createTimeBlock, TimeBlockConflictError,
  deleteTimeBlock,
  listTimeBlocks,
} from "./time-block-service.js";
import type { QuickBookComposerOptions } from "./quickbook-handlers.js";

export function registerOwnerSettingsHandlers(
  bot: import("grammy").Bot<PlatformBotContext>,
  opts: QuickBookComposerOptions,
): void {
  const { prisma } = opts;
  const allowed = async (ctx: PlatformBotContext, action: BotAdminAction) => {
    if (ctx.from && await isActualBotAdmin(prisma, ctx.botMeta.id, ctx.from.id, action)) return true;
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "Доступ запрещен / Ruxsat yo‘q", show_alert: true }).catch(() => {});
    return false;
  };

  // 1. TimeBlocks Menu
  bot.hears(/^(🔒 Блокировки|🔒 Blokirovkalar)$/, async (ctx) => {
    if (!ctx.from) return;
    if (!(await allowed(ctx, "MANAGE_TIME_BLOCKS"))) return;

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
    if (!(await allowed(ctx, "MANAGE_TIME_BLOCKS"))) return;

    await deleteTimeBlock(prisma, { botId: ctx.botMeta.id, blockId });
    await ctx.reply(
      ctx.session.lang === "UZ" ? "Blokirovka o'chirildi." : "Блокировка удалена.",
    );
  });

  // Add TimeBlock quick menu
  bot.callbackQuery(/^tb:menu:add$/, async (ctx) => {
    if (!(await allowed(ctx, "MANAGE_TIME_BLOCKS"))) return;
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
    if (!(await allowed(ctx, "MANAGE_TIME_BLOCKS"))) return;
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
    if (!(await allowed(ctx, "MANAGE_TIME_BLOCKS"))) return;
    const resourceId = ctx.match[1];
    const when = ctx.match[2];
    if (!resourceId || !ctx.from) return;
    await ctx.answerCallbackQuery().catch(() => {});

    const dayOffset = when === "tomorrow" ? 1 : 0;
    const now = new Date();
    const targetDate = new Date(now.getTime() + dayOffset * 86400000);

    const { dayStartUtc: startsAt, dayEndUtc: endsAt } = parseTashkentDate(tashkentDateString(targetDate));
    const draft = { resourceId, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), token: randomBytes(6).toString("hex"), expiresAt: Date.now() + 5 * 60000 };
    try {
      await createTimeBlock(prisma, { botId: ctx.botMeta.id, resourceId, startsAt, endsAt, createdByTgId: ctx.from.id });
    } catch (error) {
      if (!(error instanceof TimeBlockConflictError)) throw error;
      ctx.session.timeBlockDraft = draft;
      const details = error.bookings.slice(0, 10).map(b => formatTashkentDateTime(b.slotTime)).join("\n");
      await ctx.reply(`⚠️ ${error.bookings.length} записей / buyurtma:\n${details}\nПодтвердить блокировку? / Tasdiqlaysizmi?`, { reply_markup: new InlineKeyboard().text("✅ Подтвердить / Tasdiqlash", `tb:confirm:${draft.token}`) });
      return;
    }

    await ctx.reply(
      ctx.session.lang === "UZ"
        ? "✅ Blokirovka muvaffaqiyatli saqlandi!"
        : "✅ Блокировка времени успешно установлена!",
    );
  });

  bot.callbackQuery(/^tb:confirm:([a-f0-9]{12})$/, async ctx => {
    if (!(await allowed(ctx, "MANAGE_TIME_BLOCKS"))) return;
    await ctx.answerCallbackQuery().catch(() => {});
    const draft = ctx.session.timeBlockDraft;
    if (!draft || draft.token !== ctx.match[1] || draft.expiresAt < Date.now()) return;
    await createTimeBlock(prisma, { botId: ctx.botMeta.id, resourceId: draft.resourceId, startsAt: new Date(draft.startsAt), endsAt: new Date(draft.endsAt), createdByTgId: ctx.from!.id, confirmConflicts: true });
    delete ctx.session.timeBlockDraft;
    await ctx.reply("✅ Блокировка сохранена / Blokirovka saqlandi");
  });

  // 2. Owner Settings Menu
  bot.hears(/^(⚙️ Настройки|⚙️ Sozlamalar)$/, async (ctx) => {
    if (!ctx.from) return;
    if (!(await allowed(ctx, "MANAGE_SETTINGS"))) return;

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
