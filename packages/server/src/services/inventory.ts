import type { Database } from 'better-sqlite3';

import { divRound } from '../money';
import { applyPurchase, applySale, reversePurchase, type CostResult, type Stock } from './cost';

export type MovementType = 'purchase' | 'sale' | 'return' | 'void' | 'adjust' | 'stocktake';

/** 结存快照。没有行就是零库存零成本 —— 不预建行，商品建出来时不一定有货 */
export function readStock(db: Database, productId: number): Stock {
  const row = db
    .prepare('SELECT qty_base_milli, avg_cost_base_e4 FROM inventory WHERE product_id = ?')
    .get(productId) as { qty_base_milli: number; avg_cost_base_e4: number } | undefined;

  return row
    ? { qtyMilli: row.qty_base_milli, avgCostE4: row.avg_cost_base_e4 }
    : { qtyMilli: 0, avgCostE4: 0 };
}

function writeStock(db: Database, productId: number, next: Stock): void {
  db.prepare(
    `INSERT INTO inventory (product_id, qty_base_milli, avg_cost_base_e4, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT (product_id) DO UPDATE SET
       qty_base_milli   = excluded.qty_base_milli,
       avg_cost_base_e4 = excluded.avg_cost_base_e4,
       updated_at       = excluded.updated_at`,
  ).run(productId, next.qtyMilli, next.avgCostE4);
}

export interface MovementInput {
  bizDate: string;
  productId: number;
  type: MovementType;
  /** 基础单位数量，正数。方向由 type 决定 */
  qtyBaseMilli: number;
  /** 本次变动的单位成本 */
  unitCostE4: number;
  refType: string;
  refId: number;
}

/**
 * 写一条库存流水并同步结存快照。
 *
 * 流水只追加、永不更新删除 —— 它是唯一真相来源，`inventory` 只是它的物化快照，
 * 任何时候都能从流水重算出来（docs/02）。
 */
export function recordMovement(db: Database, input: MovementInput): CostResult {
  const prev = readStock(db, input.productId);

  let next: CostResult;
  let signedQty: number;

  switch (input.type) {
    case 'purchase':
      next = applyPurchase(prev, input.qtyBaseMilli, input.unitCostE4);
      signedQty = input.qtyBaseMilli;
      break;

    case 'sale':
      // 库存允许变负，不拦（红线 1）
      next = applySale(prev, input.qtyBaseMilli);
      signedQty = -input.qtyBaseMilli;
      break;

    case 'return':
      // 退货入库的成本取**原单快照**，不是当前均价 ——
      // 否则中间进过一次货、均价变了，退一笔货就会凭空产生毛利（docs/05）
      next = applyPurchase(prev, input.qtyBaseMilli, input.unitCostE4);
      signedQty = input.qtyBaseMilli;
      break;

    case 'void':
      next = reversePurchase(prev, input.qtyBaseMilli, input.unitCostE4);
      signedQty = -input.qtyBaseMilli;
      break;

    default:
      throw new Error(`暂不支持的流水类型：${input.type}`);
  }

  writeStock(db, input.productId, next);

  db.prepare(
    `INSERT INTO stock_movements
       (biz_date, product_id, type, qty_base_milli, unit_cost_base_e4,
        ref_type, ref_id, balance_after_milli)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.bizDate,
    input.productId,
    input.type,
    signedQty,
    input.unitCostE4,
    input.refType,
    input.refId,
    next.qtyMilli,
  );

  return next;
}

/** 数量 × 单价 → 金额（分）。qty 是 milli，price 是分 */
export function lineAmountCents(qtyMilli: number, unitPriceCents: number): number {
  return divRound(BigInt(qtyMilli) * BigInt(unitPriceCents), 1000n);
}

/** 基础单位数量 × 单位成本 → 成本金额（分）。qty 是 milli，cost 是 e4 */
export function lineCostCents(qtyBaseMilli: number, unitCostE4: number): number {
  return divRound(BigInt(qtyBaseMilli) * BigInt(unitCostE4), 100_000n);
}

/**
 * 从库存流水全量重算某商品的结存。
 *
 * 用途是对账：结存快照若与流水重算结果不一致，说明有人绕过 recordMovement
 * 直接改了 inventory —— 那是账对不上又查不出原因的开始。
 */
export function recomputeQtyFromMovements(db: Database, productId: number): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(qty_base_milli), 0) AS total FROM stock_movements WHERE product_id = ?')
    .get(productId) as { total: number };
  return row.total;
}
