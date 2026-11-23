import type {
  ApiError,
  DeliveryConfigDto,
  ImageDto,
  MeResponse,
  ProductDto,
  ProductInput,
  ProductListItem,
  ProductStatus,
  ZoneInput,
} from "@kiosk/shared";

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

type Method = "GET" | "POST" | "PUT" | "DELETE";

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
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

/** XHR rather than fetch: fetch still can't report upload progress. */
export function uploadImage(file: Blob, onProgress: (fraction: number) => void, signal?: AbortSignal) {
  return new Promise<ImageDto>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/seller/images");
    xhr.withCredentials = true;
    xhr.responseType = "json";
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status === 201) return resolve((xhr.response as { image: ImageDto }).image);
      const e = (xhr.response as ApiError | null)?.error;
      reject(new RequestError(xhr.status, e?.code ?? "upload_failed", e?.message ?? "That photo didn't upload."));
    };
    xhr.onerror = () => reject(new RequestError(0, "offline", "Upload failed. Check your connection."));
    signal?.addEventListener("abort", () => xhr.abort());
    const form = new FormData();
    form.append("file", file, "photo.jpg");
    xhr.send(form);
  });
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

  products: () => request<{ products: ProductListItem[] }>("GET", "/seller/products").then((r) => r.products),
  product: (id: string) => request<{ product: ProductDto }>("GET", `/seller/products/${id}`).then((r) => r.product),
  createProduct: (input: ProductInput) =>
    request<{ product: ProductDto }>("POST", "/seller/products", input).then((r) => r.product),
  updateProduct: (id: string, input: ProductInput) =>
    request<{ product: ProductDto }>("PUT", `/seller/products/${id}`, input).then((r) => r.product),
  setProductStatus: (id: string, status: ProductStatus) =>
    request<{ product: ProductDto }>("POST", `/seller/products/${id}/status`, { status }).then((r) => r.product),
  discardImage: (id: string) => request<void>("DELETE", `/seller/images/${id}`),

  delivery: () => request<DeliveryConfigDto>("GET", "/seller/delivery"),
  saveZones: (zones: ZoneInput[]) => request<DeliveryConfigDto>("PUT", "/seller/delivery/zones", { zones }),
  saveDeliverySettings: (s: DeliveryConfigDto["settings"]) =>
    request<DeliveryConfigDto>("PUT", "/seller/delivery/settings", s),
};
