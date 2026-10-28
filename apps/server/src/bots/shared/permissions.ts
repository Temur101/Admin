import { randomBytes } from "node:crypto";
import type { AdminInvite, BotAdminRole, PrismaClient } from "@prisma/client";
import type { Redis } from "ioredis";
import { sha256Hex } from "../../core/crypto.js";

export type BotAdminAction =
  | "VIEW_LEADS"
  | "TAKE_LEAD"
  | "VIEW_BOOKINGS"
  | "CREATE_MANUAL_BOOKING"
  | "CANCEL_BOOKING"
  | "MANAGE_SUBSCRIPTION"
  | "PAY_SUBSCRIPTION"
  | "MANAGE_SETTINGS"
  | "MANAGE_INVITES"
  | "MANAGE_STAFF"
  | "MANAGE_TIME_BLOCKS"
  | "TOGGLE_RECEIVES_LEADS";

export interface PermissionSubject {
  isAdmin?: boolean;
  role?: BotAdminRole | null;
}

const STAFF_ACTIONS: ReadonlySet<BotAdminAction> = new Set([
  "VIEW_LEADS",
  "TAKE_LEAD",
  "VIEW_BOOKINGS",
  "CREATE_MANUAL_BOOKING",
  "CANCEL_BOOKING",
]);

export function resolveEffectiveRole(
  user: PermissionSubject | null | undefined,
): BotAdminRole | null {
  if (!user || !user.isAdmin) return null;
  return user.role ?? "OWNER";
}

export function can(
  user: PermissionSubject | null | undefined,
  action: BotAdminAction,
): boolean {
  const role = resolveEffectiveRole(user);
  if (!role) return false;
  if (role === "OWNER") return true;
  return STAFF_ACTIONS.has(action);
}

export const ADMIN_INVITE_TTL_MS = 24 * 60 * 60 * 1000;

export interface CreateInviteResult {
  invite: AdminInvite;
  rawCode: string;
}

export async function createBotAdminInvite(
  prisma: PrismaClient,
  params: {
    botId: string;
    role?: BotAdminRole;
    ttlMs?: number;
    revokeExistingUnused?: boolean;
  },
): Promise<CreateInviteResult> {
  const role: BotAdminRole = params.role ?? "OWNER";
  const rawCode = randomBytes(16).toString("hex");
  const codeHash = sha256Hex(rawCode);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (params.ttlMs ?? ADMIN_INVITE_TTL_MS));

  const invite = await prisma.$transaction(async (tx) => {
    if (params.revokeExistingUnused !== false) {
      await tx.adminInvite.updateMany({
        where: {
          botId: params.botId,
          role,
          usedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: now },
      });
    }

    return tx.adminInvite.create({
      data: {
        botId: params.botId,
        role,
        codeHash,
        expiresAt,
      },
    });
  });

  return { invite, rawCode };
}

export async function revokeBotAdminRights(
  prisma: PrismaClient,
  params: {
    botId: string;
    tgId: number | bigint;
    redis?: Redis;
  },
): Promise<void> {
  const tgIdBig = BigInt(params.tgId);
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.botUser.update({
      where: {
        botId_tgId: {
          botId: params.botId,
          tgId: tgIdBig,
        },
      },
      data: {
        isAdmin: false,
        role: null,
      },
    });

    await tx.adminInvite.updateMany({
      where: {
        botId: params.botId,
        revokedAt: null,
        OR: [{ usedAt: null }, { usedByTgId: tgIdBig }],
      },
      data: {
        revokedAt: now,
      },
    });
  });

  if (params.redis) {
    await params.redis.del(`sess:${params.botId}:${tgIdBig.toString()}`).catch(() => {});
  }
}
