import type { Bot } from "grammy";
import type { PrismaClient, Bot as BotModel, Subscription } from "@prisma/client";
import type { BotPool } from "./bot-pool.js";
import type { Logger } from "../core/logger.js";
import type { PlatformBotContext, ResolvedBot } from "./types.js";
import {
  classifyTelegramError,
  handleBotTelegramError,
  type TelegramErrorKind,
} from "../bots/shared/telegram-errors.js";

type BotWithSubscription = BotModel & {
  subscription: Subscription | null;
};

export interface PollingManagerOptions {
  prisma: PrismaClient;
  botPool: BotPool;
  logger: Logger;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}

export class PollingManager {
  private readonly prisma: PrismaClient;
  private readonly botPool: BotPool;
  private readonly logger: Logger;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly activePollers = new Map<string, Bot<PlatformBotContext>>();
  private readonly desiredBots = new Set<string>();
  private readonly failedBots = new Set<string>();
  private readonly lastErrors = new Map<string, { kind: TelegramErrorKind; message: string }>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: PollingManagerOptions) {
    this.prisma = opts.prisma;
    this.botPool = opts.botPool;
    this.logger = opts.logger;
    this.retryBaseDelayMs = opts.retryBaseDelayMs ?? 1000;
    this.retryMaxDelayMs = opts.retryMaxDelayMs ?? 30_000;
  }

  isRunning(botId: string): boolean {
    return this.activePollers.has(botId) && !this.failedBots.has(botId);
  }

  isConnected(botId: string): boolean {
    return this.activePollers.get(botId)?.isRunning() ?? false;
  }

  getLastError(botId: string): { kind: TelegramErrorKind; message: string } | undefined {
    return this.lastErrors.get(botId);
  }

  get runningCount(): number {
    return this.activePollers.size;
  }

  getUnhealthyBotIds(): string[] {
    const unhealthy: string[] = [];
    for (const botId of this.desiredBots) {
      if (!this.activePollers.has(botId) || this.failedBots.has(botId)) {
        unhealthy.push(botId);
      }
    }
    return unhealthy;
  }

  isHealthy(): boolean {
    return this.getUnhealthyBotIds().length === 0;
  }

  private clearRetryTimer(botId: string): void {
    const timer = this.retryTimers.get(botId);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(botId);
    }
  }

  private scheduleRestart(botId: string, err: unknown): void {
    if (!this.desiredBots.has(botId)) return;
    this.failedBots.add(botId);
    this.botPool.evict(botId);
    this.clearRetryTimer(botId);

    const classified = classifyTelegramError(err);
    this.lastErrors.set(botId, { kind: classified.kind, message: classified.description });
    void handleBotTelegramError({
      prisma: this.prisma,
      botId,
      classified,
      logger: this.logger,
    });

    if (classified.kind === "INVALID_TOKEN") {
      this.logger.error(
        { botId, err: classified.description },
        "Bot polling stopped permanently due to INVALID_TOKEN (401)",
      );
      return;
    }

    const attempt = (this.retryAttempts.get(botId) ?? 0) + 1;
    this.retryAttempts.set(botId, attempt);
    const computedDelay =
      classified.kind === "RATE_LIMITED" && classified.retryAfterMs
        ? classified.retryAfterMs
        : Math.min(this.retryBaseDelayMs * 2 ** (attempt - 1), this.retryMaxDelayMs);

    this.logger.error(
      {
        botId,
        attempt,
        errorKind: classified.kind,
        retryInMs: computedDelay,
        err: classified.description,
      },
      "Bot long polling encountered fatal error or stopped; scheduling restart",
    );

    const timer = setTimeout(() => {
      this.retryTimers.delete(botId);
      if (!this.desiredBots.has(botId)) return;
      void this.start(botId).catch((restartErr: unknown) => {
        this.scheduleRestart(botId, restartErr);
      });
    }, computedDelay);
    timer.unref?.();
    this.retryTimers.set(botId, timer);
  }

  async startAll(): Promise<void> {
    const activeBots = await this.prisma.bot.findMany({
      where: { isActive: true },
      include: { subscription: true },
    });

    this.logger.info({ count: activeBots.length }, "Initializing long polling for active bots");

    for (const botRecord of activeBots) {
      try {
        await this.startBotRecord(botRecord);
      } catch (err) {
        this.scheduleRestart(botRecord.id, err);
      }
    }
  }

  async start(botId: string): Promise<boolean> {
    if (this.activePollers.has(botId)) {
      this.desiredBots.add(botId);
      this.logger.debug({ botId }, "Bot polling is already running");
      return true;
    }

    const botRecord = await this.prisma.bot.findUnique({
      where: { id: botId },
      include: { subscription: true },
    });

    if (!botRecord || !botRecord.isActive) {
      this.desiredBots.delete(botId);
      this.failedBots.delete(botId);
      this.lastErrors.delete(botId);
      this.retryAttempts.delete(botId);
      this.clearRetryTimer(botId);
      this.logger.warn(
        { botId, exists: Boolean(botRecord), isActive: botRecord?.isActive },
        "Cannot start polling: bot not found or inactive",
      );
      return false;
    }

    return this.startBotRecord(botRecord);
  }

  async stop(botId: string): Promise<boolean> {
    this.desiredBots.delete(botId);
    this.failedBots.delete(botId);
    this.lastErrors.delete(botId);
    this.retryAttempts.delete(botId);
    this.clearRetryTimer(botId);

    const bot = this.activePollers.get(botId);
    if (!bot) {
      return false;
    }

    this.activePollers.delete(botId);
    try {
      await bot.stop();
      this.logger.info({ botId }, "Stopped long polling for bot");
      return true;
    } catch (err) {
      this.logger.warn({ botId, err: (err as Error).message }, "Error while stopping bot polling");
      return false;
    }
  }

  async stopAll(): Promise<void> {
    for (const botId of this.retryTimers.keys()) {
      this.clearRetryTimer(botId);
    }
    this.desiredBots.clear();
    this.failedBots.clear();
    this.lastErrors.clear();
    this.retryAttempts.clear();

    const botIds = Array.from(this.activePollers.keys());
    this.logger.info({ count: botIds.length }, "Stopping all active bot pollers");
    await Promise.all(botIds.map((id) => this.stop(id)));
  }

  private async startBotRecord(botRecord: BotWithSubscription): Promise<boolean> {
    this.desiredBots.add(botRecord.id);
    this.clearRetryTimer(botRecord.id);

    if (this.activePollers.has(botRecord.id)) {
      return true;
    }

    const resolved: ResolvedBot = {
      id: botRecord.id,
      tenantId: botRecord.tenantId,
      botType: botRecord.botType,
      botTokenEnc: botRecord.botTokenEnc,
      botTokenHash: botRecord.botTokenHash,
      webhookSecret: botRecord.webhookSecret,
      botUsername: botRecord.botUsername,
      settings: (botRecord.settings ?? {}) as Record<string, unknown>,
      subscriptionStatus: botRecord.subscription?.status ?? "TRIAL",
      trialEndsAt: botRecord.subscription?.trialEndsAt.toISOString() ?? new Date().toISOString(),
      paidUntil: botRecord.subscription?.paidUntil?.toISOString() ?? null,
    };

    const bot = this.botPool.getOrCreateBot(resolved);

    try {
      await bot.api.deleteWebhook({ drop_pending_updates: false });
    } catch (err) {
      const classified = classifyTelegramError(err);
      if (classified.kind === "INVALID_TOKEN") {
        this.scheduleRestart(botRecord.id, err);
        return false;
      }
      this.logger.warn(
        { botId: botRecord.id, err: (err as Error).message },
        "deleteWebhook failed or skipped before starting polling",
      );
    }

    this.activePollers.set(botRecord.id, bot);

    void bot
      .start({
        drop_pending_updates: false,
        onStart: (info) => {
          this.failedBots.delete(botRecord.id);
          this.lastErrors.delete(botRecord.id);
          this.retryAttempts.delete(botRecord.id);
          void this.prisma.bot
            .update({
              where: { id: botRecord.id },
              data: { healthStatus: "OK" },
            })
            .catch(() => {});
          this.logger.info(
            { botId: botRecord.id, username: info.username },
            "Long polling started for bot",
          );
        },
      })
      .then(() => {
        this.activePollers.delete(botRecord.id);
        if (this.desiredBots.has(botRecord.id)) {
          this.scheduleRestart(botRecord.id, new Error("Polling loop exited unexpectedly"));
        }
      })
      .catch((err) => {
        this.activePollers.delete(botRecord.id);
        if (this.desiredBots.has(botRecord.id)) {
          this.scheduleRestart(botRecord.id, err);
        }
      });

    return true;
  }
}
