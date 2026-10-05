import { MockTelegramTransport } from "./mock-transport.js";
import { createRealTelegramTransport, type TelegramTransport } from "./transport.js";

export type { TelegramTransport };

/** The single switch point between real Telegram and the in-process mock. */
export function createTelegramTransport(useMock: boolean): TelegramTransport {
  return useMock ? new MockTelegramTransport() : createRealTelegramTransport();
}

