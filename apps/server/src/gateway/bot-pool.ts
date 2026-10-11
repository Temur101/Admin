import { AsyncLocalStorage } from "node:async_hooks";
import { Bot, session } from "grammy";
import { RedisAdapter } from "@grammyjs/storage-redis";
import type { Redis } from "ioredis";
import { LruCache } from "../core/lru.js";
import { decryptSecret } from "../core/crypto.js";
import type { TelegramTransport } from "../adapters/telegram/transport.js";
import type { Logger } from "../core/logger.js";
import type { PlatformBotContext, PlatformBotSession, ResolvedBot } from "./types.js";
import { registerLeadCatchBot, startLeadCatchQuiz } from "../bots/leadcatch/index.js";
import { registerQuickBookBot, startQuickBookFlow } from "../bots/quickbook/index.js";
import type { PrismaClient } from "@prisma/client";
import { registerSharedBotHandlers } from "../bots/shared/handlers.js";
import { env } from "../core/env.js";
import type { TenantResolver } from "./tenant-resolver.js";

export function extractTelegramBotId(token: string): number | null {
  const parts = token.split(":");
  if (parts.length >= 2) {
    const id = parseInt(parts[0], 10);
    if (Number.isSafeInteger(id) && id > 0) {
      return id;
    }
  }
  return null;
}

export function normalizeBotUsername(username: string | null | undefined, fallback: string): string {
  if (!username) return fallback.replace(/^@/, "");
  return username.trim().replace(/^@/, "");
}

export interface BotPoolOptions {
  capacity: number;
  encryptionKey: string;
  transport: TelegramTransport;
  redis: Redis;
  sessionTtlSec: number;
  logger: Logger;
  prisma: PrismaClient;
  tenantResolver?: TenantResolver;
}

export class BotPool {
  private readonly cache: LruCache<string, Bot<PlatformBotContext>>;
  private readonly cachedTokens = new Map<string, string>();
  private readonly latestMeta = new Map<string, ResolvedBot>();
  private readonly metaStorage = new AsyncLocalStorage<ResolvedBot>();
  private readonly encryptionKey: string;
  private readonly transport: TelegramTransport;
  private readonly redis: Redis;
  private readonly sessionTtlSec: number;
  private readonly logger: Logger;
  private readonly prisma: PrismaClient;
  private readonly tenantResolver?: TenantResolver;

  constructor(opts: BotPoolOptions) {
    this.cache = new LruCache<string, Bot<PlatformBotContext>>(opts.capacity);
    this.encryptionKey = opts.encryptionKey;
    this.transport = opts.transport;
    this.redis = opts.redis;
    this.sessionTtlSec = opts.sessionTtlSec;
    this.logger = opts.logger;
    this.prisma = opts.prisma;
    this.tenantResolver = opts.tenantResolver;
  }

  getOrCreateBot(resolved: ResolvedBot): Bot<PlatformBotContext> {
    const cleanUsername = normalizeBotUsername(resolved.botUsername, `bot_${resolved.id.slice(0, 8)}`);
    const existing = this.cache.get(resolved.id);
    if (existing) {
      if (this.cachedTokens.get(resolved.id) !== resolved.botTokenEnc) {
        this.cache.delete(resolved.id);
        this.cachedTokens.delete(resolved.id);
        this.latestMeta.delete(resolved.id);
      } else {
        this.latestMeta.set(resolved.id, resolved);
        existing.botInfo.username = cleanUsername;
        existing.botInfo.first_name = cleanUsername;
        return existing;
      }
    }

    const token = decryptSecret(resolved.botTokenEnc, this.encryptionKey);
    const realBotId = extractTelegramBotId(token);
    const botIdNum = realBotId ?? deriveBotId(resolved.id);

    const bot = new Bot<PlatformBotContext>(token, {
      botInfo: {
        id: botIdNum,
        is_bot: true,
        first_name: cleanUsername,
        username: cleanUsername,
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

    // Wrap handleUpdate to always scope execution within AsyncLocalStorage
    const originalHandleUpdate = bot.handleUpdate.bind(bot);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    bot.handleUpdate = async (update: any, webhookReplyEnvelope?: any) => {
      const activeMeta = this.metaStorage.getStore();
      if (activeMeta) {
        return originalHandleUpdate(update, webhookReplyEnvelope);
      }
      let meta = this.latestMeta.get(resolved.id);
      if (this.tenantResolver) {
        const fresh = await this.tenantResolver.resolveById(resolved.id);
        if (fresh) {
          meta = fresh;
          this.latestMeta.set(resolved.id, fresh);
        }
      }
      const effectiveMeta = meta ?? resolved;
      return this.metaStorage.run(effectiveMeta, () => originalHandleUpdate(update, webhookReplyEnvelope));
    };

    // Telegram transport transformer
    const transformer = this.transport.transformerFor(resolved.id);
    if (transformer) {
      bot.api.config.use(transformer);
    }

    // Dynamic per-update metadata resolution
    bot.use((ctx, next) => {
      ctx.botMeta = this.metaStorage.getStore() ?? this.latestMeta.get(resolved.id) ?? resolved;
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

    // Register shared handlers (start, admin invite code, lang, admin menu, receipts)
    registerSharedBotHandlers(bot, this.prisma, {
      redis: this.redis,
      transport: this.transport,
      uploadDir: env.UPLOAD_DIR,
      onClientStart: async (ctx) => {
        if (ctx.botMeta.botType === "LEADCATCH") {
          await startLeadCatchQuiz(ctx, this.prisma);
        } else if (ctx.botMeta.botType === "QUICKBOOK") {
          await startQuickBookFlow(ctx, this.prisma);
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
      registerQuickBookBot(bot, {
        prisma: this.prisma,
        redis: this.redis,
        transport: this.transport,
        logger: this.logger,
      });
    }

    // Cache the bot instance
    this.cache.set(resolved.id, bot);
    this.cachedTokens.set(resolved.id, resolved.botTokenEnc);
    this.latestMeta.set(resolved.id, resolved);
    this.logger.debug({ botId: resolved.id, botType: resolved.botType }, "Bot instance initialized in pool");

    return bot;
  }

  async handleUpdate(
    resolved: ResolvedBot,
    update: Parameters<Bot<PlatformBotContext>["handleUpdate"]>[0],
  ): Promise<void> {
    this.latestMeta.set(resolved.id, resolved);
    const bot = this.getOrCreateBot(resolved);
    return this.metaStorage.run(resolved, () => bot.handleUpdate(update));
  }

  invalidateMeta(botTokenHash?: string, botId?: string): void {
    if (botId) {
      this.latestMeta.delete(botId);
    }
    if (botTokenHash) {
      for (const [id, meta] of this.latestMeta.entries()) {
        if (meta.botTokenHash === botTokenHash) {
          this.latestMeta.delete(id);
        }
      }
    }
  }

  getLatestMeta(botId: string): ResolvedBot | undefined {
    return this.latestMeta.get(botId);
  }

  evict(botId: string): boolean {
    this.cachedTokens.delete(botId);
    this.latestMeta.delete(botId);
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

