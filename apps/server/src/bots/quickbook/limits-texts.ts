import { MAX_PRICE_UZS, MIN_LEAD_MINUTES_FLOOR } from "@lcqb/contracts";
import { formatDateDmy } from "./setting-schedule.js";

export type LimLang = "RU" | "UZ";

export function fmtUzs(n: number): string {
  return n.toLocaleString("ru-RU").replace(/[\u00A0\u202F]/g, " ");
}

function ruPlural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export function fmtLead(lang: LimLang, minutes: number | null | undefined): string {
  if (minutes == null) return lang === "UZ" ? "cheklanmagan" : "не ограничено";
  const hours = minutes / 60;
  if (Number.isInteger(hours)) {
    return lang === "UZ"
      ? `${hours} soat`
      : `${hours} ${ruPlural(hours, "час", "часа", "часов")}`;
  }
  return lang === "UZ"
    ? `${minutes} daqiqa`
    : `${minutes} ${ruPlural(minutes, "минута", "минуты", "минут")}`;
}

export function effectivePhrase(lang: LimLang, date: string, isTomorrow: boolean): string {
  const d = formatDateDmy(date);
  if (lang === "UZ") {
    return isTomorrow
      ? `O'zgarish ertaga, ${d} kuni kuchga kiradi. Bugun avvalgi qiymat amal qiladi.`
      : `O'zgarish keyingi ish kuni, ${d} kuni kuchga kiradi. Bugun avvalgi qiymat amal qiladi.`;
  }
  return isTomorrow
    ? `Изменение вступит в силу завтра, ${d}. Сегодня действует прежнее значение.`
    : `Изменение вступит в силу в следующий рабочий день, ${d}. Сегодня действует прежнее значение.`;
}

export function leadPreview(
  lang: LimLang,
  from: number | null,
  to: number,
  phrase: string,
): string {
  return lang === "UZ"
    ? `Hozir: ${fmtLead(lang, from)}.\nYangi qiymat: ${fmtLead(lang, to)}.\n${phrase}`
    : `Сейчас: ${fmtLead(lang, from)}.\nНовое значение: ${fmtLead(lang, to)}.\n${phrase}`;
}

export function pricePreview(
  lang: LimLang,
  service: string,
  from: number,
  to: number,
  phrase: string,
): string {
  return lang === "UZ"
    ? `Xizmat: ${service}.\nHozir: ${fmtUzs(from)} so'm.\nYangi narx: ${fmtUzs(to)} so'm.\n${phrase}`
    : `Услуга: ${service}.\nСейчас: ${fmtUzs(from)} сум.\nНовая цена: ${fmtUzs(to)} сум.\n${phrase}`;
}

export function priceLine(lang: LimLang, price: number | null | undefined): string {
  if (price == null) return "";
  return lang === "UZ" ? `💰 Narxi: ${fmtUzs(price)} so'm` : `💰 Стоимость: ${fmtUzs(price)} сум`;
}

export function tooSoonNotice(lang: LimLang, minutes: number | undefined): string {
  const lead = fmtLead(lang, minutes ?? 60);
  return lang === "UZ"
    ? `Bu vaqt endi mavjud emas: yozilish kamida ${lead} oldin mumkin. Dolzarb vaqtni tanlang:`
    : `Это время уже недоступно: запись возможна не раньше чем за ${lead}. Выберите актуальное время:`;
}

export function priceChangedNotice(lang: LimLang, price: number): string {
  return lang === "UZ"
    ? `Xizmat narxi o'zgardi: endi ${fmtUzs(price)} so'm. Yangi natijani tekshirib, qayta tasdiqlang.`
    : `Цена услуги изменилась: теперь ${fmtUzs(price)} сум. Проверьте новый итог и подтвердите ещё раз.`;
}

