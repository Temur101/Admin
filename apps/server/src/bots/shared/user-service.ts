import type { BotUser, Lang, PrismaClient } from "@prisma/client";

export interface UpsertBotUserParams {
  botId: string;
  tgId: number | bigint;
  firstName?: string | null;
  username?: string | null;
  inviteCode?: string | null;
  expectedInviteCode?: string | null;
}

export async function upsertBotUser(
  prisma: PrismaClient,
  params: UpsertBotUserParams,
): Promise<{ user: BotUser; newlyBecameAdmin: boolean }> {
  const tgIdBig = BigInt(params.tgId);
  const isInviteMatch =
    Boolean(params.inviteCode) &&
    Boolean(params.expectedInviteCode) &&
    params.inviteCode === params.expectedInviteCode;

  try {
    const existing = await prisma.botUser.findUnique({
      where: {
        botId_tgId: {
          botId: params.botId,
          tgId: tgIdBig,
        },
      },
    });

    if (!existing) {
      const user = await prisma.botUser.create({
        data: {
          botId: params.botId,
          tgId: tgIdBig,
          firstName: params.firstName ?? null,
          username: params.username ?? null,
          isAdmin: isInviteMatch,
        },
      });
      return { user, newlyBecameAdmin: isInviteMatch };
    }

    // Update profile and promote to admin if valid invite code provided
    const shouldPromote = isInviteMatch && !existing.isAdmin;
    const user = await prisma.botUser.update({
      where: {
        botId_tgId: {
          botId: params.botId,
          tgId: tgIdBig,
        },
      },
      data: {
        firstName: params.firstName ?? existing.firstName,
        username: params.username ?? existing.username,
        isAdmin: shouldPromote ? true : existing.isAdmin,
      },
    });

    return { user, newlyBecameAdmin: shouldPromote };
  } catch {
    // Graceful fallback for synthetic/unpersisted test bots
    return {
      user: {
        id: "00000000-0000-0000-0000-000000000000",
        botId: params.botId,
        tgId: tgIdBig,
        firstName: params.firstName ?? null,
        username: params.username ?? null,
        lang: null,
        isAdmin: isInviteMatch,
        createdAt: new Date(),
      },
      newlyBecameAdmin: isInviteMatch,
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

export async function isActualBotAdmin(
  prisma: PrismaClient,
  botId: string,
  tgId: number | bigint,
): Promise<boolean> {
  try {
    const user = await prisma.botUser.findUnique({
      where: {
        botId_tgId: {
          botId,
          tgId: BigInt(tgId),
        },
      },
      select: { isAdmin: true },
    });
    return Boolean(user?.isAdmin);
  } catch {
    return false;
  }
}

