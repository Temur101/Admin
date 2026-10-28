import { apiRequest } from "./client.js";

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
  rejectionReason?: string | null;
  reviewedAt?: string | null;
  createdAt: string;
}

export async function getReceipts(status?: string): Promise<ReceiptItem[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : "";
  const res = await apiRequest<{ ok: boolean; receipts: ReceiptItem[] }>(
    `/api/v1/receipts${query}`,
  );
  return res.receipts;
}

export async function approveReceipt(id: string): Promise<void> {
  await apiRequest<{ ok: boolean }>(`/api/v1/receipts/${id}/approve`, {
    method: "POST",
  });
}

export async function rejectReceipt(id: string, data: { reason: string }): Promise<void> {
  await apiRequest<{ ok: boolean }>(`/api/v1/receipts/${id}/reject`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function getReceiptImageUrl(id: string): string {
  return `/api/v1/receipts/${id}/image`;
}
