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

export interface QuizSessionAnswer {
  question: string;
  answer: string;
  optionId?: string;
}

export interface QuizSessionState {
  currentNodeId: string;
  stepCount: number;
  answers: Record<string, QuizSessionAnswer>;
  startedAt: number;
}

export interface PlatformBotSession {
  lang?: "RU" | "UZ";
  isAdmin?: boolean;
  quiz?: QuizSessionState;
  [key: string]: unknown;
}

export type PlatformBotContext = Context &
  SessionFlavor<PlatformBotSession> & {
    botMeta: ResolvedBot;
  };
