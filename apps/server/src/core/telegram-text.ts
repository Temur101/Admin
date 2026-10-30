/** Display values remain single-line and bounded; original database values are preserved. */
export function escapeTelegramHtml(value: unknown, limit = 120): string {
  const chars = Array.from(String(value ?? "").replace(/[\r\n]+/g, " "));
  const text = chars.slice(0, limit).join("") + (chars.length > limit ? "…" : "");
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Call with balanced markup on each line (all user values must be escaped first). */
export function telegramHtmlPages(text: string): string[] {
  const pages: string[] = [];
  let page = "";
  for (const line of text.split("\n")) {
    if (line.length > 3900) throw new Error("Telegram HTML line exceeds safe message length");
    if (page && page.length + line.length + 1 > 3900) {
      pages.push(page);
      page = "";
    }
    page = page ? `${page}\n${line}` : line;
  }
  if (page) pages.push(page);
  return pages;
}
