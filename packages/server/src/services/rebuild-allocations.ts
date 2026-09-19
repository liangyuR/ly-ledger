import type { Database } from 'better-sqlite3';

import {
  computeAllocations,
  type PaymentForAlloc,
  type SaleForAlloc,
  type AllocResult,
} from './allocations';

/**
 * 重算某个客户的全部核销。
 *
 * **作用域是单个客户，不是全库。** 单店数据量下这是毫秒级操作，
 * 不需要增量优化 —— 而增量追加会在补录、改期、作废之后算错账龄（docs/05）。
 *
 * 触发时机：新增挂账单、作废/修改挂账单、改 biz_date、退货、
 * 新增/作废/修改收款，以及手工触发（逃生舱）。
 */
export function rebuildAllocations(db: Database, customerId: number): AllocResult {
  const sales = (
    db
      .prepare(
        `SELECT id, biz_date, total_amount_cents, return_of_sale_id
           FROM sales
          WHERE customer_id = ? AND settle_type = 'credit' AND voided_at IS NULL
          ORDER BY biz_date, id`,
      )
      .all(customerId) as {
      id: number;
      biz_date: string;
      total_amount_cents: number;
      return_of_sale_id: number | null;
    }[]
  ).map<SaleForAlloc>((r) => ({
    id: r.id,
    bizDate: r.biz_date,
    totalCents: r.total_amount_cents,
    returnOfSaleId: r.return_of_sale_id,
  }));

  const payments = (
    db
      .prepare(
        `SELECT id, biz_date, amount_cents
           FROM payments
          WHERE customer_id = ? AND voided_at IS NULL
          ORDER BY biz_date, id`,
      )
      .all(customerId) as { id: number; biz_date: string; amount_cents: number }[]
  ).map<PaymentForAlloc>((r) => ({
    id: r.id,
    bizDate: r.biz_date,
    amountCents: r.amount_cents,
  }));

  const result = computeAllocations(sales, payments);

  // 先全删再重写。核销是派生数据，不是流水 —— 删了能原样算回来。
  db.prepare(
    `DELETE FROM payment_allocations
      WHERE payment_id IN (SELECT id FROM payments WHERE customer_id = ?)`,
  ).run(customerId);

  const insert = db.prepare(
    'INSERT INTO payment_allocations (payment_id, sale_id, amount_cents) VALUES (?, ?, ?)',
  );
  for (const a of result.allocations) {
    insert.run(a.paymentId, a.saleId, a.amountCents);
  }

  return result;
}

export interface CustomerDebt {
  customerId: number;
  name: string;
  /** 正数 = 欠款，负数 = 预收 */
  netDebtCents: number;
  /** 最早一张未结清单的业务日期 */
  earliestUnpaidDate: string | null;
}

/**
 * 客户净欠款 = 未作废挂账单合计 − 未作废收款合计。
 * 结果为负即预收 —— 不需要额外的表或字段，它是"核销可重算"的免费副产品。
 */
export function readDebt(db: Database, customerId: number): CustomerDebt {
  const row = db
    .prepare(
      `SELECT c.id, c.name,
              COALESCE((SELECT SUM(total_amount_cents) FROM sales
                         WHERE customer_id = c.id AND settle_type = 'credit' AND voided_at IS NULL), 0)
            - COALESCE((SELECT SUM(amount_cents) FROM payments
                         WHERE customer_id = c.id AND voided_at IS NULL), 0) AS net
         FROM customers c WHERE c.id = ?`,
    )
    .get(customerId) as { id: number; name: string; net: number } | undefined;

  if (!row) throw new Error(`客户不存在：${customerId}`);

  const earliest = db
    .prepare(
      `SELECT s.biz_date AS d
         FROM sales s
        WHERE s.customer_id = ? AND s.settle_type = 'credit' AND s.voided_at IS NULL
          AND s.return_of_sale_id IS NULL
          AND s.total_amount_cents > COALESCE(
                (SELECT SUM(amount_cents) FROM payment_allocations WHERE sale_id = s.id), 0)
              + COALESCE(
                (SELECT -SUM(total_amount_cents) FROM sales r WHERE r.return_of_sale_id = s.id
                   AND r.voided_at IS NULL), 0)
        ORDER BY s.biz_date, s.id
        LIMIT 1`,
    )
    .get(customerId) as { d: string } | undefined;

  return {
    customerId: row.id,
    name: row.name,
    netDebtCents: row.net,
    earliestUnpaidDate: earliest?.d ?? null,
  };
}
