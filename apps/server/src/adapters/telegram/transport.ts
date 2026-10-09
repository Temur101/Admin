import { Api, type Transformer } from "grammy";

/**
 * Telegram transport adapter.
 *
 * Every grammY `Bot` / `Api` instance created by the platform gets the transport's
 * transformer installed. The real transport installs nothing (requests go to
 * api.telegram.org); the mock transport intercepts every call in-process.
 *
 * Switched in one place via USE_MOCK_TELEGRAM (see google_antigravity_agent_rules.md §2).
 */
export interface TelegramTransport {
  readonly kind: "real" | "mock";
  /** Transformer to install into a bot's API client, or null for direct network access. */
  transformerFor(botId: string): Transformer | null;
  /** Downloads a file buffer from Telegram API */
  downloadFile(token: string, filePath: string): Promise<Buffer>;
}

class RealTelegramTransport implements TelegramTransport {
  readonly kind = "real" as const;

  transformerFor(): Transformer | null {
    return null;
  }

  async downloadFile(token: string, filePath: string): Promise<Buffer> {
    const url = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Failed to download Telegram file: ${res.statusText}`);
    }
    const arrayBuf = await res.arrayBuffer();
    return Buffer.from(arrayBuf);
  }
}

export function createRealTelegramTransport(): TelegramTransport {
  return new RealTelegramTransport();
}

/** Builds a raw `Api` client (no update handling) wired to the given transport. */
export function createBotApi(token: string, botId: string, transport: TelegramTransport): Api {
  const api = new Api(token);
  const transformer = transport.transformerFor(botId);
  if (transformer) api.config.use(transformer);
  return api;
}
