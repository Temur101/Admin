import type { BotAdminRole, BotType, SubStatus } from "@prisma/client";
import type { Context, SessionFlavor } from "grammy";

export interface ResolvedBot {
  id: string;
  tenantId: string;
  botType: BotType;
  botTokenEnc: string;
  botTokenHash: string;
  webhookSecret: string;
  botUsername: string | null;
  adminInviteCode?: string;
  healthStatus?: string;
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
  path?: string[];
  answers: Record<string, QuizSessionAnswer>;
  phone?: string;
  phoneVerified?: boolean;
  startedAt: number;
}

export interface QuickBookSessionState {
  runId?: string;
  serviceId?: string;
  resourceId?: string;
  dateStr?: string;
  slotTimeIso?: string;
  customerName?: string;
  phone?: string;
  phoneVerified?: boolean;
  step?:
    | "service"
    | "resource"
    | "date"
    | "slot"
    | "phone"
    | "summary"
    | "edit"
    | "admin_name"
    | "admin_phone"
    | "admin_summary";
  isAdminBooking?: boolean;
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
  adminRole?: BotAdminRole | null;
  receivesLeads?: boolean;
  quiz?: QuizSessionState;
  quickbook?: QuickBookSessionState;
  payment?: PaymentSessionState;
  timeBlockDraft?: {
    resourceId: string;
    startsAt: string;
    endsAt: string;
    token: string;
    expiresAt: number;
  };
  reschedule?: { bookingId: string; token: string; expiresAt: number; slots: string[] };
  [key: string]: unknown;
}

export type PlatformBotContext = Context &
  SessionFlavor<PlatformBotSession> & {
    botMeta: ResolvedBot;
  };
