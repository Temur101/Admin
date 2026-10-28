import type { PrismaClient } from "@prisma/client";
import type { Logger } from "../../core/logger.js";
import { notifyPlatformOwner } from "../../core/platform-notifier.js";
import type { TelegramTransport } from "../../adapters/telegram/transport.js";

export type TelegramErrorKind =
  | "INVALID_TOKEN"
  | "BLOCKED_BY_USER"
  | "RATE_LIMITED"
  | "CHAT_NOT_FOUND"
  | "NETWORK"
  | "UNKNOWN";

export interface ClassifiedTelegramError {
  kind: TelegramErrorKind;
  retryable: boolean;
  retryAfterMs?: number;
  statusCode?: number;
  description: string;
}

export function classifyTelegramError(err: unknown): ClassifiedTelegramError {
  const rawMessage = err instanceof Error ? err.message : String(err ?? "Unknown error");
  const lower = rawMessage.toLowerCase();

  const errObj = (typeof err === "object" && err !== null ? err : {}) as {
    error_code?: number;
    statusCode?: number;
    description?: string;
    parameters?: { retry_after?: number };
    error?: unknown;
  };

  const inner =
    typeof errObj.error === "object" && errObj.error !== null
      ? (errObj.error as typeof errObj)
      : errObj;

  const code = inner.error_code ?? inner.statusCode ?? errObj.error_code ?? errObj.statusCode;
  const description = inner.description ?? rawMessage;
  const descLower = description.toLowerCase();

  if (
    code === 401 ||
    descLower.includes("401: unauthorized") ||
    descLower.includes("unauthorized") ||
    descLower.includes("invalid token")
  ) {
    return {
      kind: "INVALID_TOKEN",
      retryable: false,
      statusCode: 401,
      description,
    };
  }

  if (
    code === 403 ||
    descLower.includes("403:") ||
    descLower.includes("blocked by the user") ||
    descLower.includes("user is deactivated") ||
    descLower.includes("bot was kicked") ||
    descLower.includes("forbidden")
  ) {
    return {
      kind: "BLOCKED_BY_USER",
      retryable: false,
      statusCode: 403,
      description,
    };
  }

  if (code === 429 || descLower.includes("429") || descLower.includes("too many requests")) {
    const paramRetry = inner.parameters?.retry_after ?? errObj.parameters?.retry_after;
    const matchRetry =
      /retry after (\d+)/i.exec(description) ?? /retry after (\d+)/i.exec(rawMessage);
    const retrySec =
      typeof paramRetry === "number" && paramRetry > 0
        ? paramRetry
        : matchRetry?.[1]
          ? Number(matchRetry[1])
          : 1;
    return {
      kind: "RATE_LIMITED",
      retryable: true,
      retryAfterMs: Math.min(retrySec * 1000, 10_000),
      statusCode: 429,
      description,
    };
  }

  if (
    descLower.includes("chat not found") ||
    descLower.includes("peer_id_invalid") ||
    descLower.includes("user not found")
  ) {
    return {
      kind: "CHAT_NOT_FOUND",
      retryable: false,
      statusCode: code ?? 400,
      description,
    };
  }

  if (
    (typeof code === "number" && code >= 500) ||
    lower.includes("etimedout") ||
    lower.includes("econnreset") ||
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("eai_again") ||
    lower.includes("network") ||
    lower.includes("fetch failed") ||
    lower.includes("socket hang up") ||
    lower.includes("telegram unavailable")
  ) {
    return {
      kind: "NETWORK",
      retryable: true,
      retryAfterMs: 150,
      statusCode: code,
      description,
    };
  }

  return {
    kind: "UNKNOWN",
    retryable: false,
    statusCode: code,
    description,
  };
}

export async function handleBotTelegramError(params: {
  prisma: PrismaClient;
  botId: string;
  recipientTgId?: number | bigint | null;
  classified: ClassifiedTelegramError;
  logger?: Logger;
  transport?: TelegramTransport;
}): Promise<void> {
  const { prisma, botId, recipientTgId, classified, logger, transport } = params;
  const now = new Date();

  try {
    if (classified.kind === "INVALID_TOKEN") {
      const bot = await prisma.bot.update({
        where: { id: botId },
        data: {
          healthStatus: "NEEDS_ATTENTION",
          lastErrorCode: classified.kind,
          lastErrorMsg: classified.description.slice(0, 500),
          lastErrorAt: now,
        },
      });
      await notifyPlatformOwner(
        {
          type: "BOT_BLOCKED",
          botName: bot.botUsername ?? botId,
          reason: `INVALID_TOKEN: ${classified.description}`,
        },
        { prisma, transport, logger },
      ).catch(() => {});
      return;
    }

    if (
      (classified.kind === "BLOCKED_BY_USER" || classified.kind === "CHAT_NOT_FOUND") &&
      recipientTgId != null
    ) {
      await prisma.botUser
        .updateMany({
          where: { botId, tgId: BigInt(recipientTgId) },
          data: { unreachableAt: now },
        })
        .catch(() => {});
    }

    await prisma.bot
      .update({
        where: { id: botId },
        data: {
          lastErrorCode: classified.kind,
          lastErrorMsg: classified.description.slice(0, 500),
          lastErrorAt: now,
        },
      })
      .catch(() => {});
  } catch (err) {
    logger?.warn(
      { err: err instanceof Error ? err.message : String(err), botId },
      "Could not persist Telegram error state",
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SafeSendOptions {
  prisma?: PrismaClient;
  botId: string;
  chatId: number | bigint;
  logger?: Logger;
  transport?: TelegramTransport;
  maxRetries?: number;
  baseBackoffMs?: number;
}

export async function safeTelegramCall<T>(
  fn: () => Promise<T>,
  opts: SafeSendOptions,
): Promise<{ ok: true; result: T } | { ok: false; error: ClassifiedTelegramError }> {
  const maxRetries = opts.maxRetries ?? 2;
  const baseBackoffMs = opts.baseBackoffMs ?? 80;

  let attempt = 0;
  while (true) {
    try {
      const result = await fn();
      return { ok: true, result };
    } catch (err) {
      const classified = classifyTelegramError(err);
      attempt++;

      if (classified.retryable && attempt <= maxRetries) {
        const waitMs =
          classified.kind === "RATE_LIMITED"
            ? Math.min(classified.retryAfterMs ?? 200, 2000)
            : baseBackoffMs * 2 ** (attempt - 1);
        await sleep(waitMs);
        continue;
      }

      if (opts.prisma) {
        await handleBotTelegramError({
          prisma: opts.prisma,
          botId: opts.botId,
          recipientTgId: opts.chatId,
          classified,
          logger: opts.logger,
          transport: opts.transport,
        });
      }

      return { ok: false, error: classified };
    }
  }
}
