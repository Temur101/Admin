import { describe, expect, it } from "vitest";
import { LOCALES, t, type TranslationKey } from "../src/bots/shared/i18n.js";
import ruJson from "../src/bots/shared/locales/ru.json" with { type: "json" };
import uzJson from "../src/bots/shared/locales/uz.json" with { type: "json" };

describe("i18n Dictionaries & Interpolation", () => {
  it("should have identical translation keys in both ru.json and uz.json", () => {
    const ruKeys = Object.keys(ruJson).sort();
    const uzKeys = Object.keys(uzJson).sort();

    expect(ruKeys).toEqual(uzKeys);
    expect(ruKeys.length).toBeGreaterThan(15);
  });

  it("should correctly interpolate parameters into templates", () => {
    const interpolated = t("RU", "sub_status_trial", { date: "01.01.2027" });
    expect(interpolated).toBe("Пробный период (до 01.01.2027)");

    const uzInterpolated = t("UZ", "sub_status_trial", { date: "01.01.2027" });
    expect(uzInterpolated).toBe("Sinov muddati (01.01.2027 gacha)");
  });

  it("should fall back to Russian when language is unspecified", () => {
    const text = t(null, "welcome_client");
    expect(text).toBe("Добро пожаловать!");
  });

  it("should contain all mandatory admin and subscription keys", () => {
    const requiredKeys: TranslationKey[] = [
      "choose_language",
      "language_selected",
      "welcome_client",
      "welcome_admin",
      "admin_menu_leads",
      "admin_menu_sub",
      "admin_menu_lang",
      "sub_expired_alert",
      "sub_blocked_alert",
      "btn_pay",
      "lead_notification_open",
      "lead_notification_masked",
      "booking_notification_open",
      "booking_notification_masked",
    ];

    for (const key of requiredKeys) {
      expect(LOCALES.RU[key]).toBeDefined();
      expect(LOCALES.UZ[key]).toBeDefined();
    }
  });
});
