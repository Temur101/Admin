import { apiRequest, getStoredToken } from "./client.js";
import type { RejectReceiptRequest } from "@lcqb/contracts";

export interface ReceiptItem {
  id: string;
  botId: string;
  botUsername: string | null;
  botType: "LEADCATCH" | "QUICKBOOK";
  tenantName: string;
  submittedByTgId: string;
  kind: "PHOTO" | "TEXT";
  imagePath: string | null;
  textNote: string | null;
  months: number;
  amount: number;
  status: "PENDING" | "APPROVED" | "REJECTED";
  createdAt: string;
  rejectionReason?: string | null;
  reviewedAt?: string | null;
}

export async function getReceipts(status = "PENDING"): Promise<ReceiptItem[]> {
  const data = await apiRequest<{ ok: true; receipts: ReceiptItem[] }>(
    `/api/v1/receipts?status=${status}`,
  );
  return data.receipts;
}

export async function approveReceipt(id: string): Promise<void> {
  await apiRequest(`/api/v1/receipts/${id}/approve`, { method: "POST" });
}

export async function rejectReceipt(id: string, payload: RejectReceiptRequest): Promise<void> {
  await apiRequest(`/api/v1/receipts/${id}/reject`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getReceiptImageUrl(id: string): string {
  const token = getStoredToken();
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return `/api/v1/receipts/${id}/image${query}`;
}
