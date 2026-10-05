import type { Redis } from "ioredis";
import type { Logger } from "../core/logger.js";

export class UpdateDeduplicator {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSec: number,
    private readonly logger: Logger,
  ) {}

  /**
   * Checks whether the Telegram update has already been seen for this bot.
   * Atomically sets the key with NX (only if Not eXists) and an expiration.
   *
   * @returns `true` if this update is a duplicate, `false` if it is new.
   */
  async isDuplicate(botId: string, updateId: number): Promise<boolean> {
    const key = `upd:${botId}:${updateId}`;
    try {
      const res = await this.redis.set(key, "1", "EX", this.ttlSec, "NX");
      // res is "OK" if key was set (first time seen), null if key already existed
      return res === null;
    } catch (err) {
      this.logger.warn(
        { err: (err as Error).message, botId, updateId },
        "Redis deduplication check failed; failing open to process update",
      );
      return false;
    }
  }
}
