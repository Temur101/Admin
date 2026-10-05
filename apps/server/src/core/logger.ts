import { pino, type Logger } from "pino";
import { env } from "./env.js";

/**
 * Single pino instance shared by Fastify and all non-HTTP modules
 * (bot pipelines, workers), so every log line has the same format.
 */
export const logger: Logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL,
  base: undefined,
  redact: {
    // Never let raw bot tokens leak into logs
    paths: ["token", "botToken", "*.token", "*.botToken", "headers.x-telegram-bot-api-secret-token"],
    censor: "[REDACTED]",
  },
});

export type { Logger };
