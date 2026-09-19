/**
 * 单据详情。
 *
 * 界面上老板看到的是"这张单的经过"，不是"作废/红冲/反向凭证"那套会计词汇。
 * 但底下的修订链必须是完整可查的 —— 改错账是产品功能，而不是"直接改库"，
 * 代价就是每次改动都留一条记录（docs/05）。
 */
import type { Database } from 'better-sqlite3';

export interface SaleItemDetail {
  productId: number;
  name: string;
  unit: 'base' | 'pack';
  unitLabel: string;
  qtyMilli: number;
  unitPriceCents: number;
  amountCents: number;
  unitCostE4: number;
  costCents: number;
  profitCents: number;
}

export interface SaleEvent {
  kind: 'created' | 'revised' | 'returned' | 'voided';
  saleId: number;
  at: string;
  rev: number;
  summary: string;
  current: boolean;
}

export interface SaleDetail {
  id: number;
  bizDate: string;
  createdAt: string;
  settleType: 'cash' | 'credit';
  customerId: number | null;
  customerName: string | null;
  originalCents: number;
  discountCents: number;
  totalCents: number;
  costCents: number;
  profitCents: number;
  note: string;
  voidedAt: string | null;
  voidReason: string | null;
  rev: number;
  revisionOfSaleId: number | null;
  supersededBySaleId: number | null;
  returnOfSaleId: number | null;
  /** 已退回多少（金额为负） */
  returnedCents: number;
  /** 挂账单已核销多少 */
  settledCents: number;
  items: SaleItemDetail[];
  events: SaleEvent[];
  /** 能不能改 / 能不能退 —— 由后端判断，前端不要自己猜 */
  canRevise: boolean;
  canReturn: boolean;
  blockedReason: string | null;
}

interface Row {
  id: number;
  biz_date: string;
  created_at: string;
  settle_type: 'cash' | 'credit';
  customer_id: number | null;
  customer_name: string | null;
  original_amount_cents: number;
  discount_amount_cents: number;
  total_amount_cents: number;
  cost_amount_cents: number;
  gross_profit_cents: number;
  note: string;
  voided_at: string | null;
  void_reason: string | null;
  rev: number;
  revision_of_sale_id: number | null;
  superseded_by_sale_id: number | null;
  return_of_sale_id: number | null;
}

function loadRow(db: Database, id: number): Row | undefined {
  return db
    .prepare(
      `SELECT s.*, c.name AS customer_name
         FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
        WHERE s.id = ?`,
    )
    .get(id) as Row | undefined;
}

/** 顺着 revision_of_sale_id 一路回溯到最初那张单 */
function originOf(db: Database, row: Row): Row {
  let cur = row;
  const seen = new Set<number>([cur.id]);
  while (cur.revision_of_sale_id != null) {
    const prev = loadRow(db, cur.revision_of_sale_id);
    // 理论上不会成环，但链是数据驱动的，出了环就得停 —— 不能把界面转死
    if (!prev || seen.has(prev.id)) break;
    seen.add(prev.id);
    cur = prev;
  }
  return cur;
}

/** 从最初那张单顺着 superseded_by_sale_id 往下走完整条链 */
function chainOf(db: Database, row: Row): Row[] {
  const chain: Row[] = [originOf(db, row)];
  const seen = new Set<number>([chain[0].id]);
  for (;;) {
    const next = chain[chain.length - 1].superseded_by_sale_id;
    if (next == null || seen.has(next)) break;
    const r = loadRow(db, next);
    if (!r) break;
    seen.add(r.id);
    chain.push(r);
  }
  return chain;
}

function itemsOf(db: Database, saleId: number): SaleItemDetail[] {
  return (
    db
      .prepare(
        `SELECT si.*, p.name, p.base_unit, p.pack_unit
           FROM sale_items si JOIN products p ON p.id = si.product_id
          WHERE si.sale_id = ? ORDER BY si.id`,
      )
      .all(saleId) as Record<string, never>[]
  ).map((r) => ({
    productId: Number(r['product_id']),
    name: String(r['name']),
    unit: r['unit'] as 'base' | 'pack',
    unitLabel: r['unit'] === 'pack' ? String(r['pack_unit'] ?? r['base_unit']) : String(r['base_unit']),
    qtyMilli: Number(r['qty_milli']),
    unitPriceCents: Number(r['unit_price_cents']),
    amountCents: Number(r['amount_cents']),
    unitCostE4: Number(r['unit_cost_base_e4']),
    costCents: Number(r['cost_amount_cents']),
    profitCents: Number(r['amount_cents']) - Number(r['cost_amount_cents']),
  }));
}

