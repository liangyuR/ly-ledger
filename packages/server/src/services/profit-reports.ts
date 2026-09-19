/**
 * 利润报表。
 *
 * 所有口径一律 `voided_at IS NULL`、一律按 `biz_date` 统计。
 * 每个数字都是**毛利**：售价 − 成本，不含房租水电人工 —— 界面上必须写明，
 * 否则老板会拿它当净利，然后认为软件算错了（红线 5）。
 */
import type { Database } from 'better-sqlite3';

import { divRound } from '../money';
import { today } from './reports';

export interface MonthPoint {
  month: string;
  revenueCents: number;
  profitCents: number;
  /** 本月是否还没走完 —— 图上画成空心柱，不能跟完整月份比高低 */
  partial: boolean;
}

/** 近 N 个月的毛利趋势 */
export function monthlyTrend(db: Database, months = 6): MonthPoint[] {
  const day = today(db);
  const thisMonth = day.slice(0, 7);

  const rows = db
    .prepare(
      `SELECT substr(biz_date, 1, 7) AS month,
              SUM(total_amount_cents) AS revenueCents,
              SUM(gross_profit_cents) AS profitCents
         FROM sales
        WHERE voided_at IS NULL
          AND biz_date >= date(?, 'start of month', ?)
        GROUP BY month
        ORDER BY month`,
    )
    .all(day, `-${months - 1} month`) as { month: string; revenueCents: number; profitCents: number }[];

  const byMonth = new Map(rows.map((r) => [r.month, r]));

  // 没有销售的月份也要出现，否则趋势图会出现"跳月"，看起来像少了一截
  const out: MonthPoint[] = [];
  const [y, m] = thisMonth.split('-').map(Number);
  for (let i = months - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const hit = byMonth.get(key);
    out.push({
      month: key,
      revenueCents: hit?.revenueCents ?? 0,
      profitCents: hit?.profitCents ?? 0,
      partial: key === thisMonth,
    });
  }
  return out;
}

export interface DayPoint {
  date: string;
  revenueCents: number;
  profitCents: number;
}

export function dailyTrend(db: Database, days = 30): DayPoint[] {
  const day = today(db);
  return db
    .prepare(
      `SELECT biz_date AS date,
              SUM(total_amount_cents) AS revenueCents,
              SUM(gross_profit_cents) AS profitCents
         FROM sales
        WHERE voided_at IS NULL AND biz_date >= date(?, ?)
        GROUP BY biz_date
        ORDER BY biz_date`,
    )
    .all(day, `-${days} day`) as DayPoint[];
}

export interface ProductProfit {
  productId: number;
  name: string;
  qtyBaseMilli: number;
  revenueCents: number;
  profitCents: number;
  /** 毛利率，千分比。成本为零时为 null，不硬算 */
  marginPermille: number | null;
  /**
   * 这个商品本月有成本为 0 的销售行 —— 卖的是没进过货的存货，
   * 软件不知道进价，毛利等于全额售价，数字是虚高的。
   * 界面必须标出来：不标的话老板会拿着假毛利做进货决策（docs/01 红线 5 的推论）。
   */
  costUnknown: boolean;
}

/** 单品毛利排行。按毛利额排 —— 卖得多不等于赚得多 */
export function productRanking(db: Database, month?: string, limit = 20): ProductProfit[] {
  const m = month ?? today(db).slice(0, 7);
  const rows = db
    .prepare(
      `SELECT si.product_id AS productId, p.name,
              SUM(si.qty_base_milli) AS qtyBaseMilli,
              SUM(si.amount_cents) AS revenueCents,
              SUM(si.amount_cents - si.cost_amount_cents) AS profitCents,
              MAX(CASE WHEN si.unit_cost_base_e4 = 0 THEN 1 ELSE 0 END) AS costUnknownFlag
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         JOIN products p ON p.id = si.product_id
        WHERE s.voided_at IS NULL AND substr(s.biz_date, 1, 7) = ?
        GROUP BY si.product_id
        ORDER BY profitCents DESC
        LIMIT ?`,
    )
    .all(m, limit) as (Omit<ProductProfit, 'marginPermille' | 'costUnknown'> & {
    costUnknownFlag: number;
  })[];

  return rows.map(({ costUnknownFlag, ...r }) => ({
    ...r,
    marginPermille:
      r.revenueCents === 0 ? null : divRound(BigInt(r.profitCents) * 1000n, BigInt(r.revenueCents)),
    costUnknown: costUnknownFlag === 1,
  }));
}

