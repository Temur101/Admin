import { Redis } from "ioredis";
import type { Logger } from "./logger.js";

export type { Redis };

export interface RedisClientOptions {
  url: string;
  logger: Logger;
  /** Upper bound for reconnect backoff, ms. */
  maxReconnectDelayMs?: number;
  /** Label used in logs to tell clients apart (main / test / chaos). */
  name?: string;
}

/**
 * Creates an ioredis client tuned for a webhook gateway:
 * - never gives up reconnecting (exponential backoff capped at maxReconnectDelayMs);
 * - commands fail fast while disconnected (no offline queue) so HTTP handlers
 *   can answer 503 instead of hanging and piling up memory;
 * - connection must be established explicitly via `connectRedis()`.
 */
export function createRedisClient(opts: RedisClientOptions): Redis {
  if (process.env.NODE_ENV === "test") {
    const devRedis = process.env.REDIS_URL;
    if (devRedis && opts.url === devRedis) {
      throw new Error("Safety check failed: Redis client cannot use dev/prod REDIS_URL in test environment.");
    }
  }

  const maxDelay = opts.maxReconnectDelayMs ?? 5000;
  const name = opts.name ?? "main";

  const client = new Redis(opts.url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
    retryStrategy: (times: number) => Math.min(times * 200, maxDelay),
  });

  let wasReady = false;
  client.on("ready", () => {
    if (wasReady) opts.logger.info({ redis: name }, "Redis connection restored");
    wasReady = true;
  });
  client.on("error", (err: Error) => {
    opts.logger.warn({ redis: name, err: err.message }, "Redis error");
  });
  client.on("end", () => {
    opts.logger.warn({ redis: name }, "Redis connection closed");
  });

  return client;
}

/** Opens the connection and waits until the client is ready. */
export async function connectRedis(client: Redis): Promise<void> {
  if (client.status === "ready") return;
  if (client.status === "wait" || client.status === "end") {
    await client.connect();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onReady = (): void => {
      client.off("error", onError);
      resolve();
    };
    const onError = (err: Error): void => {
      client.off("ready", onReady);
      reject(err);
    };
    client.once("ready", onReady);
    client.once("error", onError);
  });
}
