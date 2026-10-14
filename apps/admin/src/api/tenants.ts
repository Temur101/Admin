import { apiRequest } from "./client.js";
import type { CreateTenantRequest } from "@lcqb/contracts";

export interface TenantItem {
  id: string;
  clientName: string;
  contactPhone: string;
  status: "ACTIVE" | "SUSPENDED";
  isSuspended?: boolean;
  createdAt: string;
  botsCount: number;
}

export interface TenantsListResponse {
  ok: true;
  tenants: TenantItem[];
}

export interface CreateTenantResponse {
  ok: true;
  tenant: {
    id: string;
    clientName: string;
    contactPhone: string;
    createdAt: string;
  };
}

export async function getTenants(): Promise<TenantItem[]> {
  const data = await apiRequest<TenantsListResponse>("/api/v1/tenants");
  return data.tenants;
}

export async function createTenant(payload: CreateTenantRequest): Promise<CreateTenantResponse["tenant"]> {
  const data = await apiRequest<CreateTenantResponse>("/api/v1/tenants", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return data.tenant;
}

export async function suspendTenant(id: string): Promise<void> {
  await apiRequest(`/api/v1/tenants/${id}`, {
    method: "DELETE",
  });
}
