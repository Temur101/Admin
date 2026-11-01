import type { Bot } from "grammy";
import type { PlatformBotContext } from "../../gateway/types.js";
import { resolveCallbackId } from "../shared/callback-id.js";
import { contactKeyboard } from "../shared/client-menu.js";
import { resetClientFlow } from "../shared/flow-reset.js";
import { t } from "../shared/i18n.js";
import { validateBookingSlotEligibility } from "./booking-validator.js";
import { getQuickBookConfig } from "./config-resolver.js";
import { tooSoonNotice } from "./limits-texts.js";
import { renderAlternativeSlots, type QuickBookComposerOptions } from "./quickbook-handlers.js";
import { getAlternativeSlots } from "./slot-generator.js";
import { acquireSlotLock } from "./slot-lock.js";

interface SlotHelpers {
  mode: (ctx: PlatformBotContext) => { isAdminBooking?: boolean; runId?: string };
  stale: (ctx: PlatformBotContext) => Promise<unknown>;
}

/** Slot pick: re-validates eligibility (incl. the client minimum lead time) at click time. */
export function registerSlotSelectHandler(
  bot: Bot<PlatformBotContext>,
  opts: QuickBookComposerOptions,
  { mode, stale }: SlotHelpers,
): void {
  const { prisma, redis } = opts;

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
    const savedMode = mode(ctx);
    const eligibility =
      srv && staff && Number.isFinite(date.getTime())
        ? validateBookingSlotEligibility({
            config,
            service: srv,
            staff,
            slotDate: date,
            skipMinLead: savedMode.isAdminBooking,
          })
        : null;
    if (!srv || !staff || !eligibility) {
      await stale(ctx);
      return;
    }
    if (!eligibility.valid) {
      if (eligibility.error !== "TOO_SOON") {
        await stale(ctx);
        return;
      }
      const alternatives = await getAlternativeSlots({
        botId: ctx.botMeta.id,
        config,
        serviceId,
        staffId,
        dateStr: slotTimeIso.slice(0, 10),
        prisma,
        redis,
        lang,
      });
      await renderAlternativeSlots(
        ctx,
        alternatives,
        serviceId,
        staffId,
        tooSoonNotice(lang, config.minLeadMinutes),
      );
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
      durationMin: srv.durationMin,
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
        skipMinLead: savedMode.isAdminBooking,
      });
      await renderAlternativeSlots(ctx, altSlots, serviceId, staffId);
      return;
    }

    ctx.session.quickbook = {
      ...savedMode,
      serviceId,
      resourceId: staffId,
      slotTimeIso,
      lockedUntil: Date.now() + 60000,
      lockToken: lockRes.lockToken,
      lockDurationMin: srv.durationMin,
      lockIntervalMin: config.slotIntervalMin,
      step: savedMode.isAdminBooking ? "admin_name" : undefined,
    };

    if (savedMode.isAdminBooking) {
      await ctx.reply(lang === "UZ" ? "👤 Mijozning ismini kiriting:" : "👤 Введите имя клиента:");
      return;
    }

    await ctx.reply(t(lang, "qb_prompt_phone"), {
      reply_markup: contactKeyboard(ctx),
    });
  });
}
