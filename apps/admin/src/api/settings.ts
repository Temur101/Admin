import { apiRequest } from "./client.js";
import type { UpdatePlatformSettingsRequest } from "@lcqb/contracts";

export interface PlatformTariff {
  months: number;
  amountUzs?: number;
  priceUzs?: number;
}

export interface PlatformSettingsData {
  id?: number;
  paymentDetails: string;
  supportContact: string;
  maintenanceMode: boolean;
  alertChatId?: string | null;
  alertBotUsername?: string | null;
  hasAlertBotToken?: boolean;
  tariffs?: PlatformTariff[] | {
    tariff1m?: number;
    tariff6m?: number;
    tariff12m?: number;
  };
}

export async function getPlatformSettings(): Promise<PlatformSettingsData> {
  const data = await apiRequest<{ ok: true; settings: PlatformSettingsData }>("/api/v1/settings");
  return data.settings;
}

export async function updatePlatformSettings(
  payload: UpdatePlatformSettingsRequest,
): Promise<PlatformSettingsData> {
  const data = await apiRequest<{ ok: true; settings: PlatformSettingsData }>("/api/v1/settings", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  return data.settings;
}

export async function sendTestAlert(): Promise<void> {
  await apiRequest("/api/v1/settings/test-alert", { method: "POST" });
}
