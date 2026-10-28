import { pino, type Logger, type LoggerOptions } from "pino";
import type { FastifyRequest } from "fastify";
import { env } from "./env.js";

const REDACT_PATHS = [
  "token",
  "botToken",
  "*.token",
  "*.botToken",
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  "headers.x-telegram-bot-api-secret-token",
];

/**
 * Masks query-string tokens (e.g. ?token=... or &token=...) in logged request URLs
 * so JWT access tokens never appear in HTTP access logs.
 */
export function sanitizeLogUrl(url: string): string {
  return url.replace(/([?&](?:access_)?token=)[^&#\s]+/gi, "$1[REDACTED]");
}

export function buildFastifyLoggerOptions(level: string = env.LOG_LEVEL): LoggerOptions {
  return {
    level,
    redact: {
      paths: REDACT_PATHS,
      censor: "[REDACTED]",
    },
    serializers: {
      req(req: FastifyRequest) {
        return {
          method: req.method,
          url: sanitizeLogUrl(req.url ?? ""),
          host: req.host,
          remoteAddress: req.ip,
          remotePort: req.socket?.remotePort,
        };
      },
    },
  };
}

/**
 * Single pino instance shared by non-HTTP modules (bot pipelines, workers).
 */
export const logger: Logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL,
  base: undefined,
  redact: {
    paths: REDACT_PATHS,
    censor: "[REDACTED]",
  },
});

export type { Logger };
