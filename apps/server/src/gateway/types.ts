import type { BotType, SubStatus } from "@prisma/client";
import type { Context, SessionFlavor } from "grammy";

export interface ResolvedBot {
  id: string;
  tenantId: string;
  botType: BotType;
  botTokenEnc: string;
  botTokenHash: string;
  webhookSecret: string;
  botUsername: string | null;
  adminInviteCode: string;
  settings: Record<string, unknown>;
  subscriptionStatus: SubStatus;
  trialEndsAt: string;
  paidUntil: string | null;
}

export type PlatformBotSession = Record<string, unknown>;

export type PlatformBotContext = Context &
  SessionFlavor<PlatformBotSession> & {
    botMeta: ResolvedBot;
  };
