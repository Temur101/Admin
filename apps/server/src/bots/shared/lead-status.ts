import type { Lang, LeadStatus } from "@prisma/client";
import { t } from "./i18n.js";

export function formatLeadStatusLabel(status: LeadStatus | undefined, lang: Lang): string {
  switch (status) {
    case "IN_PROGRESS":
      return t(lang, "lead_status_in_progress");
    case "DONE":
      return t(lang, "lead_status_done");
    case "REJECTED":
      return t(lang, "lead_status_rejected");
    default:
      return t(lang, "lead_status_new");
  }
}
