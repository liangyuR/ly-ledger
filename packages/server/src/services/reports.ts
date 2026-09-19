/**
 * 看板与列表查询。
 *
 * 所有口径一律 `voided_at IS NULL`、一律按 `biz_date` 统计 ——
 * 用 created_at 当业务时间，补录一笔上周的账会静默算错上周报表（红线 2）。
 */
import type { Database } from 'better-sqlite3';

import { divRound } from '../money';

/** 服务器本地日期。老板说的"今天"是他那台电脑上的今天 */
export function today(db: Database): string {
  const row = db.prepare("SELECT date('now', 'localtime') AS d").get() as { d: string };
  return row.d;
}

function monthOf(date: string): string {
  return date.slice(0, 7);
}

export interface DebtRow {
  customerId: number;
  name: string;
  /** 正数 = 欠款，负数 = 预收 */
  netDebtCents: number;
  earliestUnpaidDate: string | null;
  agingDays: number | null;
}

/**
 * 欠款列表。**按账龄倒序 —— 拖得最久的排最前**，
 * 这才是老板该先打电话的人（docs/04）。
 *
 * 预收客户（净额为负）单独返回，不混进催收队列 ——
 * 混进去会让这个列表失去可信度。
 */
export function listDebts(db: Database, asOf?: string): { owing: DebtRow[]; prepaid: DebtRow[] } {
  const day = asOf ?? today(db);

  const rows = db
    .prepare(
      `SELECT c.id AS customerId, c.name,
              COALESCE((SELECT SUM(total_amount_cents) FROM sales
                         WHERE customer_id = c.id AND settle_type = 'credit' AND voided_at IS NULL), 0)
            - COALESCE((SELECT SUM(amount_cents) FROM payments
                         WHERE customer_id = c.id AND voided_at IS NULL), 0) AS netDebtCents,
              (SELECT MIN(s.biz_date) FROM sales s
                WHERE s.customer_id = c.id AND s.settle_type = 'credit'
                  AND s.voided_at IS NULL AND s.return_of_sale_id IS NULL
                  AND s.total_amount_cents > COALESCE(
                        (SELECT SUM(amount_cents) FROM payment_allocations WHERE sale_id = s.id), 0)
              ) AS earliestUnpaidDate
         FROM customers c
        WHERE c.is_active = 1`,
    )
    .all() as { customerId: number; name: string; netDebtCents: number; earliestUnpaidDate: string | null }[];

  const withAging = rows.map<DebtRow>((r) => ({
    ...r,
    agingDays: r.earliestUnpaidDate
      ? Math.floor(
          (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${r.earliestUnpaidDate}T00:00:00Z`)) / 86_400_000,
        )
      : null,
  }));

  return {
    // 账龄倒序：最早那笔越久远越靠前
    owing: withAging
      .filter((r) => r.netDebtCents > 0)
      .sort((a, b) => (b.agingDays ?? 0) - (a.agingDays ?? 0)),
    prepaid: withAging.filter((r) => r.netDebtCents < 0),
  };
}

export interface FrequentProduct {
  id: number;
  name: string;
  base_unit: string;
  pack_unit: string | null;
  pack_ratio: number;
  price_base_cents: number | null;
  price_pack_cents: number | null;
  soldQtyMilli: number;
}

/**
 * 常用商品：按近 30 天销量取前 N，可用 sort_weight 手动置顶。
 * 新店还没有销量时，退回按建档顺序 —— 不能给老板一个空格子。
 */
export function frequentProducts(db: Database, limit = 12): FrequentProduct[] {
  const day = today(db);
  return db
    .prepare(
      `SELECT p.id, p.name, p.base_unit, p.pack_unit, p.pack_ratio,
              p.price_base_cents, p.price_pack_cents,
              COALESCE(SUM(si.qty_base_milli), 0) AS soldQtyMilli
         FROM products p
         LEFT JOIN sale_items si ON si.product_id = p.id
         LEFT JOIN sales s ON s.id = si.sale_id
              AND s.voided_at IS NULL
              AND s.biz_date >= date(?, '-30 day')
        WHERE p.is_active = 1
        GROUP BY p.id
        ORDER BY p.sort_weight DESC, soldQtyMilli DESC, p.id
        LIMIT ?`,
    )
    .all(day, limit) as FrequentProduct[];
}

export interface DashboardData {
  date: string;
  todayRevenueCents: number;
  todayProfitCents: number;
  monthProfitCents: number;
  inventoryValueCents: number;
  debtTotalCents: number;
  debtCount: number;
  alerts: { kind: 'negative_stock' | 'missing_price' | 'stale'; count: number; detail: string }[];
  recentSales: {
    id: number;
    time: string;
    summary: string;
    totalCents: number;
    settleType: 'cash' | 'credit';
    customerName: string | null;
  }[];
}

export function dashboard(db: Database): DashboardData {
  const day = today(db);
  const month = monthOf(day);

  const sum = (sql: string, ...args: unknown[]) =>
    (db.prepare(sql).get(...args) as { v: number | null }).v ?? 0;

  const todayRevenueCents = sum(
    "SELECT SUM(total_amount_cents) AS v FROM sales WHERE biz_date = ? AND voided_at IS NULL",
    day,
  );
  const todayProfitCents = sum(
    "SELECT SUM(gross_profit_cents) AS v FROM sales WHERE biz_date = ? AND voided_at IS NULL",
    day,
  );
  const monthProfitCents = sum(
    "SELECT SUM(gross_profit_cents) AS v FROM sales WHERE substr(biz_date, 1, 7) = ? AND voided_at IS NULL",
    month,
  );

  // 库存金额只算正库存 —— 负库存是"可能漏记进货"，把它的负值算进资产没有意义
  const invRows = db
    .prepare('SELECT qty_base_milli AS q, avg_cost_base_e4 AS c FROM inventory WHERE qty_base_milli > 0')
    .all() as { q: number; c: number }[];
  const inventoryValueCents = invRows.reduce(
    (acc, r) => acc + divRound(BigInt(r.q) * BigInt(r.c), 100_000n),
    0,
  );

  const debts = listDebts(db, day);

  const negativeStock = (
    db.prepare('SELECT count(*) AS n FROM inventory WHERE qty_base_milli < 0').get() as { n: number }
  ).n;
  const missingPrice = (
    db
      .prepare(
        'SELECT count(*) AS n FROM products WHERE is_active = 1 AND price_base_cents IS NULL AND price_pack_cents IS NULL',
      )
      .get() as { n: number }
  ).n;
  const stale = (
    db
      .prepare(
        `SELECT count(*) AS n FROM inventory i
          WHERE i.qty_base_milli > 0
            AND NOT EXISTS (
              SELECT 1 FROM sale_items si JOIN sales s ON s.id = si.sale_id
               WHERE si.product_id = i.product_id AND s.voided_at IS NULL
                 AND s.biz_date >= date(?, '-90 day'))`,
      )
      .get(day) as { n: number }
  ).n;

  const alerts: DashboardData['alerts'] = [];
  if (negativeStock > 0) {
    alerts.push({
      kind: 'negative_stock',
      count: negativeStock,
      detail: '可能漏记进货。不拦你记账，只是提醒',
    });
  }
  if (missingPrice > 0) {
    alerts.push({
      kind: 'missing_price',
      count: missingPrice,
      detail: '没填价格不影响卖货，只是毛利算不出来',
    });
  }
  if (stale > 0) {
    alerts.push({ kind: 'stale', count: stale, detail: '超 90 天未动，压着钱' });
  }

  const recentSales = (
    db
      .prepare(
        `SELECT s.id, s.created_at, s.total_amount_cents, s.settle_type, c.name AS customerName,
                (SELECT p.name FROM sale_items si JOIN products p ON p.id = si.product_id
                  WHERE si.sale_id = s.id ORDER BY si.id LIMIT 1) AS firstProduct,
                (SELECT count(*) FROM sale_items WHERE sale_id = s.id) AS lineCount
           FROM sales s
           LEFT JOIN customers c ON c.id = s.customer_id
          WHERE s.biz_date = ? AND s.voided_at IS NULL
          ORDER BY s.id DESC
          LIMIT 8`,
      )
      .all(day) as {
      id: number;
      created_at: string;
      total_amount_cents: number;
      settle_type: 'cash' | 'credit';
      customerName: string | null;
      firstProduct: string | null;
      lineCount: number;
    }[]
  ).map((r) => ({
    id: r.id,
    time: r.created_at.slice(11, 16),
    summary:
      r.lineCount > 1 ? `${r.firstProduct ?? '—'} 等 ${r.lineCount} 样` : (r.firstProduct ?? '—'),
    totalCents: r.total_amount_cents,
    settleType: r.settle_type,
    customerName: r.customerName,
  }));

  return {
    date: day,
    todayRevenueCents,
    todayProfitCents,
    monthProfitCents,
    inventoryValueCents,
    debtTotalCents: debts.owing.reduce((s, d) => s + d.netDebtCents, 0),
    debtCount: debts.owing.length,
    alerts,
    recentSales,
  };
}
