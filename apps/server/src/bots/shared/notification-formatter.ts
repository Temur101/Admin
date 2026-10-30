import { t } from "./i18n.js";
import { maskName, maskPhone, maskUsername } from "./masking.js";

export function textChunks(text: string): string[] {
  const chunks: string[] = [];
  let chunk = "";
  for (const character of text) {
    if (chunk.length + character.length > 4000) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

export function formatLeadNotificationText(params: {
  lang: "RU" | "UZ";
  masked: boolean;
  name?: string | null;
  phone: string;
  phoneVerified?: boolean;
  username?: string | null;
  answers: Record<string, unknown>;
  statusLine?: string;
  assigneeLine?: string;
}): string {
  const { lang, masked, name, phone, phoneVerified, username, answers, statusLine, assigneeLine } =
    params;
  const answersStr = Object.entries(answers)
    .map(([q, a]) => `• ${q}: ${String(a)}`)
    .join("\n");

  const verifiedBadge =
    phoneVerified === undefined
      ? ""
      : ` (${t(lang, phoneVerified ? "phone_verified_badge" : "phone_unverified_badge")})`;

  let base: string;
  if (masked) {
    base = t(lang, "lead_notification_masked", {
      name: maskName(name),
      phone: maskPhone(phone),
      username: maskUsername(username),
      answers: answersStr,
    });
  } else {
    base = t(lang, "lead_notification_open", {
      name: name || "—",
      phone: `${phone}${verifiedBadge}`,
      username: username ? `@${username}` : "—",
      answers: answersStr,
    });
  }

  const extras = [statusLine, assigneeLine].filter(Boolean);
  return extras.length > 0 ? `${base}\n\n${extras.join("\n")}` : base;
}
