import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import type { Logger } from "../core/logger.js";
import type { BotPool } from "./bot-pool.js";
import type { UpdateDeduplicator } from "./deduplicator.js";
import type { TenantResolver } from "./tenant-resolver.js";
import type { ResolvedBot } from "./types.js";

export function extractTgUserId(update: Record<string, unknown>): number | bigint | null {
  const msg = (update.message ?? update.edited_message) as Record<string, unknown> | undefined;
  if (msg?.from && typeof (msg.from as Record<string, unknown>).id === "number") {
    return (msg.from as Record<string, unknown>).id as number;
  }
  const cb = update.callback_query as Record<string, unknown> | undefined;
  if (cb?.from && typeof (cb.from as Record<string, unknown>).id === "number") {
    return (cb.from as Record<string, unknown>).id as number;
  }
  return null;
}

export interface WebhookInboxServiceOptions {
  prisma: PrismaClient;
  redis: Redis;
  botPool: BotPool;
  tenantResolver: TenantResolver;
  deduplicator: UpdateDeduplicator;
  logger: Logger;
  leaseDurationSec?: number;
  maxAttempts?: number;
}

export interface EnqueueResult {
  status: "ENQUEUED" | "DUPLICATE" | "ALREADY_COMPLETED";
  inboxId?: string;
}

export class WebhookInboxService {
  private readonly prisma: PrismaClient;
  private readonly redis: Redis;
  private readonly botPool: BotPool;
  private readonly tenantResolver: TenantResolver;
  private readonly deduplicator: UpdateDeduplicator;
  private readonly logger: Logger;
  private readonly leaseDurationSec: number;
  private readonly maxAttempts: number;

  constructor(opts: WebhookInboxServiceOptions) {
    this.prisma = opts.prisma;
    this.redis = opts.redis;
    this.botPool = opts.botPool;
    this.tenantResolver = opts.tenantResolver;
    this.deduplicator = opts.deduplicator;
    this.logger = opts.logger;
    this.leaseDurationSec = opts.leaseDurationSec ?? 30;
    this.maxAttempts = opts.maxAttempts ?? 3;
  }