export interface CostUnknownAlert {
  /** 有多少个商品卖的是不知道进价的货 */
  productCount: number;
  /** 这些行的销售额 —— 毛利虚高的正是这个数 */
  revenueCents: number;
  /** 前几个名字，界面上直接点名 */
  names: string[];
}

/**
 * 本月有多少毛利是假的。
 *
 * 从没进过货的商品，成本快照是 0，卖 550 就记赚 550。这不是 bug ——
 * 加权平均成本在没有进货记录时本来就是 0，且下次进货就会自动校正。
 * 但**报表上必须说出来**，否则老板会拿着虚高的毛利做决策。
 *
 * 启用向导跳过"期初库存"那一步，就会进入这个状态，所以这是向导的配套。
 */
export function costUnknownAlert(db: Database, month?: string): CostUnknownAlert {
  const m = month ?? today(db).slice(0, 7);
  const rows = db
    .prepare(
      `SELECT p.name, SUM(si.amount_cents) AS revenueCents
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         JOIN products p ON p.id = si.product_id
        WHERE s.voided_at IS NULL
          AND substr(s.biz_date, 1, 7) = ?
          AND si.unit_cost_base_e4 = 0
          AND si.amount_cents > 0
        GROUP BY si.product_id
        ORDER BY revenueCents DESC`,
    )
    .all(m) as { name: string; revenueCents: number }[];

  return {
    productCount: rows.length,
    revenueCents: rows.reduce((s2, r) => s2 + r.revenueCents, 0),
    names: rows.slice(0, 5).map((r) => r.name),
  };
}

export interface StaleProduct {
  productId: number;
  name: string;
  qtyBaseMilli: number;
  baseUnit: string;
  valueCents: number;
  lastSoldDate: string | null;
  idleDays: number | null;
}

/**
 * 滞销预警：有库存、且超过 N 天没卖动的商品。
 * 报的是**压了多少钱**，不只是"多少个商品" —— 后者老板没法据此决策。
 */
export function staleProducts(db: Database, days = 90): StaleProduct[] {
  const day = today(db);
  const rows = db
    .prepare(
      `SELECT i.product_id AS productId, p.name, i.qty_base_milli AS qtyBaseMilli,
              p.base_unit AS baseUnit, i.avg_cost_base_e4 AS costE4,
              (SELECT MAX(s.biz_date) FROM sale_items si JOIN sales s ON s.id = si.sale_id
                WHERE si.product_id = i.product_id AND s.voided_at IS NULL) AS lastSoldDate
         FROM inventory i
         JOIN products p ON p.id = i.product_id
        WHERE i.qty_base_milli > 0`,
    )
    .all() as {
    productId: number;
    name: string;
    qtyBaseMilli: number;
    baseUnit: string;
    costE4: number;
    lastSoldDate: string | null;
  }[];

  return rows
    .map((r) => {
      const idleDays = r.lastSoldDate
        ? Math.floor(
            (Date.parse(`${day}T00:00:00Z`) - Date.parse(`${r.lastSoldDate}T00:00:00Z`)) / 86_400_000,
          )
        : null;
      return {
        productId: r.productId,
        name: r.name,
        qtyBaseMilli: r.qtyBaseMilli,
        baseUnit: r.baseUnit,
        valueCents: divRound(BigInt(r.qtyBaseMilli) * BigInt(r.costE4), 100_000n),
        lastSoldDate: r.lastSoldDate,
        idleDays,
      };
    })
    // 从没卖过的也算滞销 —— 而且是最该注意的那种
    .filter((r) => r.idleDays == null || r.idleDays >= days)
    .sort((a, b) => b.valueCents - a.valueCents);
}

export interface InventorySummary {
  totalValueCents: number;
  skuCount: number;
  negativeCount: number;
}

export function inventorySummary(db: Database): InventorySummary {
  const rows = db
    .prepare('SELECT qty_base_milli AS q, avg_cost_base_e4 AS c FROM inventory')
    .all() as { q: number; c: number }[];

  return {
    // 只算正库存：负库存是"可能漏记进货"，把它的负值算进资产没有意义
    totalValueCents: rows
      .filter((r) => r.q > 0)
      .reduce((s, r) => s + divRound(BigInt(r.q) * BigInt(r.c), 100_000n), 0),
    skuCount: rows.filter((r) => r.q > 0).length,
    negativeCount: rows.filter((r) => r.q < 0).length,
  };
}
