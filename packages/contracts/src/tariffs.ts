import type { TariffOption } from "./index.js";
export const DEFAULT_TARIFFS: readonly TariffOption[] = [
  { months: 1, amountUzs: 100000 },
  { months: 6, amountUzs: 500000 },
  { months: 12, amountUzs: 1000000 },
];
function isPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
/** Reads legacy settings without changing historical receipts or inventing a 6-month price from a 3-month tariff. */
export function normalizeTariffs(
  raw: unknown,
  defaults: readonly TariffOption[] = DEFAULT_TARIFFS,
): TariffOption[] {
  return ([1, 6, 12] as const).map((months) => {
    let amount: unknown;
    if (Array.isArray(raw)) {
      const item = raw.find(
        (value: unknown) =>
          value && typeof value === "object" && "months" in value && value.months === months,
      ) as Record<string, unknown> | undefined;
      amount = isPrice(item?.amountUzs) ? item.amountUzs : item?.priceUzs;
    } else if (raw && typeof raw === "object") {
      const legacy = raw as Record<string, unknown>;
      amount = isPrice(legacy[`${months}m`]) ? legacy[`${months}m`] : legacy[`tariff${months}m`];
    }
    const fallback = defaults.find((tariff) => tariff.months === months)?.amountUzs;
    return {
      months,
      amountUzs: isPrice(amount)
        ? amount
        : isPrice(fallback)
          ? fallback
          : DEFAULT_TARIFFS.find((tariff) => tariff.months === months)!.amountUzs,
    };
  });
}
