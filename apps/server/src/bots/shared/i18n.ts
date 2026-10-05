import type { Lang } from "@prisma/client";
import ruLocale from "./locales/ru.json" with { type: "json" };
import uzLocale from "./locales/uz.json" with { type: "json" };

export type TranslationKey = keyof typeof ruLocale;

export const LOCALES: Record<Lang, Record<TranslationKey, string>> = {
  RU: ruLocale,
  UZ: uzLocale,
};

export function t(
  lang: Lang | null | undefined,
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  const effectiveLang: Lang = lang === "UZ" ? "UZ" : "RU";
  const dict = LOCALES[effectiveLang];
  let text = dict[key] ?? LOCALES.RU[key] ?? key;

  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }

  return text;
}
