import { InlineKeyboard } from "grammy";
import { escapeTelegramHtml as html, telegramHtmlPages } from "../../core/telegram-text.js";
import type { PlatformBotContext } from "../../gateway/types.js";
import type { QuickBookComposerOptions } from "./quickbook-handlers.js";
import { getQuickBookConfig } from "./config-resolver.js";
import { loadEffectiveConfig, listPendingChanges } from "./setting-changes.js";
import { tashkentDateString } from "./booking-horizon.js";
import { formatDateDmy } from "./setting-schedule.js";
import { limText, fmtLead, fmtUzs, type LimLang } from "./limits-texts.js";
const langOf = (ctx: PlatformBotContext): LimLang => ctx.session.lang ?? "RU";

export async function freshConfig(ctx: PlatformBotContext, opts: QuickBookComposerOptions) {
  return (
    (await loadEffectiveConfig(opts.prisma, ctx.botMeta.id)) ??
    getQuickBookConfig(ctx.botMeta.settings)
  );
}

export async function showOwnerSettings(
  ctx: PlatformBotContext,
  opts: QuickBookComposerOptions,
): Promise<void> {
  delete ctx.session.limits;
  const lang = langOf(ctx);
  const L = limText(lang);
  const loc = lang === "UZ" ? "uz" : "ru";
  const unit = lang === "UZ" ? "so'm" : "сум";
  const config = await freshConfig(ctx, opts);
  const pending = await listPendingChanges(opts.prisma, ctx.botMeta.id);
  const name = (id: string) => config.services.find((s) => s.id === id)?.name[loc] ?? id;
  const date = (d: Date) => formatDateDmy(tashkentDateString(d));

  const lines = [L.title, "", L.lead(fmtLead(lang, config.minLeadMinutes)), "", L.prices];
  for (const s of config.services)
    lines.push(`• ${html(s.name[loc])}: ${fmtUzs(s.priceUzs)} ${unit}`);
  if (pending.length > 0) {
    lines.push("", L.pending);
    for (const c of pending) {
      const line =
        c.kind === "MIN_LEAD"
          ? L.pendingLead(fmtLead(lang, c.oldValue), fmtLead(lang, c.newValue), date(c.effectiveAt))
          : L.pendingPrice(
              html(name(c.targetId)),
              fmtUzs(c.oldValue ?? 0),
              fmtUzs(c.newValue),
              date(c.effectiveAt),
            );
      lines.push(line);
    }
  }
  lines.push("", L.hours);
  for (const r of config.resources)
    lines.push(`• ${html(r.name[loc])}: ${r.workHours.start} - ${r.workHours.end}`);
  lines.push("", L.hint);

  const kb = new InlineKeyboard().text(L.btnLead, "lim:lead").row().text(L.btnPrices, "lim:pr");
  for (const c of pending) {
    const label = (c.kind === "MIN_LEAD" ? "⏱" : name(c.targetId)).slice(0, 24);
    kb.row()
      .text(L.btnReplace(label), `lim:rp:${c.id}`)
      .row()
      .text(L.btnDrop(label), `lim:cx:${c.id}`);
  }
  const pages = telegramHtmlPages(lines.join("\n"));
  for (const [i, page] of pages.entries()) {
    await ctx.reply(page, {
      parse_mode: "HTML",
      ...(i === pages.length - 1 ? { reply_markup: kb } : {}),
    });
  }
}