const RU = {
  title: "⚙️ <b>Настройки бота</b>",
  lead: (v: string) => `⏱ Мин. время до онлайн-записи: <b>${v}</b>`,
  prices: "<b>Цены услуг:</b>",
  pending: "<b>Ожидающие изменения:</b>",
  pendingLead: (a: string, b: string, d: string) => `⏱ Мин. время: ${a} → ${b} (с ${d})`,
  pendingPrice: (n: string, a: string, b: string, d: string) =>
    `💰 ${n}: ${a} → ${b} сум (с ${d})`,
  hours: "<b>Рабочие часы:</b>",
  hint: "<i>Состав услуг и мастеров, названия, длительность и расписание меняются только в веб-панели.</i>",
  btnLead: "⏱ Мин. время до записи",
  btnPrices: "💰 Цены услуг",
  btnBack: "« Назад",
  btnConfirm: "✅ Подтвердить",
  btnCancel: "❌ Отмена",
  btnOther: "Другое время",
  btnReplace: (s: string) => `✏️ Заменить: ${s}`,
  btnDrop: (s: string) => `🗑 Отменить: ${s}`,
  leadChoose: `Выберите минимальное время до онлайн-записи (не меньше ${MIN_LEAD_MINUTES_FLOOR} минут).`,
  leadPrompt: `Введите целое число минут, не меньше ${MIN_LEAD_MINUTES_FLOOR}.`,
  leadInvalid: `Нужно целое число минут, не меньше ${MIN_LEAD_MINUTES_FLOOR}. Попробуйте ещё раз.`,
  priceChoose: "Выберите услугу, у которой нужно изменить цену.",
  pricePrompt: (n: string, p: string) =>
    `Услуга: ${n}. Сейчас: ${p} сум.\nВведите новую цену в сумах (целое число от 0).`,
  priceInvalid: `Нужна целая неотрицательная сумма не больше ${fmtUzs(MAX_PRICE_UZS)}. Попробуйте ещё раз.`,
  stale: "Данные устарели. Откройте «Настройки» заново.",
  denied: "Доступ запрещён",
  noWorkingDay:
    "Не удалось определить следующий рабочий день. Настройте расписание мастеров в веб-панели.",
  unchanged:
    "Новое значение совпадает с текущим — изменений нет. Ожидающее изменение можно отменить в «Настройках».",
  saved: "✅ Сохранено.",
  notSaved: "Изменение не сохранено.",
  cancelled: "Ожидающее изменение отменено.",
  cancelNone: "Это изменение уже не ожидает применения.",
  reconfirm: "Данные изменились, пока вы подтверждали. Проверьте новый итог и подтвердите ещё раз.",
  noServices: "Услуги не настроены. Добавьте их в веб-панели.",
};

const UZ: typeof RU = {
  title: "⚙️ <b>Bot sozlamalari</b>",
  lead: (v) => `⏱ Onlayn yozilishgacha minimal vaqt: <b>${v}</b>`,
  prices: "<b>Xizmatlar narxi:</b>",
  pending: "<b>Kutilayotgan o'zgarishlar:</b>",
  pendingLead: (a, b, d) => `⏱ Minimal vaqt: ${a} → ${b} (${d} dan)`,
  pendingPrice: (n, a, b, d) => `💰 ${n}: ${a} → ${b} so'm (${d} dan)`,
  hours: "<b>Ish vaqtlari:</b>",
  hint: "<i>Xizmatlar, mutaxassislar, nomlar, davomiylik va jadval faqat veb-panelda o'zgartiriladi.</i>",
  btnLead: "⏱ Yozilishgacha minimal vaqt",
  btnPrices: "💰 Xizmatlar narxi",
  btnBack: "« Orqaga",
  btnConfirm: "✅ Tasdiqlash",
  btnCancel: "❌ Bekor qilish",
  btnOther: "Boshqa vaqt",
  btnReplace: (s) => `✏️ Almashtirish: ${s}`,
  btnDrop: (s) => `🗑 Bekor qilish: ${s}`,
  leadChoose: `Onlayn yozilishgacha minimal vaqtni tanlang (kamida ${MIN_LEAD_MINUTES_FLOOR} daqiqa).`,
  leadPrompt: `Daqiqalar sonini butun son sifatida kiriting, kamida ${MIN_LEAD_MINUTES_FLOOR}.`,
  leadInvalid: `Butun son kerak, kamida ${MIN_LEAD_MINUTES_FLOOR} daqiqa. Qayta urinib ko'ring.`,
  priceChoose: "Narxini o'zgartirmoqchi bo'lgan xizmatni tanlang.",
  pricePrompt: (n, p) =>
    `Xizmat: ${n}. Hozir: ${p} so'm.\nYangi narxni so'mda kiriting (0 dan boshlab butun son).`,
  priceInvalid: `Manfiy bo'lmagan butun son kerak, ${fmtUzs(MAX_PRICE_UZS)} dan oshmasin. Qayta urinib ko'ring.`,
  stale: "Ma'lumotlar eskirgan. «Sozlamalar»ni qayta oching.",
  denied: "Ruxsat yo'q",
  noWorkingDay:
    "Keyingi ish kunini aniqlab bo'lmadi. Mutaxassislar jadvalini veb-panelda sozlang.",
  unchanged:
    "Yangi qiymat joriy qiymat bilan bir xil — o'zgarish yo'q. Kutilayotgan o'zgarishni «Sozlamalar»da bekor qilish mumkin.",
  saved: "✅ Saqlandi.",
  notSaved: "O'zgarish saqlanmadi.",
  cancelled: "Kutilayotgan o'zgarish bekor qilindi.",
  cancelNone: "Bu o'zgarish endi kutilmaydi.",
  reconfirm:
    "Tasdiqlash vaqtida ma'lumotlar o'zgardi. Yangi natijani tekshirib, qayta tasdiqlang.",
  noServices: "Xizmatlar sozlanmagan. Ularni veb-panelda qo'shing.",
};

export const limText = (lang: LimLang | undefined) => (lang === "UZ" ? UZ : RU);