/** 一句话说清这张单是什么 */
function summarize(db: Database, row: Row): string {
  const items = itemsOf(db, row.id);
  if (items.length === 0) return '没有明细';
  const first = `${items[0].name} ${Math.abs(items[0].qtyMilli) / 1000} ${items[0].unitLabel}`;
  return items.length > 1 ? `${first} 等 ${items.length} 样` : first;
}

export function saleDetail(db: Database, id: number): SaleDetail {
  const row = loadRow(db, id);
  if (!row) throw new Error(`单据不存在：${id}`);

  const chain = chainOf(db, row);

  const events: SaleEvent[] = chain.map((r, i) => ({
    kind: i === 0 ? 'created' : 'revised',
    saleId: r.id,
    at: r.created_at,
    rev: r.rev,
    summary: summarize(db, r),
    current: r.voided_at == null,
  }));

  // 退货挂在这张单上，按发生时间插进经过里
  const returns = db
    .prepare(
      `SELECT id, biz_date, created_at, total_amount_cents
         FROM sales WHERE return_of_sale_id = ? AND voided_at IS NULL ORDER BY id`,
    )
    .all(row.id) as { id: number; biz_date: string; created_at: string; total_amount_cents: number }[];

  for (const r of returns) {
    events.push({
      kind: 'returned',
      saleId: r.id,
      at: r.created_at,
      rev: 0,
      summary: `退货　${r.biz_date}`,
      current: false,
    });
  }

  if (row.voided_at && row.void_reason !== 'revised') {
    events.push({
      kind: 'voided',
      saleId: row.id,
      at: row.voided_at,
      rev: row.rev,
      summary: '这笔生意没发生过',
      current: false,
    });
  }

  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.saleId - b.saleId));

  const returnedCents = returns.reduce((s, r) => s + r.total_amount_cents, 0);
  const settledCents = (
    db
      .prepare('SELECT COALESCE(SUM(amount_cents), 0) AS v FROM payment_allocations WHERE sale_id = ?')
      .get(row.id) as { v: number }
  ).v;

  // 能不能改 / 能不能退，由后端说了算 —— 前端各自猜一遍迟早猜岔
  let blockedReason: string | null = null;
  if (row.voided_at) {
    blockedReason = row.void_reason === 'revised' ? '这是旧版本，请打开最新那张' : '这张单已经作废了';
  } else if (row.return_of_sale_id != null) {
    blockedReason = '这是一张退货单';
  }

  return {
    id: row.id,
    bizDate: row.biz_date,
    createdAt: row.created_at,
    settleType: row.settle_type,
    customerId: row.customer_id,
    customerName: row.customer_name,
    originalCents: row.original_amount_cents,
    discountCents: row.discount_amount_cents,
    totalCents: row.total_amount_cents,
    costCents: row.cost_amount_cents,
    profitCents: row.gross_profit_cents,
    note: row.note,
    voidedAt: row.voided_at,
    voidReason: row.void_reason,
    rev: row.rev,
    revisionOfSaleId: row.revision_of_sale_id,
    supersededBySaleId: row.superseded_by_sale_id,
    returnOfSaleId: row.return_of_sale_id,
    returnedCents,
    settledCents,
    items: itemsOf(db, row.id),
    events,
    canRevise: blockedReason == null,
    canReturn: blockedReason == null && row.total_amount_cents + returnedCents > 0,
    blockedReason,
  };
}

/** 某天的流水，给看板和单据列表用 */
export function listSales(db: Database, bizDate: string): { id: number; time: string; summary: string; totalCents: number; settleType: string; customerName: string | null }[] {
  const rows = db
    .prepare(
      `SELECT s.id, s.created_at, s.total_amount_cents, s.settle_type, c.name AS customer_name
         FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
        WHERE s.biz_date = ? AND s.voided_at IS NULL
        ORDER BY s.id DESC`,
    )
    .all(bizDate) as Row[];

  return rows.map((r) => ({
    id: r.id,
    time: String(r.created_at).slice(11, 16),
    summary: summarize(db, r),
    totalCents: r.total_amount_cents,
    settleType: r.settle_type,
    customerName: r.customer_name,
  }));
}
