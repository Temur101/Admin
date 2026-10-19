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
  attemptId?: string;
  notifiedLeadId?: string;
  pendingText?: { nodeId: string; optionId: string; buttonTag: string };
  currentNodeId: string;
  stepCount: number;
  answers: Record<string, QuizSessionAnswer>;
  startedAt: number;
}

export interface QuickBookSessionState {
  serviceId?: string;
  resourceId?: string;
  dateStr?: string;
  slotTimeIso?: string;
  lockedUntil?: number;
  lockToken?: string;
  lockDurationMin?: number;
  lockIntervalMin?: number;
}

export interface PaymentSessionState {
  months: number;
  amountUzs: number;
}

export interface PlatformBotSession {
  languageNextAction?: "start" | "menu";
  lang?: "RU" | "UZ";
  isAdmin?: boolean;
  quiz?: QuizSessionState;
  quickbook?: QuickBookSessionState;
  payment?: PaymentSessionState;
  [key: string]: unknown;
}

export type PlatformBotContext = Context &
  SessionFlavor<PlatformBotSession> & {
    botMeta: ResolvedBot;
  };
