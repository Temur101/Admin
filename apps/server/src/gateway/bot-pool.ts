import { Bot, session } from "grammy";
import { RedisAdapter } from "@grammyjs/storage-redis";
import type { Redis } from "ioredis";
import { LruCache } from "../core/lru.js";
import { decryptSecret } from "../core/crypto.js";
import type { TelegramTransport } from "../adapters/telegram/transport.js";
import type { Logger } from "../core/logger.js";
import type { PlatformBotContext, PlatformBotSession, ResolvedBot } from "./types.js";
import { registerLeadCatchBot, startLeadCatchQuiz } from "../bots/leadcatch/index.js";
import { registerQuickBookBot } from "../bots/quickbook/index.js";
import type { PrismaClient } from "@prisma/client";
import { registerSharedBotHandlers } from "../bots/shared/handlers.js";

export interface BotPoolOptions {
  capacity: number;
  encryptionKey: string;
  transport: TelegramTransport;
  redis: Redis;
  sessionTtlSec: number;
  logger: Logger;
  prisma: PrismaClient;
}

export class BotPool {
  private readonly cache: LruCache<string, Bot<PlatformBotContext>>;
  private readonly encryptionKey: string;
  private readonly transport: TelegramTransport;
  private readonly redis: Redis;
  private readonly sessionTtlSec: number;
  private readonly logger: Logger;
  private readonly prisma: PrismaClient;

  constructor(opts: BotPoolOptions) {
    this.cache = new LruCache<string, Bot<PlatformBotContext>>(opts.capacity);
    this.encryptionKey = opts.encryptionKey;
    this.transport = opts.transport;
    this.redis = opts.redis;
    this.sessionTtlSec = opts.sessionTtlSec;
    this.logger = opts.logger;
    this.prisma = opts.prisma;
  }

  getOrCreateBot(resolved: ResolvedBot): Bot<PlatformBotContext> {
    const existing = this.cache.get(resolved.id);
    if (existing) {
      return existing;
    }

    const token = decryptSecret(resolved.botTokenEnc, this.encryptionKey);
    const botIdNum = deriveBotId(resolved.id);
    const botUsername = resolved.botUsername ?? `bot_${resolved.id.slice(0, 8)}`;
    const bot = new Bot<PlatformBotContext>(token, {
      botInfo: {
        id: botIdNum,
        is_bot: true,
        first_name: resolved.botUsername ?? "Platform Bot",
        username: botUsername,
        can_join_groups: false,
        can_read_all_group_messages: false,
        supports_inline_queries: false,
        can_connect_to_business: false,
        has_main_web_app: false,
        has_topics_enabled: false,
        allows_users_to_create_topics: false,
        can_manage_bots: false,
        supports_join_request_queries: false,
      },
    });

    // Telegram transport transformer
    const transformer = this.transport.transformerFor(resolved.id);
    if (transformer) {
      bot.api.config.use(transformer);
    }

    // Attach bot metadata to context
    bot.use((ctx, next) => {
      ctx.botMeta = resolved;
      return next();
    });

    // Session storage in Redis
    bot.use(
      session({
        initial: (): PlatformBotSession => ({}),
        storage: new RedisAdapter({
          instance: this.redis,
          ttl: this.sessionTtlSec,
        }),
        getSessionKey: (ctx) => {
          if (!ctx.from) return undefined;
          return `sess:${resolved.id}:${ctx.from.id}`;
        },
      }),
    );

    // Register shared handlers (start, admin invite code, lang, admin menu)
    registerSharedBotHandlers(bot, this.prisma, {
      onClientStart: async (ctx) => {
        if (resolved.botType === "LEADCATCH") {
          await startLeadCatchQuiz(ctx, this.prisma);
        }
      },
    });

    // Register bot-specific handlers
    if (resolved.botType === "LEADCATCH") {
      registerLeadCatchBot(bot, {
        prisma: this.prisma,
        transport: this.transport,
        logger: this.logger,
      });
    } else if (resolved.botType === "QUICKBOOK") {
      registerQuickBookBot(bot);
    }

    // Cache the bot instance
    this.cache.set(resolved.id, bot);
    this.logger.debug({ botId: resolved.id, botType: resolved.botType }, "Bot instance initialized in pool");

    return bot;
  }

  evict(botId: string): boolean {
    return this.cache.delete(botId);
  }

  get size(): number {
    return this.cache.size;
  }
}

function deriveBotId(botId: string): number {
  let h = 0;
  for (const ch of botId) h = (h * 31 + ch.charCodeAt(0)) % 2_000_000_000;
  return h + 1;
}

