import { freshConfig, showOwnerSettings } from "./owner-settings-view.js";
export { showOwnerSettings };
import { InlineKeyboard, type Bot } from "grammy";
import { randomBytes } from "node:crypto";
import type { PlatformBotContext } from "../../gateway/types.js";
import { callbackId, resolveCallbackId } from "../shared/callback-id.js";
import { isActualBotAdmin } from "../shared/user-service.js";
import { tashkentDateString } from "./booking-horizon.js";
import {
  effectivePhrase,
  fmtLead,
  fmtUzs,
  leadPreview,
  limText,
  pricePreview,
  type LimLang,
} from "./limits-texts.js";
import type { QuickBookComposerOptions } from "./quickbook-handlers.js";
import {
  cancelPendingChange,
  planSettingChange,
  scheduleSettingChange,
  validateChangeValue,
  type SettingChangeError,
} from "./setting-changes.js";
import { addDaysToDateString } from "./setting-schedule.js";

const STATE_TTL_MS = 10 * 60_000;
type Kind = "MIN_LEAD" | "SERVICE_PRICE";
const langOf = (ctx: PlatformBotContext): LimLang => ctx.session.lang ?? "RU";

/** Rights are re-read from PostgreSQL on every action (also for old buttons and typed input). */
async function ensureOwner(ctx: PlatformBotContext, opts: QuickBookComposerOptions) {
  if (
    ctx.from &&
    (await isActualBotAdmin(opts.prisma, ctx.botMeta.id, ctx.from.id, "MANAGE_SETTINGS"))
  ) {
    return true;
  }
  delete ctx.session.limits;
  if (ctx.callbackQuery) {
    await ctx
      .answerCallbackQuery({ text: limText(langOf(ctx)).denied, show_alert: true })
      .catch(() => {});
  }
  return false;
}

async function replyError(ctx: PlatformBotContext, error: SettingChangeError, kind: Kind) {
  const L = limText(langOf(ctx));
  const text =
    error === "INVALID_VALUE"
      ? kind === "MIN_LEAD"
        ? L.leadInvalid
        : L.priceInvalid
      : error === "SERVICE_NOT_FOUND"
        ? L.stale
        : L.noWorkingDay;
  await ctx.reply(text);
}

async function preview(
  ctx: PlatformBotContext,
  opts: QuickBookComposerOptions,
  kind: Kind,
  serviceId: string | undefined,
  value: number,
): Promise<void> {
  const lang = langOf(ctx);
  const L = limText(lang);
  const res = await planSettingChange(opts.prisma, {
    botId: ctx.botMeta.id,
    kind,
    targetId: serviceId,
    newValue: value,
    author: {},
  });
  if (!res.ok) return replyError(ctx, res.error, kind);
  if (res.unchanged) {
    delete ctx.session.limits;
    await ctx.reply(L.unchanged);
    return;
  }
  const { plan } = res;
  const isTomorrow = plan.effectiveDate === addDaysToDateString(tashkentDateString(new Date()), 1);
  const phrase = effectivePhrase(lang, plan.effectiveDate, isTomorrow);
  const token = randomBytes(6).toString("hex");
  ctx.session.limits = {
    step: "confirm",
    kind,
    serviceId,
    newValue: value,
    oldValue: plan.current,
    effectiveDate: plan.effectiveDate,
    token,
    expiresAt: Date.now() + STATE_TTL_MS,
  };
  const service = plan.config.services.find((s) => s.id === serviceId);
  const text =
    kind === "MIN_LEAD"
      ? leadPreview(lang, plan.current, value, phrase)
      : pricePreview(
          lang,
          service?.name[lang === "UZ" ? "uz" : "ru"] ?? "",
          plan.current ?? 0,
          value,
          phrase,
        );
  const kb = new InlineKeyboard().text(L.btnConfirm, `lim:ok:${token}`).text(L.btnCancel, "lim:no");
  await ctx.reply(text, { reply_markup: kb });
}

