import type { BotAdminRole, BotUser, Lang, PrismaClient } from "@prisma/client";
import { sha256Hex } from "../../core/crypto.js";
import { can, type BotAdminAction } from "./permissions.js";

export interface UpsertBotUserParams {
  botId: string;
  tgId: number | bigint;
  firstName?: string | null;
  username?: string | null;
  inviteCode?: string | null;
}

export interface UpsertBotUserResult {
  user: BotUser;
  newlyBecameAdmin: boolean;
  grantedRole: BotAdminRole | null;
  inviteRejected: boolean;
}

export async function upsertBotUser(
  prisma: PrismaClient,
  params: UpsertBotUserParams,
): Promise<UpsertBotUserResult> {
  const tgIdBig = BigInt(params.tgId);
  const rawInvite = params.inviteCode?.trim() || null;

  const execute = async (tx: PrismaClient): Promise<UpsertBotUserResult> => {
    let grantedRole: BotAdminRole | null = null;
    let inviteRejected = false;

    if (rawInvite) {
      const now = new Date();
      const codeHash = sha256Hex(rawInvite);
      const invite = await tx.adminInvite?.findUnique({
        where: { codeHash },
      });

      if (
        invite &&
        invite.botId === params.botId &&
        !invite.revokedAt &&
        !invite.usedAt &&
        invite.expiresAt.getTime() > now.getTime()
      ) {
        const claimed = await tx.adminInvite.updateMany({
          where: {
            id: invite.id,
            botId: params.botId,
            revokedAt: null,
            usedAt: null,
            expiresAt: { gt: now },
          },
          data: {
            usedAt: now,
            usedByTgId: tgIdBig,
          },
        });
        if (claimed.count === 1) {
          grantedRole = invite.role;
        } else {
          inviteRejected = true;
        }
      } else {
        inviteRejected = true;
      }
    }

    const existing = await tx.botUser.findUnique({
      where: {
        botId_tgId: {
          botId: params.botId,
          tgId: tgIdBig,
        },
      },
    });

    if (!existing) {
      const isAdmin = Boolean(grantedRole);
      const user = await tx.botUser.create({
        data: {
          botId: params.botId,
          tgId: tgIdBig,
          firstName: params.firstName ?? null,
          username: params.username ?? null,
          isAdmin,
          role: grantedRole,
          receivesLeads: true,
          unreachableAt: null,
        },
      });
      return {
        user,
        newlyBecameAdmin: isAdmin,
        grantedRole,
        inviteRejected,
      };
    }

    const shouldPromote = Boolean(grantedRole);
    const nextIsAdmin = shouldPromote ? true : existing.isAdmin;
    const nextRole = grantedRole ?? (existing.isAdmin ? (existing.role ?? "OWNER") : null);

    const user = await tx.botUser.update({
      where: {
        botId_tgId: {
          botId: params.botId,
          tgId: tgIdBig,
        },
      },
      data: {
        firstName: params.firstName ?? existing.firstName,
        username: params.username ?? existing.username,
        isAdmin: nextIsAdmin,
        role: nextRole,
        unreachableAt: null,
      },
    });

    return {
      user,
      newlyBecameAdmin: shouldPromote && (!existing.isAdmin || existing.role !== grantedRole),
      grantedRole,
      inviteRejected,
    };
  };

  try {
    if (typeof prisma.$transaction === "function") {
      return await prisma.$transaction(async (tx) => execute(tx as unknown as PrismaClient));
    }
    return await execute(prisma);
  } catch {
    return {
      user: {
        id: "00000000-0000-0000-0000-000000000000",
        botId: params.botId,
        tgId: tgIdBig,
        firstName: params.firstName ?? null,
        username: params.username ?? null,
        lang: null,
        isAdmin: false,
        role: null,
        receivesLeads: true,
        unreachableAt: null,
        createdAt: new Date(),
      },
      newlyBecameAdmin: false,
      grantedRole: null,
      inviteRejected: Boolean(rawInvite),
    };
  }
}

export async function setUserLanguage(
  prisma: PrismaClient,
  botId: string,
  tgId: number | bigint,
  lang: Lang,
): Promise<BotUser> {
  return prisma.botUser.update({
    where: {
      botId_tgId: {
        botId,
        tgId: BigInt(tgId),
      },
    },
    data: { lang },
  });
}

export async function getBotAdminUser(
  prisma: PrismaClient,
  botId: string,
  tgId: number | bigint,
): Promise<BotUser | null> {
  try {
    const user = await prisma.botUser.findUnique({
      where: {
        botId_tgId: {
          botId,
          tgId: BigInt(tgId),
        },
      },
    });
    if (!user?.isAdmin) return null;
    return {
      ...user,
      role: user.role ?? "OWNER",
      receivesLeads: user.receivesLeads ?? true,
    };
  } catch {
    return null;
  }
}

export async function isActualBotAdmin(
  prisma: PrismaClient,
  botId: string,
  tgId: number | bigint,
  action?: BotAdminAction,
): Promise<boolean> {
  const admin = await getBotAdminUser(prisma, botId, tgId);
  if (!admin) return false;
  if (!action) return true;
  return can(admin, action);
}
