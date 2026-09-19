/**
 * API 客户端。
 *
 * 没有 HTTP，没有端口，没有 token —— 前端跑在应用自己的窗口里，
 * 每次调用直接走 Tauri 的 invoke 进到 Rust。
 *
 * 这一层保留了 `api.get('/api/...')` 的写法：**页面代码一行没改**。
 * 路径在这里翻译成命令名，翻译表就在下面，一眼能看全。
 * 直接把 43 处调用改成 43 个具名函数也行，但那是一次性收益 ——
 * 保留路径写法让这次迁移的 diff 只落在这一个文件里，回头对照 Node 版也方便。
 *
 * 金额一律以**字符串**在前后端之间传递：库里是整数分，出参时格式化成
 * "1100.00"。前端不做金额运算，只做展示 —— 一旦在 JS 里用 number 算钱，
 * 0.1+0.2 那类问题就会回来。要算就让后端算。
 */

import { invoke } from '@tauri-apps/api/core';
import { message } from '@tauri-apps/plugin-dialog';

export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

type Args = Record<string, unknown>;
type Method = 'GET' | 'POST' | 'PATCH';

/**
 * 路径 → 命令名。
 *
 * 顺序有意义：具体路径必须排在带 `:id` 的前面，否则 `/api/sales/checkout`
 * 会被当成「查 id 为 checkout 的单据」。
 */
function route(method: Method, path: string, body?: unknown): [string, Args] {
  const [bare, search = ''] = path.split('?');
  const query = new URLSearchParams(search);
  const seg = bare.split('/').filter(Boolean);
  const b = (body ?? {}) as Args;

  // seg[0] 是 'api'（/health 除外）
  const [, group, second, third] = seg;
  const id = Number(second);

  if (bare === '/health') return ['health', {}];

  switch (group) {
    case 'products':
      if (method === 'GET' && !second) return ['products_list', { q: query.get('q') ?? undefined }];
      if (method === 'GET' && second === 'frequent') return ['products_frequent', {}];
      if (method === 'GET' && third === 'stock') return ['product_stock', { productId: id }];
      if (method === 'POST' && !second) return ['product_create', { input: b }];
      if (method === 'POST' && second === 'parse-import') return ['products_parse_import', b];
      if (method === 'POST' && second === 'import') return ['products_import', b];
      if (method === 'PATCH') return ['product_update', { id, patch: b }];
      break;

    case 'seed':
      if (method === 'GET' && second === 'brands') return ['seed_brands', {}];
      if (method === 'POST' && second === 'import') return ['seed_import_brands', b];
      break;

    case 'customers':
      if (method === 'GET' && !second) return ['customers_list', { q: query.get('q') ?? undefined }];
      if (method === 'GET' && second === 'debts') return ['customers_debts', {}];
      if (method === 'GET' && third === 'debt') return ['customer_debt', { id }];
      if (method === 'POST' && !second) return ['customer_create', b];
      if (method === 'POST' && third === 'rebuild-allocations')
        return ['customer_rebuild_allocations', { id }];
      break;

    case 'suppliers':
      if (method === 'GET') return ['suppliers_list', {}];
      if (method === 'POST') return ['supplier_create', b];
      break;

    case 'sales':
      if (method === 'POST' && second === 'checkout') return ['sales_checkout', { input: b }];
      if (method === 'GET' && !second) return ['sales_by_date', { date: query.get('date') ?? undefined }];
      if (method === 'GET') return ['sale_detail', { id }];
      if (method === 'POST' && third === 'void') return ['sale_void', { id }];
      if (method === 'POST' && third === 'revise') return ['sale_revise', { id, input: b }];
      if (method === 'POST' && third === 'return') return ['sale_return', { id, input: b }];
      break;

    case 'purchases':
      if (method === 'POST' && second === 'receive') return ['purchases_receive', { input: b }];
      if (method === 'POST' && third === 'void') return ['purchase_void', { id }];
      if (method === 'POST' && third === 'revise') return ['purchase_revise', { id, input: b }];
      break;

    case 'payments':
      if (method === 'POST' && second === 'collect') return ['payments_collect', { input: b }];
      if (method === 'POST' && third === 'void') return ['payment_void', { id }];
      break;

    case 'reports':
      if (second === 'dashboard') return ['reports_dashboard', {}];
      if (second === 'profit') return ['reports_profit', { month: query.get('month') ?? undefined }];
      break;

    case 'onboarding':
      if (method === 'GET') return ['onboarding_state', {}];
      if (second === 'dismiss') return ['onboarding_dismiss', b];
      if (second === 'skip-stock') return ['onboarding_skip_stock', {}];
      if (second === 'opening-stock') return ['onboarding_opening_stock', { input: b }];
      break;

    case 'backup':
      if (second === 'status') return ['backup_status', {}];
      if (second === 'now') return ['backup_now', {}];
      if (second === 'drives') return ['backup_drives', {}];
      if (second === 'to-usb') return ['backup_to_usb', b];
      break;
  }

  // 走到这里说明加了新接口却忘了登记 —— 早炸比在界面上静默少一块好
  throw new ApiError(`这个接口没登记：${method} ${bare}`);
}

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const [command, args] = route(method, path, body);
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    // Rust 那边的错误就是一句人话，原样抛给页面
    throw new ApiError(typeof e === 'string' ? e : ((e as Error)?.message ?? '出错了'));
  }
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
};

// ── Excel 导出 ──────────────────────────────────────────────
//
// HTTP 时代这几个是 `window.location.href = '/api/...'`，浏览器默默存进
// 「下载」文件夹。现在弹系统的保存对话框，老板自己选存哪儿 ——
// 一份要发给会计的表，存完找不着才是真问题。

export type ExportKind = 'sales' | 'ranking' | 'stale' | 'debts' | 'products';

export interface ExportResult {
  /** false = 老板点了取消。这不是错误，别弹红框 */
  saved: boolean;
  path: string | null;
}

/**
 * 出一份表。失败在这里就地报掉，调用方一行搞定。
 *
 * 导出失败只有两种原因 —— 选的位置写不进去、表生成不出来 ——
 * 两种都只需要告诉老板一句，没有页面状态要更新，所以不值得让五个调用点
 * 各自接一套 flash。
 */
export async function exportXlsx(kind: ExportKind, args: Args = {}): Promise<ExportResult> {
  try {
    return await invoke<ExportResult>(`export_${kind}`, args);
  } catch (e) {
    const detail = typeof e === 'string' ? e : ((e as Error)?.message ?? '导出失败');
    await message(detail, { title: '导出没成功', kind: 'error' });
    return { saved: false, path: null };
  }
}

// ── 出参类型（与后端 commands 保持一致）────────────────────────

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
