import type { Transformer } from "grammy";
import type { TelegramTransport } from "./transport.js";

export interface RecordedTelegramCall {
  botId: string;
  method: string;
  payload: Record<string, unknown>;
}

const MAX_RECORDED_CALLS = 1000;

/**
 * In-process Telegram transport for automated tests and offline development.
 * Never touches the network. Records the last MAX_RECORDED_CALLS calls in a ring
 * buffer (bounded, so long-running load tests cannot leak memory).
 */
export class MockTelegramTransport implements TelegramTransport {
  readonly kind = "mock" as const;
  private readonly recorded: RecordedTelegramCall[] = [];
  private messageSeq = 1;

  get calls(): readonly RecordedTelegramCall[] {
    return this.recorded;
  }

  callsOf(method: string): RecordedTelegramCall[] {
    return this.recorded.filter((c) => c.method === method);
  }

  clear(): void {
    this.recorded.length = 0;
  }

  transformerFor(botId: string): Transformer {
    const transformer: Transformer = async (_prev, method, payload) => {
      const plainPayload = (payload ?? {}) as Record<string, unknown>;
      this.recorded.push({ botId, method, payload: plainPayload });
      if (this.recorded.length > MAX_RECORDED_CALLS) this.recorded.shift();
      if (method === "getUpdates") {
        await new Promise((r) => setTimeout(r, 20));
      }
      const result: unknown = this.resultFor(botId, method, plainPayload);
      // The transformer contract is generic over every Bot API method; the synthetic
      // result is shaped per method in resultFor(), so we widen it here.
      return { ok: true, result } as never;
    };
    return transformer;
  }

  private readonly mockFiles = new Map<string, Buffer>();

  setMockFile(filePathOrId: string, buffer: Buffer): void {
    this.mockFiles.set(filePathOrId, buffer);
  }

  async downloadFile(_token: string, filePath: string): Promise<Buffer> {
    const file = this.mockFiles.get(filePath);
    if (file) return file;
    // Default valid PNG 1x1 image buffer
    return Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
      0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
      0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
      0x42, 0x60, 0x82,
    ]);
  }

  private resultFor(botId: string, method: string, payload: Record<string, unknown>): unknown {
    switch (method) {
      case "getFile": {
        const fileId = String(payload.file_id ?? "mock_file_id");
        return {
          file_id: fileId,
          file_unique_id: `uniq_${fileId}`,
          file_size: typeof payload.file_size === "number" ? payload.file_size : 1024,
          file_path: `photos/${fileId}.png`,
        };
      }
      case "getMe":
        return {
          id: syntheticBotId(botId),
          is_bot: true,
          first_name: "Mock Bot",
          username: `mock_${botId.slice(0, 8)}_bot`,
          can_join_groups: false,
          can_read_all_group_messages: false,
          supports_inline_queries: false,
          can_connect_to_business: false,
          has_main_web_app: false,
        };
      case "sendMessage":
      case "editMessageText":
        return {
          message_id: this.messageSeq++,
          date: Math.floor(Date.now() / 1000),
          chat: { id: Number(payload.chat_id ?? 0), type: "private" },
          text: typeof payload.text === "string" ? payload.text : "",
        };
      case "getUpdates":
        return [];
      default:
        return true;
    }
  }
}

/** Stable positive integer derived from the bot UUID so getMe looks realistic. */
function syntheticBotId(botId: string): number {
  let h = 0;
  for (const ch of botId) h = (h * 31 + ch.charCodeAt(0)) % 2_000_000_000;
  return h + 1;
}
