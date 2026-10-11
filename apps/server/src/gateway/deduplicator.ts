import type { Redis } from "ioredis";
import type { Logger } from "../core/logger.js";

export class UpdateDeduplicator {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSec: number,
    private readonly logger: Logger,
  ) {}

  private key(botId: string, updateId: number): string {
    return `upd:${botId}:${updateId}`;
  }

  /**
   * Checks whether the Telegram update has already been processed or seen.
   */
  async isDuplicate(botId: string, updateId: number): Promise<boolean> {
    const k = this.key(botId, updateId);
    try {
      const exists = await this.redis.exists(k);
      return exists === 1;
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, botId, updateId },
        "Redis deduplication check failed; failing open",
      );
      return false;
    }
  }

  /**
   * Marks update as seen/completed in Redis with TTL.
   */
  async markSeen(botId: string, updateId: number): Promise<void> {
    const k = this.key(botId, updateId);
    try {
      await this.redis.set(k, "1", "EX", this.ttlSec);
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, botId, updateId },
        "Redis deduplication markSeen failed",
      );
    }
  }

  /**
   * Atomically claims update via NX. Returns true if first time, false if duplicate.
   */
  async checkAndSet(botId: string, updateId: number): Promise<boolean> {
    const k = this.key(botId, updateId);
    try {
      const res = await this.redis.set(k, "1", "EX", this.ttlSec, "NX");
      return res === null;
    } catch {
      return false;
    }
  }

  /**
   * Clears deduplication key (e.g. for retries or tests).
   */
  async clear(botId: string, updateId: number): Promise<void> {
    try {
      await this.redis.del(this.key(botId, updateId));
    } catch {
      // Ignore clear failure
    }
  }
}

