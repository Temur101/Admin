import { showBookingDates, BOOKING_DATES_PAGE_SIZE } from "./booking-dates.js";
import { isBookingDateAllowed } from "./booking-horizon.js";
import { resetClientFlow } from "../shared/flow-reset.js";
import { contactKeyboard } from "../shared/client-menu.js";
import { RESOURCE_LABELS } from "@lcqb/contracts";
import { InlineKeyboard, type Bot } from "grammy";
import type { PlatformBotContext } from "../../gateway/types.js";
import { callbackId, resolveCallbackId } from "../shared/callback-id.js";
import { t } from "../shared/i18n.js";
import { getQuickBookConfig } from "./config-resolver.js";
import { acquireSlotLock } from "./slot-lock.js";
import { generateAvailableSlots, getAlternativeSlots } from "./slot-generator.js";
import { validateBookingSlotEligibility } from "./booking-validator.js";
import {
  handleQuickBookContact,
  renderAlternativeSlots,
  sendQuickBookEditMenu,
  startQuickBookFlow,
  type QuickBookComposerOptions,
} from "./quickbook-handlers.js";

export function registerBookingSelectionHandlers(
  bot: Bot<PlatformBotContext>,
  opts: QuickBookComposerOptions,
): void {
  const { prisma, redis } = opts;
  const stale = (ctx: PlatformBotContext) => ctx.reply(t(ctx.session.lang, "qb_stale_selection"));

  const showResourcesForService = async (ctx: PlatformBotContext, serviceId: string) => {
    const config = getQuickBookConfig(ctx.botMeta.settings);
    if (!(await resetClientFlow(ctx, redis, opts.logger))) return;
    ctx.session.quickbook = { serviceId };
    const lang = ctx.session.lang ?? "RU";
    const eligibleResources = config.resources.filter(
      (r) => !r.serviceIds || r.serviceIds.length === 0 || r.serviceIds.includes(serviceId),
    );

    const label = config.resourceLabel
      ? lang === "UZ"
        ? config.resourceLabel.uz
        : config.resourceLabel.ru
      : RESOURCE_LABELS[config.resourceType][lang === "UZ" ? "uz" : "ru"];

    const keyboard = new InlineKeyboard();
    keyboard.text(t(lang, "qb_any_resource"), `qb:res:${callbackId(serviceId)}:any`).row();

    for (const res of eligibleResources) {
      const name = lang === "UZ" ? res.name.uz : res.name.ru;
      keyboard.text(name, `qb:res:${callbackId(serviceId)}:${callbackId(res.id)}`).row();
    }
    keyboard
      .text(t(lang, "btn_back"), "qb:back:srv")
      .text(t(lang, "btn_restart"), "qb:restart");

    await ctx.reply(t(lang, "qb_choose_resource", { label }), { reply_markup: keyboard });
  };

  bot.callbackQuery(/^qb:srv:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const config = getQuickBookConfig(ctx.botMeta.settings);
    const serviceId = resolveCallbackId(config.services, ctx.match[1]);
    if (!serviceId) {
      await stale(ctx);
      return;
    }
    await showResourcesForService(ctx, serviceId);
  });

  bot.callbackQuery(/^qb:(?:res:([^:]+):([^:]+)|days:([^:]+):([^:]+):(\d+))$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const config = getQuickBookConfig(ctx.botMeta.settings);
    const serviceToken = ctx.match[1] ?? ctx.match[3];
    const resourceToken = ctx.match[2] ?? ctx.match[4];
    const page = Number(ctx.match[5] ?? 0);
    const serviceId = resolveCallbackId(config.services, serviceToken);
    const resourceId =
      resourceToken === "any" ? "any" : resolveCallbackId(config.resources, resourceToken);
    if (
      !serviceId ||
      !resourceId ||
      !Number.isSafeInteger(page) ||
      page < 0 ||
      page * BOOKING_DATES_PAGE_SIZE >= config.bookingHorizonDays
    ) {
      await stale(ctx);
      return;
    }

    if (!(await resetClientFlow(ctx, redis, opts.logger))) return;
    ctx.session.quickbook = { serviceId, resourceId };
    await showBookingDates(ctx, serviceId, resourceId, page);
  });

  bot.callbackQuery(/^qb:date:([^:]+):([^:]+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const config = getQuickBookConfig(ctx.botMeta.settings);
    const serviceId = resolveCallbackId(config.services, ctx.match[1]);
    const resourceId =
      ctx.match[2] === "any" ? "any" : resolveCallbackId(config.resources, ctx.match[2]);
    const dateStr = ctx.match[3];
    if (!serviceId || !resourceId || !dateStr || !isBookingDateAllowed(dateStr, config)) {
      await stale(ctx);
      return;
    }

    if (!(await resetClientFlow(ctx, redis, opts.logger))) return;
    ctx.session.quickbook = { serviceId, resourceId, dateStr };
    const lang = ctx.session.lang ?? "RU";
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
      keyboard.text(
        label,
        `qb:slot:${callbackId(serviceId)}:${callbackId(slot.staffId)}:${slot.slotTimeIso}`,
      );
      col++;
      if (col % 2 === 0) {
        keyboard.row();
      }
    }
    const resToken = resourceId === "any" ? "any" : callbackId(resourceId);
    keyboard
      .row()
      .text(t(lang, "btn_back"), `qb:back:date:${callbackId(serviceId)}:${resToken}`)
      .text(t(lang, "btn_restart"), "qb:restart");

    await ctx.reply(t(lang, "qb_choose_time"), { reply_markup: keyboard });
  });

  bot.callbackQuery(/^qb:slot:([^:]+):([^:]+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const config = getQuickBookConfig(ctx.botMeta.settings);
    const serviceId = resolveCallbackId(config.services, ctx.match[1]);
    const staffId = resolveCallbackId(config.resources, ctx.match[2]);
    const slotTimeIso = ctx.match[3];
    if (!serviceId || !staffId || !slotTimeIso || !ctx.from) {
      await stale(ctx);
      return;
    }

    const lang = ctx.session.lang ?? "RU";
    const srv = config.services.find((s) => s.id === serviceId);
    const staff = config.resources.find((resource) => resource.id === staffId);
    const date = new Date(slotTimeIso);
    if (
      !srv ||
      !staff ||
      !Number.isFinite(date.getTime()) ||
      !validateBookingSlotEligibility({ config, service: srv, staff, slotDate: date }).valid
    ) {
      await stale(ctx);
      return;
    }

    const held = ctx.session.quickbook;
    if (
      held?.serviceId === serviceId &&
      held.resourceId === staffId &&
      held.slotTimeIso === slotTimeIso &&
      held.lockToken &&
      (held.lockedUntil ?? 0) > Date.now()
    ) {
      await ctx.reply(t(lang, "qb_prompt_phone"), { reply_markup: contactKeyboard(ctx) });
      return;
    }
    if (!(await resetClientFlow(ctx, redis, opts.logger))) return;

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
      lockDurationMin: srv.durationMin,
      lockIntervalMin: config.slotIntervalMin,
    };

    await ctx.reply(t(lang, "qb_prompt_phone"), {
      reply_markup: contactKeyboard(ctx),
    });
  });

  bot.callbackQuery(/^qb:restart(?::(.+))?$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await startQuickBookFlow(ctx, prisma, redis);
  });

  bot.callbackQuery(/^qb:back:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const parts = (ctx.match[1] ?? "").split(":");
    const target = parts[0];
    const config = getQuickBookConfig(ctx.botMeta.settings);
    if (target === "srv") {
      await startQuickBookFlow(ctx, prisma, redis);
      return;
    }
    if (target === "res") {
      const serviceId = resolveCallbackId(config.services, parts[1]);
      if (!serviceId) {
        await stale(ctx);
        return;
      }
      await showResourcesForService(ctx, serviceId);
      return;
    }
    if (target === "date") {
      const serviceId = resolveCallbackId(config.services, parts[1]);
      const resourceId =
        parts[2] === "any" ? "any" : resolveCallbackId(config.resources, parts[2]);
      if (!serviceId || !resourceId) {
        await stale(ctx);
        return;
      }
      if (!(await resetClientFlow(ctx, redis, opts.logger))) return;
      ctx.session.quickbook = { serviceId, resourceId };
      await showBookingDates(ctx, serviceId, resourceId, 0);
      return;
    }
    if (target === "phone") {
      const session = ctx.session.quickbook;
      if (!session || session.runId !== parts[1]) {
        await stale(ctx);
        return;
      }
      delete session.phone;
      delete session.phoneVerified;
      session.step = "phone";
      await ctx.reply(t(ctx.session.lang, "qb_prompt_phone"), {
        reply_markup: contactKeyboard(ctx),
      });
    }
  });

  bot.callbackQuery(/^qb:confirm_book:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const runId = ctx.match[1];
    const session = ctx.session.quickbook;
    if (!session || session.step !== "summary" || session.runId !== runId || !session.phone) {
      await stale(ctx);
      return;
    }
    await handleQuickBookContact(ctx, session.phone, opts, session.phoneVerified ?? false);
  });

  bot.callbackQuery(/^qb:edit:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    const runId = ctx.match[1];
    const session = ctx.session.quickbook;
    if (!session || session.step !== "summary" || session.runId !== runId) {
      await stale(ctx);
      return;
    }
    await sendQuickBookEditMenu(ctx);
  });
}