async function startPriceInput(
  ctx: PlatformBotContext,
  opts: QuickBookComposerOptions,
  serviceId: string,
): Promise<void> {
  const lang = langOf(ctx);
  const config = await freshConfig(ctx, opts);
  const service = config.services.find((s) => s.id === serviceId);
  if (!service) {
    await ctx.reply(limText(lang).stale);
    return;
  }
  ctx.session.limits = {
    step: "price_input",
    kind: "SERVICE_PRICE",
    serviceId,
    expiresAt: Date.now() + STATE_TTL_MS,
  };
  await ctx.reply(
    limText(lang).pricePrompt(service.name[lang === "UZ" ? "uz" : "ru"], fmtUzs(service.priceUzs)),
  );
}

async function showLeadOptions(ctx: PlatformBotContext): Promise<void> {
  const lang = langOf(ctx);
  const L = limText(lang);
  const kb = new InlineKeyboard()
    .text(fmtLead(lang, 60), "lim:ld:60")
    .text(fmtLead(lang, 120), "lim:ld:120")
    .row()
    .text(L.btnOther, "lim:ld:o")
    .row()
    .text(L.btnBack, "lim:menu");
  await ctx.reply(L.leadChoose, { reply_markup: kb });
}

export function registerOwnerLimitsHandlers(
  bot: Bot<PlatformBotContext>,
  opts: QuickBookComposerOptions,
): void {
  const { prisma } = opts;
  const cb = async (ctx: PlatformBotContext) => {
    await ctx.answerCallbackQuery().catch(() => {});
    return ensureOwner(ctx, opts);
  };

  bot.callbackQuery("lim:menu", async (ctx) => {
    if (await cb(ctx)) await showOwnerSettings(ctx, opts);
  });
  bot.callbackQuery("lim:lead", async (ctx) => {
    if (await cb(ctx)) await showLeadOptions(ctx);
  });
  bot.callbackQuery(/^lim:ld:(60|120)$/, async (ctx) => {
    if (await cb(ctx)) await preview(ctx, opts, "MIN_LEAD", undefined, Number(ctx.match[1]));
  });
  bot.callbackQuery("lim:ld:o", async (ctx) => {
    if (!(await cb(ctx))) return;
    ctx.session.limits = {
      step: "lead_input",
      kind: "MIN_LEAD",
      expiresAt: Date.now() + STATE_TTL_MS,
    };
    await ctx.reply(limText(langOf(ctx)).leadPrompt);
  });
  bot.callbackQuery("lim:pr", async (ctx) => {
    if (!(await cb(ctx))) return;
    const L = limText(langOf(ctx));
    const config = await freshConfig(ctx, opts);
    const loc = langOf(ctx) === "UZ" ? "uz" : "ru";
    if (config.services.length === 0) {
      await ctx.reply(L.noServices);
      return;
    }
    const kb = new InlineKeyboard();
    for (const s of config.services)
      kb.text(`${s.name[loc]} — ${fmtUzs(s.priceUzs)}`, `lim:ps:${callbackId(s.id)}`).row();
    kb.text(L.btnBack, "lim:menu");
    await ctx.reply(L.priceChoose, { reply_markup: kb });
  });
  bot.callbackQuery(/^lim:ps:(~[a-f0-9]{12})$/, async (ctx) => {
    if (!(await cb(ctx))) return;
    const config = await freshConfig(ctx, opts);
    const serviceId = resolveCallbackId(config.services, ctx.match[1]);
    if (!serviceId) {
      await ctx.reply(limText(langOf(ctx)).stale);
      return;
    }
    await startPriceInput(ctx, opts, serviceId);
  });
  bot.callbackQuery(/^lim:rp:([0-9a-f-]{36})$/, async (ctx) => {
    if (!(await cb(ctx))) return;
    const change = await prisma.botSettingChange.findFirst({
      where: { id: ctx.match[1], botId: ctx.botMeta.id, status: "PENDING" },
    });
    if (!change) {
      await ctx.reply(limText(langOf(ctx)).cancelNone);
      return;
    }
    if (change.kind === "MIN_LEAD") await showLeadOptions(ctx);
    else await startPriceInput(ctx, opts, change.targetId);
  });
  bot.callbackQuery(/^lim:cx:([0-9a-f-]{36})$/, async (ctx) => {
    if (!(await cb(ctx)) || !ctx.from) return;
    const ok = await cancelPendingChange(prisma, {
      botId: ctx.botMeta.id,
      changeId: ctx.match[1]!,
      author: { tgId: ctx.from.id },
    });
    const required =
      !ok &&
      (await prisma.botSettingChange.findFirst({
        where: { id: ctx.match[1], botId: ctx.botMeta.id, kind: "MIN_LEAD", status: "PENDING" },
      }));
    await ctx.reply(
      limText(langOf(ctx))[ok ? "cancelled" : required ? "minimumRequired" : "cancelNone"],
    );
    if (ok) await showOwnerSettings(ctx, opts);
  });
  bot.callbackQuery("lim:no", async (ctx) => {
    if (!(await cb(ctx))) return;
    delete ctx.session.limits;
    await ctx.reply(limText(langOf(ctx)).notSaved);
  });

  bot.callbackQuery(/^lim:ok:([a-f0-9]{12})$/, async (ctx) => {
    if (!(await cb(ctx)) || !ctx.from) return;
    const lang = langOf(ctx);
    const L = limText(lang);
    const st = ctx.session.limits;
    if (
      !st ||
      st.step !== "confirm" ||
      st.token !== ctx.match[1] ||
      st.expiresAt < Date.now() ||
      !st.kind ||
      st.newValue === undefined ||
      !st.effectiveDate
    ) {
      delete ctx.session.limits;
      await ctx.reply(L.stale);
      return;
    }
    delete ctx.session.limits;
    const base = {
      botId: ctx.botMeta.id,
      kind: st.kind,
      targetId: st.serviceId,
      newValue: st.newValue,
      promisedDate: st.effectiveDate,
      author: { tgId: ctx.from.id },
    };
    const planned = await planSettingChange(prisma, base);
    if (!planned.ok) return replyError(ctx, planned.error, st.kind);
    if (planned.unchanged) {
      await ctx.reply(L.unchanged);
      return;
    }
    if (
      planned.plan.current !== (st.oldValue ?? null) ||
      planned.plan.effectiveDate !== st.effectiveDate
    ) {
      await ctx.reply(L.reconfirm);
      await preview(ctx, opts, st.kind, st.serviceId, st.newValue);
      return;
    }
    const res = await scheduleSettingChange(prisma, base);
    if (!res.ok) return replyError(ctx, res.error, st.kind);
    if (res.unchanged) {
      await ctx.reply(L.unchanged);
      return;
    }
    const isTomorrow = st.effectiveDate === addDaysToDateString(tashkentDateString(new Date()), 1);
    await ctx.reply(`${L.saved}\n${effectivePhrase(lang, st.effectiveDate, isTomorrow)}`);
  });

  bot.on("message:text", async (ctx, next) => {
    const st = ctx.session.limits;
    if (!st || (st.step !== "lead_input" && st.step !== "price_input")) return next();
    const text = ctx.message.text.trim();
    if (st.expiresAt < Date.now() || text.startsWith("/") || /^[^\p{L}\p{N}+\-.,\s]/u.test(text)) {
      delete ctx.session.limits;
      return next();
    }
    if (!(await ensureOwner(ctx, opts))) return next();
    const kind: Kind = st.step === "lead_input" ? "MIN_LEAD" : "SERVICE_PRICE";
    const digits = text.replace(/[\s_]/g, "");
    const value = /^\d{1,10}$/.test(digits) ? Number(digits) : Number.NaN;
    if (!validateChangeValue(kind, value)) {
      await replyError(ctx, "INVALID_VALUE", kind);
      return;
    }
    await preview(ctx, opts, kind, st.serviceId, value);
  });
}
