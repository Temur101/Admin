import { apiRequest, setStoredToken } from "./client.js";
import type { AdminLoginRequest } from "@lcqb/contracts";

export interface AdminUser {
  id: string;
  email: string;
  name?: string;
  role?: string;
  createdAt?: string;
}

export interface LoginResponse {
  ok: true;
  accessToken?: string;
  token?: string;
  admin?: AdminUser;
  user?: AdminUser;
}

export interface MeResponse {
  ok: true;
  admin?: AdminUser;
  user?: AdminUser;
}

export async function login(credentials: AdminLoginRequest): Promise<LoginResponse> {
  const data = await apiRequest<LoginResponse>("/api/v1/auth/login", {
    method: "POST",
    body: JSON.stringify(credentials),
  });
  const token = data.accessToken || data.token;
  if (token) {
    setStoredToken(token);
  }
  return data;
}

export async function logout(): Promise<void> {
  try {
    await apiRequest("/api/v1/auth/logout", { method: "POST" });
  } finally {
    setStoredToken(null);
  }
}

export async function getMe(): Promise<AdminUser | null> {
  try {
    const data = await apiRequest<MeResponse>("/api/v1/auth/me");
    return data.admin || data.user || null;
  } catch {
    return null;
  }
}
