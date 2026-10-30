import { resetClientFlow } from "../shared/flow-reset.js";
import { releaseHeldBooking } from "./booking-session.js";
import { randomUUID } from "node:crypto";
import { InlineKeyboard } from "grammy";
import type { PlatformBotContext } from "../../gateway/types.js";
import { t } from "../shared/i18n.js";
import { isActualBotAdmin } from "../shared/user-service.js";
import { formatTashkentDateTime } from "../shared/payment-service.js";
import { parseAndNormalizePhone } from "../shared/phone.js";
import { createBooking } from "./booking-service.js";
import { getQuickBookConfig } from "./config-resolver.js";
import { startQuickBookFlow } from "./quickbook-handlers.js";
import type { QuickBookComposerOptions } from "./quickbook-handlers.js";

export async function startAdminBookingFlow(
  ctx: PlatformBotContext,
  opts: QuickBookComposerOptions,
): Promise<void> {
  if (!ctx.from) return;
  const { prisma, redis } = opts;
  const isAdmin = await isActualBotAdmin(prisma, ctx.botMeta.id, ctx.from.id, "CREATE_MANUAL_BOOKING");
  if (!isAdmin) return;

  await startQuickBookFlow(ctx, prisma, redis);
  if (ctx.session.quickbook) {
    ctx.session.quickbook.isAdminBooking = true;
    ctx.session.quickbook.runId = randomUUID().slice(0, 12);
  } else {
    ctx.session.quickbook = { isAdminBooking: true };
  }
}

export async function handleAdminBookingText(
  ctx: PlatformBotContext,
  _opts: QuickBookComposerOptions,
): Promise<boolean> {
  const session = ctx.session.quickbook;
  if (!session?.isAdminBooking || !ctx.message?.text) {
    return false;
  }

  const lang = ctx.session.lang ?? "RU";
  const text = ctx.message.text.trim();

  if (session.step === "admin_name") {
    if (text.length < 1 || text.length > 255 || text.startsWith("/")) {
      await ctx.reply(lang === "UZ" ? "⚠️ Iltimos, mijoz ismini kiriting:" : "⚠️ Пожалуйста, введите корректное имя клиента:");
      return true;
    }
    session.customerName = text;
    session.step = "admin_phone";
    await ctx.reply(
      lang === "UZ"
        ? "📞 Mijozning telefon raqamini kiriting (masalan, +998901234567):"
        : "📞 Введите номер телефона клиента (например, +998901234567):",
    );
    return true;
  }

  if (session.step === "admin_phone") {
    const parsed = parseAndNormalizePhone(text);
    if (!parsed.isValid || !parsed.normalized) {
      await ctx.reply(
        lang === "UZ"
          ? "⚠️ Noto'g'ri telefon raqami formati. Masalan: +998901234567"
          : "⚠️ Неверный формат номера. Введите номер, например: +998901234567",
      );
      return true;
    }
    session.phone = parsed.normalized;
    session.step = "admin_summary";
    await showAdminBookingSummary(ctx);
    return true;
  }

  return false;
}

export async function showAdminBookingSummary(ctx: PlatformBotContext): Promise<void> {
  const session = ctx.session.quickbook;
  if (!session || !session.serviceId || !session.resourceId || !session.slotTimeIso) {
    return;
  }

  const config = getQuickBookConfig(ctx.botMeta.settings);
  const lang = ctx.session.lang ?? "RU";
  const loc = lang === "UZ" ? "uz" : "ru";

  const service = config.services.find((s) => s.id === session.serviceId);
  const staff = config.resources.find((r) => r.id === session.resourceId);
  const serviceName = service?.name[loc] || session.serviceId;
  const staffName = staff?.name[loc] || session.resourceId;
  const timeFormatted = formatTashkentDateTime(new Date(session.slotTimeIso));

  const text =
    lang === "UZ"
      ? `📋 <b>Mijoz buyurtmasi ma'lumotlari:</b>\n\n👤 Mijoz: ${session.customerName}\n📞 Telefon: ${session.phone}\n✂️ Xizmat: ${serviceName}\n👤 Mutaxassis: ${staffName}\n⏰ Vaqt: ${timeFormatted}\n\nBuyurtmani tasdiqlaysizmi?`
      : `📋 <b>Данные записи клиента (ручная запись):</b>\n\n👤 Клиент: ${session.customerName}\n📞 Телефон: ${session.phone}\n✂️ Услуга: ${serviceName}\n👤 Мастер: ${staffName}\n⏰ Время: ${timeFormatted}\n\nПодтвердить создание записи?`;

  session.runId ??= randomUUID().slice(0, 12);
  const kb = new InlineKeyboard()
    .text(lang === "UZ" ? "✅ Yozish" : "✅ Записать клиента", `qb:adm:confirm:${session.runId}`)
    .text(lang === "UZ" ? "❌ Bekor qilish" : "❌ Отмена", "qb:adm:cancel");

  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
}

export function registerAdminBookingHandlers(
  bot: import("grammy").Bot<PlatformBotContext>,
  opts: QuickBookComposerOptions,
): void {
  const { prisma, redis, transport, logger } = opts;

  bot.hears(/^(➕ Записать клиента|➕ Mijozni yozish)$/, async (ctx) => {
    await startAdminBookingFlow(ctx, opts);
  });

  bot.callbackQuery(/^qb:adm:cancel$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    if (!(await resetClientFlow(ctx, redis, logger))) return;
    await ctx.reply(ctx.session.lang === "UZ" ? "Yozuv bekor qilindi." : "Запись отменена.");
  });

  bot.callbackQuery(/^qb:adm:confirm(?::([a-zA-Z0-9_-]+))?$/, async (ctx) => {
    if (!ctx.from) return;
    await ctx.answerCallbackQuery().catch(() => {});
    if (!(await isActualBotAdmin(prisma, ctx.botMeta.id, ctx.from.id, "CREATE_MANUAL_BOOKING"))) return;
    const session = ctx.session.quickbook;
    if (
      !session?.isAdminBooking || session.step !== "admin_summary" || !session.runId || session.runId !== ctx.match[1] ||
      !session.serviceId ||
      !session.resourceId ||
      !session.slotTimeIso ||
      !session.phone
    ) {
      await ctx.reply("Данные записи устарели / Ma'lumotlar eskirgan");
      return;
    }

    const config = getQuickBookConfig(ctx.botMeta.settings);
    const lang = ctx.session.lang ?? "RU";

    const res = await createBooking({
      prisma,
      redis,
      transport,
      logger,
      botId: ctx.botMeta.id,
      customerTgId: null, // Critical: customerTgId must be null for manual bookings
      customerName: session.customerName ?? null,
      customerPhone: session.phone,
      phoneVerified: false,
      serviceId: session.serviceId,
      staffId: session.resourceId,
      slotTime: session.slotTimeIso,
      config,
      lang,
      source: "MANUAL",
      createdByTgId: ctx.from.id,
      lockToken: session.lockToken,
    });

    if (res.success) {
      await releaseHeldBooking(ctx, redis).catch(() => {});
      delete ctx.session.quickbook;
      await ctx.reply(t(lang, "admin_manual_booking_created"));
    } else {
      await ctx.reply(
        lang === "UZ"
          ? "⚠️ Bu vaqt band qilingan. Boshqa vaqtni tanlang."
          : "⚠️ Выбранный слот уже занят. Попробуйте выбрать другое время.",
      );
    }
  });
}
