import { escapeTelegramHtml as html, telegramHtmlPages } from "../../core/telegram-text.js";
import { maskName, maskPhone } from "../shared/masking.js";
import { isMaskedStatus } from "../shared/subscription.js";
import type { Booking, PrismaClient } from "@prisma/client";
import type { QuickBookConfig } from "@lcqb/contracts";
import type { PlatformBotContext } from "../../gateway/types.js";
import { getQuickBookConfig } from "./config-resolver.js";
import { getTashkentTimeParts } from "./booking-validator.js";
import { parseTashkentDate } from "./slot-generator.js";

function formatAdminBookingLine(
  b: Booking,
  index: number,
  config: QuickBookConfig,
  lang: "RU" | "UZ",
  masked: boolean,
): string {
  const loc = lang === "UZ" ? "uz" : "ru";
  const timeStr = b.slotTime.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Tashkent",
  });
  const service = config.services.find((s) => s.id === b.serviceId);
  const staff = config.resources.find((r) => r.id === b.staffId);
  const serviceName = service?.name[loc] || b.serviceName;
  const staffName = staff?.name[loc] || b.staffId;
  const src = b.source === "MANUAL" ? (lang === "UZ" ? " [Qo'lda]" : " [Ручная]") : "";
  const name = masked ? maskName(b.customerName) : b.customerName;
  const phone = masked ? maskPhone(b.customerPhone) : b.customerPhone;
  const customer = name ? `${html(name)} (${html(phone)})` : html(phone);
  const serviceLabel = lang === "UZ" ? "Xizmat" : "Услуга";

  return `${index + 1}. ${timeStr} — ${customer}\n   ${serviceLabel}: ${html(serviceName)} (${html(staffName)})${src}`;
}

export async function handleAdminBookingsList(
  ctx: PlatformBotContext,
  prisma: PrismaClient,
): Promise<void> {
  const now = new Date();
  const { dateStr } = getTashkentTimeParts(now);
  const { dayStartUtc } = parseTashkentDate(dateStr);

  const bookings = await prisma.booking.findMany({
    where: {
      botId: ctx.botMeta.id,
      status: { in: ["CONFIRMED", "PENDING"] },
      slotTime: { gte: dayStartUtc },
    },
    orderBy: { slotTime: "asc" },
    take: 50,
  });

  const isUz = ctx.session.lang === "UZ";
  const lang = ctx.session.lang ?? "RU";

  if (bookings.length === 0) {
    await ctx.reply(isUz ? "Yaqin orada buyurtmalar yo'q." : "Предстоящих записей пока нет.");
    return;
  }

  const upcoming = bookings.filter((b) => b.slotTime.getTime() >= now.getTime());
  const pastToday = bookings.filter((b) => b.slotTime.getTime() < now.getTime());

  const config = getQuickBookConfig(ctx.botMeta.settings);
  const sections: string[] = [];

  if (upcoming.length > 0) {
    const upcomingHeader = isUz
      ? "📅 <b>Kutilayotgan buyurtmalar:</b>"
      : "📅 <b>Предстоящие записи:</b>";
    const upcomingLines = upcoming.map((b, i) =>
      formatAdminBookingLine(b, i, config, lang, isMaskedStatus(ctx.botMeta.subscriptionStatus)),
    );
    sections.push(`${upcomingHeader}\n\n${upcomingLines.join("\n\n")}`);
  } else if (pastToday.length > 0) {
    const noUpcoming = isUz
      ? "📅 <b>Предстоящие записи:</b>\n<i>Hozircha yaqinlashib kelayotgan buyurtmalar yo'q</i>"
      : "📅 <b>Предстоящие записи:</b>\n<i>Предстоящих записей пока нет</i>";
    sections.push(noUpcoming);
  }

  if (pastToday.length > 0) {
    const pastHeader = isUz
      ? "⏳ <b>Bugungi o'tgan buyurtmalar:</b>"
      : "⏳ <b>Прошедшие записи за сегодня:</b>";
    const pastLines = pastToday.map((b, i) =>
      formatAdminBookingLine(b, i, config, lang, isMaskedStatus(ctx.botMeta.subscriptionStatus)),
    );
    sections.push(`${pastHeader}\n\n${pastLines.join("\n\n")}`);
  }

  for (const page of telegramHtmlPages(sections.join("\n\n──────────────────\n\n")))
    await ctx.reply(page, { parse_mode: "HTML" });
}
