import { apiRequest } from "./client.js";
import type {
  CreateBotRequest,
  ExtendSubscriptionRequest,
  ReduceSubscriptionRequest,
  GrantTrialRequest,
} from "@lcqb/contracts";

export interface BotListItem {
  id: string;
  tenantId: string;
  tenantName: string;
  botType: "LEADCATCH" | "QUICKBOOK";
  botUsername: string | null;
  isActive: boolean;
  adminInviteCode: string;
  createdAt: string;
  subscription: {
    status: string;
    trialEndsAt: string;
    paidUntil: string | null;
  } | null;
  stats: {
    leadsCount: number;
    bookingsCount: number;
    usersCount: number;
    adminsCount?: number;
    receiptsCount: number;
  };
}

export interface BotAdmin {
  tgId: string;
  firstName?: string | null;
  username?: string | null;
  createdAt: string;
}

export interface BotDetails extends BotListItem {
  inviteLink: string | null;
  settings: unknown;
  admins: BotAdmin[];
}

export interface WebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  last_error_date?: number;
  last_error_message?: string;
}

export interface BotHealth {
  botId: string;
  isActive: boolean;
  subscriptionStatus: string;
  failedInboxCount: number;
  connection?: {
    mode: "polling" | "webhook";
    status: "READY" | "PAUSED" | "STOPPED" | "NOT_CONFIGURED" | "ERROR" | "UNKNOWN";
    message: string;
    checkedAt: string;
  };
}

export async function getBots(): Promise<BotListItem[]> {
  const data = await apiRequest<{ ok: true; bots: BotListItem[] }>("/api/v1/bots");
  return data.bots;
}

export async function getBot(id: string): Promise<BotDetails> {
  const data = await apiRequest<{ ok: true; bot: BotDetails }>(`/api/v1/bots/${id}`);
  return data.bot;
}

export interface CreateBotResult {
  id: string;
  botUsername?: string | null;
  inviteLink: string | null;
  adminInviteCode?: string;
  warning?: string;
  trialEndsAt: string;
}

export async function createBot(payload: CreateBotRequest): Promise<CreateBotResult> {
  const data = await apiRequest<{ ok: true; bot: CreateBotResult }>("/api/v1/bots", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return data.bot;
}

export async function suspendBot(id: string): Promise<void> {
  await apiRequest(`/api/v1/bots/${id}/suspend`, { method: "POST" });
}

export async function resumeBot(id: string): Promise<void> {
  await apiRequest(`/api/v1/bots/${id}/resume`, { method: "POST" });
}

export async function deleteBot(id: string, purge = false): Promise<void> {
  await apiRequest(`/api/v1/bots/${id}?purge=${purge}`, { method: "DELETE" });
}

export async function reissueBotInvite(
  id: string,
): Promise<{ adminInviteCode: string; inviteLink: string | null }> {
  return apiRequest(`/api/v1/bots/${id}/reissue-invite`, { method: "POST" });
}

export async function extendBotSubscription(
  id: string,
  payload: ExtendSubscriptionRequest,
): Promise<void> {
  await apiRequest(`/api/v1/bots/${id}/extend`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function reduceBotSubscription(
  id: string,
  payload: ReduceSubscriptionRequest,
): Promise<void> {
  await apiRequest(`/api/v1/bots/${id}/reduce`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function grantBotTrial(
  id: string,
  payload: GrantTrialRequest,
): Promise<void> {
  await apiRequest(`/api/v1/bots/${id}/trial`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function resetBot(
  id: string,
): Promise<{ clearedSessions: number; warning?: string }> {
  return apiRequest(`/api/v1/bots/${id}/reset`, {
    method: "POST",
  });
}

export async function unblockBot(id: string): Promise<void> {
  await apiRequest(`/api/v1/bots/${id}/unblock`, { method: "POST" });
}

export async function getBotAdmins(id: string): Promise<BotAdmin[]> {
  const data = await apiRequest<{ ok: true; admins: BotAdmin[] }>(`/api/v1/bots/${id}/admins`);
  return data.admins;
}

export async function revokeBotAdmin(botId: string, tgId: string): Promise<void> {
  await apiRequest(`/api/v1/bots/${botId}/admins/${tgId}`, { method: "DELETE" });
}

export async function getBotWebhookInfo(id: string): Promise<WebhookInfo> {
  const data = await apiRequest<{ ok: true; webhookInfo: WebhookInfo }>(
    `/api/v1/bots/${id}/webhook-info`,
  );
  return data.webhookInfo;
}

export async function syncBotWebhook(id: string): Promise<{ webhookSecret: string }> {
  return apiRequest(`/api/v1/bots/${id}/sync-webhook`, { method: "POST" });
}

export async function getBotHealth(id: string): Promise<BotHealth> {
  const data = await apiRequest<{ ok: true; health: BotHealth }>(`/api/v1/bots/${id}/health`);
  return data.health;
}

export interface BotSetupCheck {
  configurationReady: boolean;
  telegramReady: boolean;
  canLaunch: boolean;
  errors: string[];
  checkedAt: string;
}
export async function checkBotSetup(id: string): Promise<BotSetupCheck> {
  const data = await apiRequest<{ ok: true; check: BotSetupCheck }>(
    `/api/v1/bots/${id}/setup-check`,
  );
  return data.check;
}
export async function launchBot(id: string): Promise<void> {
  await apiRequest(`/api/v1/bots/${id}/launch`, { method: "POST" });
}
