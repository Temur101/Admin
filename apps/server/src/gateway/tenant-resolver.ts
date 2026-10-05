import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import type { Logger } from "../core/logger.js";
import type { ResolvedBot } from "./types.js";

export interface TenantResolverOptions {
  prisma: PrismaClient;
  redis: Redis;
  cacheTtlSec: number;
  logger: Logger;
}

export class TenantResolver {
  private readonly prisma: PrismaClient;
  private readonly redis: Redis;
  private readonly cacheTtlSec: number;
  private readonly logger: Logger;

  constructor(opts: TenantResolverOptions) {
    this.prisma = opts.prisma;
    this.redis = opts.redis;
    this.cacheTtlSec = opts.cacheTtlSec;
    this.logger = opts.logger;
  }

  private cacheKey(botTokenHash: string): string {
    return `bot:hash:${botTokenHash}`;
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

    const resolved: ResolvedBot = {
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

    // 3. Write back to Redis
    try {
      await this.redis.set(key, JSON.stringify(resolved), "EX", this.cacheTtlSec);
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, botTokenHash },
        "Redis cache write failed during bot resolution",
      );
    }

    return resolved;
  }

  /**
   * Invalidate cached bot metadata when credentials or subscription change.
   */
  async invalidate(botTokenHash: string): Promise<void> {
    const key = this.cacheKey(botTokenHash);
    try {
      await this.redis.del(key);
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, botTokenHash },
        "Redis cache invalidate failed",
      );
    }
  }
}
