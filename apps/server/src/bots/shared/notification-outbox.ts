import { randomUUID } from "node:crypto";
import type { Prisma, Booking } from "@prisma/client";
import { notifyAdmins, type AdminNotifyPayload, type NotifyAdminsOptions } from "./notification.js";
import { notifyPlatformOwner } from "../../core/platform-notifier.js";
import { formatTashkentDateTime } from "./payment-notifications.js";

export function bookingNotification(booking: Booking, kind: Exclude<AdminNotifyPayload["kind"], "LEAD">): AdminNotifyPayload {
  return { kind, name: booking.customerName, phone: booking.customerPhone, phoneVerified: booking.phoneVerified,
    service: booking.serviceName, staff: booking.staffId, time: formatTashkentDateTime(booking.slotTime), serviceId: booking.serviceId, staffId: booking.staffId };
}

/** Enqueue in the SAME transaction as the business write. One durable row per recipient. */
export async function enqueueAdminNotifications(tx: Prisma.TransactionClient, botId: string, eventKey: string, payload: AdminNotifyPayload): Promise<void> {
  const recipients = await tx.botUser.findMany({ where: { botId, isAdmin: true, ...(payload.kind === "LEAD" ? { receivesLeads: true } : {}) } });
  if (!recipients.length) return;
  await tx.notificationDelivery.createMany({ data: recipients.map(user => ({ botId, eventKey, recipientTgId: user.tgId, payload: payload as unknown as Prisma.InputJsonValue })), skipDuplicates: true });
}

export interface OutboxOptions extends NotifyAdminsOptions {
  eventKey?: string;
  now?: Date;
  batchSize?: number;
  maxAttempts?: number;
}

/** DB leases and recipient-level progress survive Redis loss and process restarts. */
export async function flushNotificationOutbox(opts: OutboxOptions): Promise<number> {
  const { prisma, transport, logger } = opts;
  const now = opts.now ?? new Date();
  const maxAttempts = opts.maxAttempts ?? 5;
  const exhausted = await prisma.notificationDelivery.findMany({ where: { attempts: { gte: maxAttempts }, OR: [{ status: "PENDING" }, { status: "SENDING", lockedUntil: { lt: now } }] }, take: opts.batchSize ?? 50 });
  for (const row of exhausted) {
    const marked = await prisma.notificationDelivery.updateMany({ where: { id: row.id, status: row.status, leaseToken: row.leaseToken, lockedUntil: row.lockedUntil }, data: { status: "FAILED", lockedUntil: null, leaseToken: null, lastError: "Final delivery attempt lease expired" } });
    if (marked.count) await notifyPlatformOwner({ type: "DELIVERY_FAILED", botName: row.botId, reason: "Не доставлено уведомление: исчерпаны попытки. Проверьте диагностику бота." }, { prisma, transport, logger });
  }
  const eligible = { attempts: { lt: maxAttempts }, availableAt: { lte: now }, OR: [{ status: "PENDING" }, { status: "SENDING", lockedUntil: { lt: now } }] };
  const rows = await prisma.notificationDelivery.findMany({ where: { ...eligible, ...(opts.eventKey ? { eventKey: opts.eventKey } : {}) }, orderBy: { createdAt: "asc" }, take: opts.batchSize ?? 50 });
  let delivered = 0;
  for (const row of rows) {
    const leaseToken = randomUUID();
    const claim = await prisma.notificationDelivery.updateMany({ where: { id: row.id, ...eligible }, data: { status: "SENDING", attempts: { increment: 1 }, leaseToken, lockedUntil: new Date(now.getTime() + 300000) } });
    if (!claim.count) continue;
    const owned = { id: row.id, leaseToken, status: "SENDING" };
    try {
      const user = await prisma.botUser.findUnique({ where: { botId_tgId: { botId: row.botId, tgId: row.recipientTgId } } });
      const payload = row.payload as unknown as AdminNotifyPayload;
      if (!user?.isAdmin || (payload.kind === "LEAD" && !user.receivesLeads)) {
        await prisma.notificationDelivery.updateMany({ where: owned, data: { status: "SKIPPED", lockedUntil: null, leaseToken: null } });
        continue;
      }
      const count = await notifyAdmins(row.botId, payload, { prisma, transport, logger, recipientTgId: row.recipientTgId });
      if (!count) throw new Error("Telegram notification was not delivered");
      await prisma.notificationDelivery.updateMany({ where: owned, data: { status: "SENT", deliveredAt: new Date(), lockedUntil: null, leaseToken: null, lastError: null } });
      delivered++;
    } catch (error) {
      const failed = row.attempts + 1 >= maxAttempts;
      await prisma.notificationDelivery.updateMany({ where: owned, data: { status: failed ? "FAILED" : "PENDING", lockedUntil: null, leaseToken: null, availableAt: new Date(now.getTime() + Math.min(60000 * 2 ** row.attempts, 3600000)), lastError: (error as Error).message.slice(0, 500) } });
      logger.error({ deliveryId: row.id, botId: row.botId, failed }, "Admin notification delivery failed");
      if (failed) await notifyPlatformOwner({ type: "DELIVERY_FAILED", botName: row.botId, reason: "Не доставлено уведомление. Проверьте очередь ошибок доставки в админке." }, { prisma, transport, logger });
    }
  }
  return delivered;
}

/** An immediate send is best effort: the transaction has already persisted the retry job. */
export async function dispatchQueuedNotifications(opts: OutboxOptions): Promise<number> {
  try { return await flushNotificationOutbox(opts); }
  catch (error) { opts.logger.error({ err: (error as Error).message }, "Notification outbox remains queued for recovery"); return 0; }
}

