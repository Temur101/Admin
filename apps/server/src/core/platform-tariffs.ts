import { normalizeTariffs } from "@lcqb/contracts/tariffs";
import { env } from "./env.js";
export function platformTariffs(raw?: unknown) {
  return normalizeTariffs(raw, [
    { months: 1, amountUzs: env.TARIFF_1M_UZS },
    { months: 6, amountUzs: env.TARIFF_6M_UZS },
    { months: 12, amountUzs: env.TARIFF_12M_UZS },
  ]);
}
