import { navigationKeyboard } from "../shared/client-menu.js";
import { resetClientFlow } from "../shared/flow-reset.js";
import { callbackId } from "../shared/callback-id.js";
import { RESOURCE_LABELS } from "@lcqb/contracts";
import type { PrismaClient } from "@prisma/client";
import { InlineKeyboard } from "grammy";
import type { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import type { TelegramTransport } from "../../adapters/telegram/transport.js";
import type { Logger } from "../../core/logger.js";
import type { PlatformBotContext } from "../../gateway/types.js";
import { t } from "../shared/i18n.js";
import { parseAndNormalizePhone } from "../shared/phone.js";
import { getQuickBookConfig } from "./config-resolver.js";
import { type TimeSlot } from "./slot-generator.js";
import { createBooking, formatTashkentDateTime } from "./booking-service.js";

export interface QuickBookComposerOptions {
  prisma: PrismaClient;
  redis: Redis;
  transport: TelegramTransport;
  logger: Logger;
}

export async function startQuickBookFlow(
  ctx: PlatformBotContext,
  _prisma: PrismaClient,
  redis?: Redis,
): Promise<void> {
  if (!(await resetClientFlow(ctx, redis))) return;
  const lang = ctx.session.lang ?? "RU";
  const config = getQuickBookConfig(ctx.botMeta.settings);

  ctx.session.quickbook = {};
  if (config.services.length === 0 || config.resources.length === 0) {
    await ctx.reply(t(lang, "bot_not_configured"));
    return;
  }

  const keyboard = new InlineKeyboard();
  for (const srv of config.services) {
    const srvName = lang === "UZ" ? srv.name.uz : srv.name.ru;
    const label = `${srvName} (${srv.durationMin} мин, ${srv.priceUzs.toLocaleString()} сум)`;
    keyboard.text(label, `qb:srv:${callbackId(srv.id)}`).row();
  }

  const title = t(lang, "qb_choose_service");
  await ctx.reply(title, { reply_markup: keyboard });
}

export async function renderAlternativeSlots(
  ctx: PlatformBotContext,
  slots: TimeSlot[],
  serviceId: string,
  _staffId: string,
): Promise<void> {
  const lang = ctx.session.lang ?? "RU";
  const keyboard = new InlineKeyboard();

  for (const slot of slots.slice(0, 4)) {
    const label = `${slot.timeLabel} (${slot.staffName})`;
    keyboard
      .text(
        label,
        `qb:slot:${callbackId(serviceId)}:${callbackId(slot.staffId)}:${slot.slotTimeIso}`,
      )
      .row();
  }
  keyboard
    .text(t(lang, "btn_back"), `qb:back:res:${callbackId(serviceId)}`)
    .text(t(lang, "btn_restart"), "qb:restart");

  await ctx.reply(t(lang, "qb_slot_taken"), { reply_markup: keyboard });
}

export async function promptQuickBookSummary(
  ctx: PlatformBotContext,
  rawPhone: string,
  phoneVerified: boolean,
  _opts: QuickBookComposerOptions,
): Promise<void> {
  const lang = ctx.session.lang ?? "RU";
  const session = ctx.session.quickbook;
  if (!session?.serviceId || !session.resourceId || !session.slotTimeIso || !ctx.from) {
    return;
  }

  const phoneRes = parseAndNormalizePhone(rawPhone);
  if (!phoneRes.isValid || !phoneRes.normalized) {
    await ctx.reply(t(lang, "quiz_invalid_phone"));
    return;
  }

  const config = getQuickBookConfig(ctx.botMeta.settings);
  const srv = config.services.find((s) => s.id === session.serviceId);
  const staff = config.resources.find((r) => r.id === session.resourceId);
  const srvName = srv ? (lang === "UZ" ? srv.name.uz : srv.name.ru) : session.serviceId;
  const staffName = staff ? (lang === "UZ" ? staff.name.uz : staff.name.ru) : session.resourceId;
  const label = config.resourceLabel
    ? lang === "UZ"
      ? config.resourceLabel.uz
      : config.resourceLabel.ru
    : RESOURCE_LABELS[config.resourceType][lang === "UZ" ? "uz" : "ru"];

  const runId = session.runId ?? randomUUID().slice(0, 8);
  session.runId = runId;
  session.phone = phoneRes.normalized;
  session.phoneVerified = phoneVerified;
  session.step = "summary";

  const verifiedLabel = t(
    lang,
    phoneVerified ? "phone_verified_badge" : "phone_unverified_badge",
  );

  const summaryText = t(lang, "qb_summary_title", {
    service: srvName,
    label,
    resource: staffName,
    time: formatTashkentDateTime(new Date(session.slotTimeIso)),
    phone: phoneRes.normalized,
    verified: verifiedLabel,
  });

  const kb = new InlineKeyboard()
    .text(t(lang, "btn_confirm_submit"), `qb:confirm_book:${runId}`)
    .text(t(lang, "btn_edit_field"), `qb:edit:${runId}`)
    .row()
    .text(t(lang, "btn_back"), `qb:back:phone:${runId}`)
    .text(t(lang, "btn_restart"), `qb:restart:${runId}`);

  await ctx.reply(summaryText, { reply_markup: kb });
}

export async function sendQuickBookEditMenu(ctx: PlatformBotContext): Promise<void> {
  const lang = ctx.session.lang ?? "RU";
  const session = ctx.session.quickbook;
  if (!session?.serviceId || !session.resourceId) return;
  const config = getQuickBookConfig(ctx.botMeta.settings);
  const label = config.resourceLabel
    ? lang === "UZ"
      ? config.resourceLabel.uz
      : config.resourceLabel.ru
    : RESOURCE_LABELS[config.resourceType][lang === "UZ" ? "uz" : "ru"];
  const runId = session.runId ?? "0";
  const kb = new InlineKeyboard()
    .text(t(lang, "qb_edit_service"), "qb:back:srv")
    .row()
    .text(label, `qb:back:res:${callbackId(session.serviceId)}`)
    .row()
    .text(
      t(lang, "qb_edit_time"),
      `qb:back:date:${callbackId(session.serviceId)}:${callbackId(session.resourceId)}`,
    )
    .row()
    .text(t(lang, "btn_edit_phone"), `qb:back:phone:${runId}`);
  await ctx.reply(t(lang, "qb_edit_choose_field"), { reply_markup: kb });
}

export async function handleQuickBookContact(
  ctx: PlatformBotContext,
  rawPhone: string,
  opts: QuickBookComposerOptions,
  phoneVerified = false,
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
  let bookingRes;
  try {
    bookingRes = await createBooking({
      prisma: opts.prisma,
      redis: opts.redis,
      transport: opts.transport,
      logger: opts.logger,
      botId: ctx.botMeta.id,
      customerTgId: ctx.from.id,
      customerName:
        session.customerName ?? [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" "),
      customerPhone: phoneRes.normalized ?? rawPhone,
      phoneVerified: session.phoneVerified ?? phoneVerified,
      serviceId: session.serviceId,
      staffId: session.resourceId,
      slotTime: session.slotTimeIso,
      lockToken: session.lockToken,
      config,
      lang,
    });
  } catch (err) {
    opts.logger.error(
      { err: err instanceof Error ? err.message : String(err), botId: ctx.botMeta.id },
      "Failed to save booking to database",
    );
    await ctx.reply(t(lang, "quiz_save_failed"));
    return;
  }

  if (bookingRes.success) {
    const srv = config.services.find((s) => s.id === bookingRes.booking.serviceId);
    const staff = config.resources.find((r) => r.id === bookingRes.booking.staffId);
    const srvName = srv
      ? lang === "UZ"
        ? srv.name.uz
        : srv.name.ru
      : bookingRes.booking.serviceName;
    const staffName = staff
      ? lang === "UZ"
        ? staff.name.uz
        : staff.name.ru
      : bookingRes.booking.staffId;
    const label = config.resourceLabel
      ? lang === "UZ"
        ? config.resourceLabel.uz
        : config.resourceLabel.ru
      : RESOURCE_LABELS[config.resourceType][lang === "UZ" ? "uz" : "ru"];

    const timeStr = formatTashkentDateTime(bookingRes.booking.slotTime);
    const successMsg = t(lang, "qb_booking_success", {
      service: srvName,
      label,
      resource: staffName,
      time: timeStr,
    });

    await ctx.reply(successMsg, {
      reply_markup: navigationKeyboard(ctx),
    });
    if (ctx.session.quickbook === session) delete ctx.session.quickbook;
  } else if ("alternativeSlots" in bookingRes) {
    await renderAlternativeSlots(
      ctx,
      bookingRes.alternativeSlots,
      session.serviceId,
      session.resourceId,
    );
  } else {
    await ctx.reply(t(lang, "quiz_invalid_phone"));
  }
}
