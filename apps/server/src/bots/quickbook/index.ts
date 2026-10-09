import type { PrismaClient } from "@prisma/client";
import type { Bot } from "grammy";
import type { Redis } from "ioredis";
import type { TelegramTransport } from "../../adapters/telegram/transport.js";
import type { Logger } from "../../core/logger.js";
import type { PlatformBotContext } from "../../gateway/types.js";
import {
  registerQuickBookHandlers,
  startQuickBookFlow,
} from "./quickbook-composer.js";

export * from "./default-config.js";
export * from "./config-resolver.js";
export * from "./slot-lock.js";
export * from "./slot-generator.js";
export * from "./booking-service.js";
export * from "./quickbook-composer.js";

export interface QuickBookBotOptions {
  prisma: PrismaClient;
  redis: Redis;
  transport: TelegramTransport;
  logger: Logger;
}

export function registerQuickBookBot(
  bot: Bot<PlatformBotContext>,
  opts: QuickBookBotOptions,
): void {
  // /book command allows manually starting the booking flow
  bot.command("book", async (ctx) => {
    await startQuickBookFlow(ctx, opts.prisma);
  });

  registerQuickBookHandlers(bot, opts);
}
