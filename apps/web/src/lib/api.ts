import type { ApiError, MeResponse } from "@kiosk/shared";

export class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: "include",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new RequestError(0, "offline", "You're offline. Check your connection and try again.");
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = (data as ApiError | null)?.error;
    throw new RequestError(res.status, e?.code ?? "unknown", e?.message ?? "Something went wrong.", e?.fields);
  }
  return data as T;
}

export const api = {
  me: () => request<MeResponse>("GET", "/auth/me"),
  requestOtp: (phone: string) =>
    request<{ challengeId: string; expiresAt: string; resendAfterMs: number }>("POST", "/auth/otp/request", { phone }),
  verifyOtp: (challengeId: string, code: string) =>
    request<{ account: MeResponse["account"] }>("POST", "/auth/otp/verify", { challengeId, code }),
  logout: () => request<void>("POST", "/auth/logout", {}),
  slugAvailability: (slug: string, signal?: AbortSignal) =>
    fetch(`/api/sellers/slug-availability?slug=${encodeURIComponent(slug)}`, { signal, credentials: "include" }).then(
      (r) => r.json() as Promise<{ available: boolean; reason?: string }>,
    ),
  onboard: (input: unknown) =>
    request<{ seller: { id: string; slug: string; status: string } }>("POST", "/sellers/onboarding", input),
};
