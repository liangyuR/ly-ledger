/**
 * API 客户端。
 *
 * 没有 token、没有登录头 —— 服务只监听 127.0.0.1，能打开页面的人
 * 已经坐在柜台电脑前了（docs/03 认证）。
 *
 * 金额一律以**字符串**在前后端之间传递：库里是整数分，出参时格式化成
 * "1100.00"。前端不做金额运算，只做展示 —— 一旦在 JS 里用 number 算钱，
 * 0.1+0.2 那类问题就会回来。要算就让后端算。
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...init?.headers,
      },
    });
  } catch {
    // 本地服务连不上，多半是后台服务没起来。给人话，不给 TypeError
    throw new ApiError('连不上后台服务。看看它是不是没启动', 0);
  }

  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(`服务返回了看不懂的内容（HTTP ${res.status}）`, res.status);
  }

  const data = body as { ok?: boolean; error?: string };
  if (!res.ok || data.ok === false) {
    throw new ApiError(data.error ?? `请求失败（HTTP ${res.status}）`, res.status);
  }

  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
};

// ── 出参类型（与后端 routes 保持一致）────────────────────────

export interface Product {
  id: number;
  name: string;
  pinyin_full: string;
  pinyin_abbr: string;
  category: string;
  brand: string;
  spec: string;
  base_unit: string;
  pack_unit: string | null;
  pack_ratio: number;
  price_base_cents: number | null;
  price_pack_cents: number | null;
  sort_weight: number;
}

export interface StockInfo {
  qty: string;
  avgCost: string;
  negative: boolean;
}

export interface CheckoutResponse {
  saleId: number;
  total: string;
  grossProfit: string;
  paymentId: number | null;
}

export interface DebtInfo {
  customerId: number;
  name: string;
  netDebt: string;
  isPrepaid: boolean;
  earliestUnpaidDate: string | null;
}

export const endpoints = {
  health: () => api.get<{ ok: boolean; sqlite: string; tables: number }>('/health'),
  products: (q?: string) =>
    api.get<{ items: Product[] }>(`/api/products${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  stock: (productId: number) => api.get<StockInfo>(`/api/products/${productId}/stock`),
  checkout: (body: unknown) => api.post<CheckoutResponse>('/api/sales/checkout', body),
  receive: (body: unknown) => api.post<{ purchaseId: number; total: string }>('/api/purchases/receive', body),
  collect: (body: unknown) => api.post<{ paymentId: number; netDebt: string }>('/api/payments/collect', body),
  debt: (customerId: number) => api.get<DebtInfo>(`/api/customers/${customerId}/debt`),
  seedBrands: () =>
    api.get<{ brands: { brand: string; category: string; total: number; alreadyImported: number }[] }>(
      '/api/seed/brands',
    ),
};