  /**
   * Persists the incoming update atomically in PostgreSQL WebhookInbox.
   * Enforces (botId, updateId) uniqueness.
   */
  async enqueue(
    botId: string,
    updateId: number,
    payload: Record<string, unknown>,
  ): Promise<EnqueueResult> {
    const bigUpdateId = BigInt(updateId);

    try {
      const created = await this.prisma.webhookInbox.create({
        data: {
          botId,
          updateId: bigUpdateId,
          payload: payload as Prisma.InputJsonValue,
          status: "RECEIVED",
          attempts: 0,
          maxAttempts: this.maxAttempts,
        },
      });

      return { status: "ENQUEUED", inboxId: created.id };
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "P2002") {
        // Unique constraint violation on (botId, updateId)
        const existing = await this.prisma.webhookInbox.findUnique({
          where: { botId_updateId: { botId, updateId: bigUpdateId } },
        });

        if (existing?.status === "COMPLETED") {
          return { status: "ALREADY_COMPLETED", inboxId: existing.id };
        }
        return { status: "DUPLICATE", inboxId: existing?.id };
      }
      throw err;
    }
  }

  /**
   * Acquires a distributed session lock in Redis to serialize concurrent
   * messages from the same Telegram user.
   */
  private async acquireSessionLock(
    botId: string,
    userId: number | bigint,
    ttlSec = 30,
    maxWaitMs = 10000,
  ): Promise<() => Promise<void>> {
    const key = `lock:session:${botId}:${userId}`;
    const token = randomUUID();
    const start = Date.now();

    while (Date.now() - start < maxWaitMs) {
      const res = await this.redis.set(key, token, "EX", ttlSec, "NX");
      if (res === "OK") {
        return async () => {
          try {
            const current = await this.redis.get(key);
            if (current === token) {
              await this.redis.del(key);
            }
          } catch {
            // Ignore lock release failures
          }
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    this.logger.warn({ botId, userId }, "Session lock acquisition timed out; proceeding without lock");
    return async () => {};
  }

  /**
   * Processes a single inbox item with lease locking, session serialization,
   * bounded retries, and atomic completion.
   */
  async processItem(
    inboxId: string,
    resolvedBot: ResolvedBot,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    payload: any,
  ): Promise<void> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + this.leaseDurationSec * 1000);

    // 1. Claim lease atomically
    const claimed = await this.prisma.webhookInbox.updateMany({
      where: {
        id: inboxId,
        OR: [
          { status: "RECEIVED" },
          { status: "PROCESSING", lockedUntil: { lt: now } },
        ],
        attempts: { lt: this.maxAttempts },
      },
      data: {
        status: "PROCESSING",
        lockedUntil: leaseUntil,
        attempts: { increment: 1 },
      },
    });

    if (claimed.count === 0) {
      return;
    }

    // 2. Serialize session if user ID is known
    const userId = extractTgUserId(payload);
    let releaseSessionLock: (() => Promise<void>) = async () => {};

    if (userId !== null) {
      releaseSessionLock = await this.acquireSessionLock(resolvedBot.id, userId);
    }

    let processingError: Error | undefined;

    try {
      // 3. Execute update through BotPool
      await this.botPool.handleUpdate(resolvedBot, payload);

      // 4. Mark COMPLETED
      try {
        await this.prisma.webhookInbox.update({
          where: { id: inboxId },
          data: {
            status: "COMPLETED",
            lockedUntil: null,
            processedAt: new Date(),
          },
        });
      } catch (updErr) {
        if ((updErr as { code?: string })?.code !== "P2025") {
          throw updErr;
        }
      }

      // 5. Mark seen in fast L1 deduplicator
      const updateId = typeof payload.update_id === "number" ? payload.update_id : Number(payload.update_id);
      if (Number.isSafeInteger(updateId)) {
        await this.deduplicator.markSeen(resolvedBot.id, updateId);
      }
    } catch (err) {
      processingError = err as Error;
      this.logger.error(
        { err: processingError.message, inboxId, botId: resolvedBot.id },
        "Error while processing webhook inbox item",
      );

      // Inspect updated attempts
      try {
        const current = await this.prisma.webhookInbox.findUnique({
          where: { id: inboxId },
        });

        if (current && current.attempts >= this.maxAttempts) {
          await this.prisma.webhookInbox.update({
            where: { id: inboxId },
            data: {
              status: "FAILED",
              lockedUntil: null,
              lastError: processingError.message,
            },
          });
        } else if (current) {
          await this.prisma.webhookInbox.update({
            where: { id: inboxId },
            data: {
              status: "RECEIVED",
              lockedUntil: null,
              lastError: processingError.message,
            },
          });
        }
      } catch {
        // Ignore update failure if record was deleted in test teardown
      }
    } finally {
      await releaseSessionLock();
    }

    if (processingError) {
      throw processingError;
    }
  }

  /**
   * Recovers uncompleted pending updates (status RECEIVED or expired PROCESSING lease)
   * e.g. after process restart or node crash.
   */
  async recoverPending(batchSize = 50): Promise<number> {
    const now = new Date();

    const pending = await this.prisma.webhookInbox.findMany({
      where: {
        OR: [
          { status: "RECEIVED" },
          { status: "PROCESSING", lockedUntil: { lt: now } },
        ],
        attempts: { lt: this.maxAttempts },
      },
      take: batchSize,
      orderBy: { createdAt: "asc" },
      include: {
        bot: {
          include: { subscription: true },
        },
      },
    });

    let recoveredCount = 0;

    for (const item of pending) {
      const resolved = await this.tenantResolver.resolveById(item.botId);
      if (!resolved) {
        continue;
      }

      try {
        await this.processItem(item.id, resolved, item.payload);
        recoveredCount++;
      } catch (err) {
        this.logger.warn(
          { err: (err as Error).message, inboxId: item.id },
          "Failed recovering pending inbox item",
        );
      }
    }

    return recoveredCount;
  }
}
