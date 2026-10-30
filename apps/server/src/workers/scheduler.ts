import { flushNotificationOutbox } from "../bots/shared/notification-outbox.js";
import type { PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import type { TelegramTransport } from "../adapters/telegram/transport.js";
import type { Logger } from "../core/logger.js";
import type { WebhookInboxService } from "../gateway/inbox-service.js";
import { runSubscriptionWorker } from "./subscription-worker.js";
import { runBookingReminderWorker } from "./booking-reminder-worker.js";

export interface SchedulerOptions {
  prisma: PrismaClient;
  redis: Redis;
  transport: TelegramTransport;
  logger: Logger;
  inboxService?: WebhookInboxService;
  recoveryIntervalMs?: number;
  subscriptionIntervalMs?: number;
  reminderIntervalMs?: number;
  runImmediately?: boolean;
}

export class BackgroundWorkerScheduler {
  private subscriptionTimer: NodeJS.Timeout | null = null;
  private reminderTimer: NodeJS.Timeout | null = null;
  private recoveryTimer: NodeJS.Timeout | null = null;
  private activeSubscriptionTask: Promise<unknown> | null = null;
  private activeReminderTask: Promise<unknown> | null = null;
  private activeRecoveryTask: Promise<unknown> | null = null;
  private isRunning = false;
  private readonly inFlightTasks = new Set<Promise<unknown>>();
  private readonly opts: SchedulerOptions;

  constructor(opts: SchedulerOptions) {
    this.opts = opts;
  }

  public get running(): boolean {
    return this.isRunning;
  }

  public get activeTaskCount(): number {
    return this.inFlightTasks.size;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const subInterval = this.opts.subscriptionIntervalMs ?? 60_000;
    const remInterval = this.opts.reminderIntervalMs ?? 60_000;
    const recInterval = this.opts.recoveryIntervalMs ?? 60_000;

    if (this.opts.runImmediately !== false) {
      this.triggerSubscriptionTick();
      this.triggerReminderTick();
      this.triggerRecoveryTick();
    }

    this.subscriptionTimer = setInterval(() => {
      this.triggerSubscriptionTick();
    }, subInterval);

    this.reminderTimer = setInterval(() => {
      this.triggerReminderTick();
    }, remInterval);

    this.recoveryTimer = setInterval(() => { this.triggerRecoveryTick(); }, recInterval);

    this.opts.logger.info(
      { subInterval, remInterval, recInterval },
      "Background worker scheduler started",
    );
  }

  public triggerSubscriptionTick(): Promise<unknown> {
    if (!this.isRunning) return Promise.resolve();
    if (this.activeSubscriptionTask) return this.activeSubscriptionTask;

    const task = runSubscriptionWorker({
      prisma: this.opts.prisma,
      redis: this.opts.redis,
      transport: this.opts.transport,
      logger: this.opts.logger,
    })
      .catch((err) => {
        this.opts.logger.error(
          { err: (err as Error).message },
          "Unhandled error in subscription worker tick",
        );
      })
      .finally(() => {
        this.activeSubscriptionTask = null;
        this.inFlightTasks.delete(task);
      });

    this.activeSubscriptionTask = task;
    this.inFlightTasks.add(task);
    return task;
  }

  public triggerReminderTick(): Promise<unknown> {
    if (!this.isRunning) return Promise.resolve();
    if (this.activeReminderTask) return this.activeReminderTask;

    const task = runBookingReminderWorker({
      prisma: this.opts.prisma,
      redis: this.opts.redis,
      transport: this.opts.transport,
      logger: this.opts.logger,
    })
      .catch((err) => {
        this.opts.logger.error(
          { err: (err as Error).message },
          "Unhandled error in reminder worker tick",
        );
      })
      .finally(() => {
        this.activeReminderTask = null;
        this.inFlightTasks.delete(task);
      });

    this.activeReminderTask = task;
    this.inFlightTasks.add(task);
    return task;
  }

  public triggerRecoveryTick(): Promise<unknown> {
    if (!this.isRunning) return Promise.resolve();
    if (this.activeRecoveryTask) return this.activeRecoveryTask;

    const task = flushNotificationOutbox(this.opts)
      .then(() => this.opts.inboxService?.recoverPending(50) ?? 0)
      .then((count) => {
        if (count > 0) {
          this.opts.logger.info({ count }, "Periodic webhook recovery processed items");
        }
      })
      .catch((err) => {
        this.opts.logger.error(
          { err: (err as Error).message },
          "Unhandled error in inbox recovery tick",
        );
      })
      .finally(() => {
        this.activeRecoveryTask = null;
        this.inFlightTasks.delete(task);
      });

    this.activeRecoveryTask = task;
    this.inFlightTasks.add(task);
    return task;
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.subscriptionTimer) {
      clearInterval(this.subscriptionTimer);
      this.subscriptionTimer = null;
    }
    if (this.reminderTimer) {
      clearInterval(this.reminderTimer);
      this.reminderTimer = null;
    }
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }

    if (this.inFlightTasks.size > 0) {
      this.opts.logger.info(
        { count: this.inFlightTasks.size },
        "Waiting for in-flight worker tasks to finish...",
      );
      await Promise.all(Array.from(this.inFlightTasks));
      this.inFlightTasks.clear();
    }

    this.opts.logger.info("Background worker scheduler stopped cleanly");
  }
}
