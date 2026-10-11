import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import type { Logger } from "../core/logger.js";
import type { ResolvedBot } from "./types.js";

export interface TenantResolverOptions {
  prisma: PrismaClient;
  redis: Redis;
  cacheTtlSec: number;
  logger: Logger;
  onInvalidate?: (botTokenHash: string, botId?: string) => void;
}

export class TenantResolver {
  private readonly prisma: PrismaClient;
  private readonly redis: Redis;
  private readonly cacheTtlSec: number;
  private readonly logger: Logger;
  private onInvalidateCallback?: (botTokenHash: string, botId?: string) => void;

  constructor(opts: TenantResolverOptions) {
    this.prisma = opts.prisma;
    this.redis = opts.redis;
    this.cacheTtlSec = opts.cacheTtlSec;
    this.logger = opts.logger;
    this.onInvalidateCallback = opts.onInvalidate;
  }

  setOnInvalidate(cb: (botTokenHash: string, botId?: string) => void): void {
    this.onInvalidateCallback = cb;
  }

  private cacheKey(botTokenHash: string): string {
    return `bot:hash:${botTokenHash}`;
  }

  private idCacheKey(botId: string): string {
    return `bot:id:${botId}`;
  }

  private mapBotToResolved(bot: {
    id: string;
    tenantId: string;
    botType: ResolvedBot["botType"];
    botTokenEnc: string;
    botTokenHash: string;
    webhookSecret: string;
    botUsername: string | null;
    adminInviteCode: string;
    settings: unknown;
    subscription: {
      status: ResolvedBot["subscriptionStatus"];
      trialEndsAt: Date;
      paidUntil: Date | null;
    } | null;
  }): ResolvedBot {
    return {
      id: bot.id,
      tenantId: bot.tenantId,
      botType: bot.botType,
      botTokenEnc: bot.botTokenEnc,
      botTokenHash: bot.botTokenHash,
      webhookSecret: bot.webhookSecret,
      botUsername: bot.botUsername,
      adminInviteCode: bot.adminInviteCode,
      settings: (bot.settings ?? {}) as Record<string, unknown>,
      subscriptionStatus: bot.subscription?.status ?? "TRIAL",
      trialEndsAt: bot.subscription?.trialEndsAt.toISOString() ?? new Date().toISOString(),
      paidUntil: bot.subscription?.paidUntil?.toISOString() ?? null,
    };
  }

  /**
   * Resolves bot metadata by botTokenHash.
   * L1: Redis cache (TTL default 600s).
   * L2: PostgreSQL via Prisma.
   * Resilient: If Redis is unavailable or fails, falls back gracefully to DB.
   */
  async resolve(botTokenHash: string): Promise<ResolvedBot | null> {
    const key = this.cacheKey(botTokenHash);

    // 1. Check Redis cache
    try {
      const cached = await this.redis.get(key);
      if (cached) {
        return JSON.parse(cached) as ResolvedBot;
      }
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, botTokenHash },
        "Redis cache read failed during bot resolution; falling back to DB",
      );
    }

    // 2. Query DB
    const bot = await this.prisma.bot.findUnique({
      where: { botTokenHash },
      include: { subscription: true },
    });

    if (!bot) {
      return null;
    }

    const resolved = this.mapBotToResolved(bot);

    // 3. Write back to Redis
    try {
      await this.redis.set(key, JSON.stringify(resolved), "EX", this.cacheTtlSec);
      await this.redis.set(this.idCacheKey(bot.id), JSON.stringify(resolved), "EX", this.cacheTtlSec);
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, botTokenHash },
        "Redis cache write failed during bot resolution",
      );
    }

    return resolved;
  }

  /**
   * Resolves bot metadata by botId.
   */
  async resolveById(botId: string): Promise<ResolvedBot | null> {
    const key = this.idCacheKey(botId);

    // 1. Check Redis cache
    try {
      const cached = await this.redis.get(key);
      if (cached) {
        return JSON.parse(cached) as ResolvedBot;
      }
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, botId },
        "Redis cache read failed during bot resolution by ID; falling back to DB",
      );
    }

    // 2. Query DB
    const bot = await this.prisma.bot.findUnique({
      where: { id: botId },
      include: { subscription: true },
    });

    if (!bot) {
      return null;
    }

    const resolved = this.mapBotToResolved(bot);

    // 3. Write back to Redis
    try {
      await this.redis.set(key, JSON.stringify(resolved), "EX", this.cacheTtlSec);
      await this.redis.set(this.cacheKey(bot.botTokenHash), JSON.stringify(resolved), "EX", this.cacheTtlSec);
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, botId },
        "Redis cache write failed during bot resolution by ID",
      );
    }

    return resolved;
  }

  /**
   * Invalidate cached bot metadata across Redis keys and notify listeners.
   */
  async invalidate(botTokenHash: string, botId?: string): Promise<void> {
    const keys = [this.cacheKey(botTokenHash)];
    if (botId) {
      keys.push(this.idCacheKey(botId));
    }
    try {
      await this.redis.del(...keys);
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, botTokenHash, botId },
        "Redis cache invalidate failed",
      );
    }
    this.onInvalidateCallback?.(botTokenHash, botId);
  }

  /**
   * Invalidate cached bot metadata by botId.
   */
  async invalidateByBotId(botId: string): Promise<void> {
    try {
      const bot = await this.prisma.bot.findUnique({
        where: { id: botId },
        select: { botTokenHash: true },
      });
      const keys = [this.idCacheKey(botId)];
      if (bot) {
        keys.push(this.cacheKey(bot.botTokenHash));
      }
      await this.redis.del(...keys);
      if (bot) {
        this.onInvalidateCallback?.(bot.botTokenHash, botId);
      }
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, botId },
        "Redis cache invalidate by botId failed",
      );
    }
  }
}
