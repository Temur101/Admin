import { Keyboard } from "grammy";
import type { Lang } from "@prisma/client";
import type { PlatformBotContext } from "../../gateway/types.js";
import { buildAdminReplyKeyboard } from "./admin-menu.js";
import { t } from "./i18n.js";

export function clientMenuKeyboard(lang: Lang = "RU", botType?: string): Keyboard {
  const kb = new Keyboard().text(t(lang, botType === "QUICKBOOK" ? "client_book" : "client_quiz"));
  if (botType === "QUICKBOOK") {
    kb.text(t(lang, "client_my_bookings"));
  }
  return kb
    .row()
    .text(t(lang, "client_menu"))
    .text(t(lang, "client_language"))
    .resized()
    .persistent();
}

export function navigationKeyboard(ctx: PlatformBotContext): Keyboard {
  return ctx.session.isAdmin
    ? buildAdminReplyKeyboard(ctx.session.lang, ctx.botMeta.botType, ctx.session.adminRole)
    : clientMenuKeyboard(ctx.session.lang, ctx.botMeta.botType);
}

export function contactKeyboard(ctx: PlatformBotContext): Keyboard {
  return new Keyboard()
    .requestContact(t(ctx.session.lang, "quiz_btn_share_phone"))
    .row()
    .text(t(ctx.session.lang, "btn_back"))
    .text(t(ctx.session.lang, "btn_restart"))
    .row()
    .text(t(ctx.session.lang, "client_menu"))
    .resized()
    .persistent();
}
