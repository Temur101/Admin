import { createHash } from "node:crypto";
/** Short ASCII tokens keep callback_data within Telegram's 64-byte limit, regardless of stored ID length. */
export function callbackId(id: string): string {
  return `~${createHash("sha256").update(id).digest("hex").slice(0, 12)}`;
}
export function resolveCallbackId(items: { id: string }[], token?: string): string | undefined {
  if (!token) return undefined;
  const matches = items.filter((item) => item.id === token || callbackId(item.id) === token);
  return matches.length === 1 ? matches[0]!.id : undefined;
}
