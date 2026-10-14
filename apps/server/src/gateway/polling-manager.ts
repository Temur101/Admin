import type { Bot } from "grammy";
import type { PrismaClient, Bot as BotModel, Subscription } from "@prisma/client";
import type { BotPool } from "./bot-pool.js";
import type { Logger } from "../core/logger.js";
import type { PlatformBotContext, ResolvedBot } from "./types.js";

type BotWithSubscription = BotModel & {
  subscription: Subscription | null;
};

export interface PollingManagerOptions {
  prisma: PrismaClient;
  botPool: BotPool;
  logger: Logger;
}

export class PollingManager {
  private readonly prisma: PrismaClient;
  private readonly botPool: BotPool;
  private readonly logger: Logger;
  private readonly activePollers = new Map<string, Bot<PlatformBotContext>>();

  constructor(opts: PollingManagerOptions) {
    this.prisma = opts.prisma;
    this.botPool = opts.botPool;
    this.logger = opts.logger;
  }

  isRunning(botId: string): boolean {
    return this.activePollers.has(botId);
  }

  get runningCount(): number {
    return this.activePollers.size;
  }

  async startAll(): Promise<void> {
    const activeBots = await this.prisma.bot.findMany({
      where: { isActive: true },
      include: { subscription: true },
    });

    this.logger.info(
      { count: activeBots.length },
      "Initializing long polling for active bots",
    );

    for (const botRecord of activeBots) {
      try {
        await this.startBotRecord(botRecord);
      } catch (err) {
        this.logger.error(
          { botId: botRecord.id, err: (err as Error).message },
          "Failed to start long polling for bot",
        );
      }
    }
  }

  async start(botId: string): Promise<boolean> {
    if (this.activePollers.has(botId)) {
      this.logger.debug({ botId }, "Bot polling is already running");
      return true;
    }

    const botRecord = await this.prisma.bot.findUnique({
      where: { id: botId },
      include: { subscription: true },
    });

    if (!botRecord || !botRecord.isActive) {
      this.logger.warn(
        { botId, exists: Boolean(botRecord), isActive: botRecord?.isActive },
        "Cannot start polling: bot not found or inactive",
      );
      return false;
    }

    return this.startBotRecord(botRecord);
  }

  async stop(botId: string): Promise<boolean> {
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
      this.logger.warn(
        { botId, err: (err as Error).message },
        "Error while stopping bot polling",
      );
      return false;
    }
  }

  async stopAll(): Promise<void> {
    const botIds = Array.from(this.activePollers.keys());
    this.logger.info({ count: botIds.length }, "Stopping all active bot pollers");
    await Promise.all(botIds.map((id) => this.stop(id)));
  }

  private async startBotRecord(botRecord: BotWithSubscription): Promise<boolean> {
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
      adminInviteCode: botRecord.adminInviteCode,
      settings: (botRecord.settings ?? {}) as Record<string, unknown>,
      subscriptionStatus: botRecord.subscription?.status ?? "TRIAL",
      trialEndsAt:
        botRecord.subscription?.trialEndsAt.toISOString() ?? new Date().toISOString(),
      paidUntil: botRecord.subscription?.paidUntil?.toISOString() ?? null,
    };

    const bot = this.botPool.getOrCreateBot(resolved);

    try {
      await bot.api.deleteWebhook({ drop_pending_updates: false });
    } catch (err) {
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
          this.logger.info(
            { botId: botRecord.id, username: info.username },
            "Long polling started for bot",
          );
        },
      })
      .catch((err) => {
        this.logger.error(
          { botId: botRecord.id, err: (err as Error).message },
          "Bot long polling encountered fatal error or stopped",
        );
        this.activePollers.delete(botRecord.id);
      });

    return true;
  }
}
