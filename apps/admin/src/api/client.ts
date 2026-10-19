export interface ApiErrorResponse {
  ok: false;
  error: string;
  message?: string;
  details?: unknown;
  issues?: unknown;
}

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly errorData: ApiErrorResponse,
  ) {
    super(errorData.error || errorData.message || `Request failed with status ${statusCode}`);
    this.name = "ApiError";
  }
}

const TOKEN_KEY = "admin_access_token";

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // Ignore storage errors
  }
}

let refreshPromise: Promise<string | null> | null = null;

async function requestTokenRefresh(): Promise<string | null> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const res = await fetch("/api/v1/auth/refresh", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        return null;
      }
      const data = (await res.json()) as { ok: boolean; accessToken?: string };
      if (data.ok && data.accessToken) {
        setStoredToken(data.accessToken);
        return data.accessToken;
      }
      return null;
    } catch {
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

export async function apiRequest<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(options.headers || {});

  if (options.body == null || options.body === "") {
    headers.delete("Content-Type");
  } else if (!headers.has("Content-Type") && typeof options.body === "string") {
    headers.set("Content-Type", "application/json");
  }

  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const url = endpoint.startsWith("http") ? endpoint : endpoint;

  let response = await fetch(url, {
    ...options,
    headers,
    credentials: "include",
  });

  if (
    response.status === 401 &&
    !endpoint.includes("/api/v1/auth/login") &&
    !endpoint.includes("/api/v1/auth/refresh")
  ) {
    const refreshedToken = await requestTokenRefresh();
    if (refreshedToken) {
      headers.set("Authorization", `Bearer ${refreshedToken}`);
      response = await fetch(url, {
        ...options,
        headers,
        credentials: "include",
      });
    } else {
      setStoredToken(null);
      if (!window.location.pathname.includes("/login")) {
        window.location.href = "/login";
      }
    }
  }

  let data: unknown;
  const contentType = response.headers.get("content-type");
  if (contentType && contentType.includes("application/json")) {
    data = await response.json().catch(() => null);
  } else {
    data = await response.text().catch(() => "");
  }

  if (!response.ok) {
    const errorPayload: ApiErrorResponse =
      typeof data === "object" && data !== null && "error" in data
        ? (data as ApiErrorResponse)
        : { ok: false, error: response.statusText || `Error ${response.status}` };
    throw new ApiError(response.status, errorPayload);
  }

  return data as T;
}
