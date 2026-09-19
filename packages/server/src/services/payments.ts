import type { Database } from 'better-sqlite3';
import { z } from 'zod';

import { yuanToCents } from '../money';
import { rebuildAllocations, readDebt, type CustomerDebt } from './rebuild-allocations';

const decimalish = z.union([z.string(), z.number()]);

export const CollectInput = z.object({
  bizDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '业务日期格式应为 YYYY-MM-DD'),
  customerId: z.number().int().positive(),
  amountYuan: decimalish,
  method: z.enum(['cash', 'wechat', 'alipay', 'transfer']),
  note: z.string().optional(),
});

export type CollectInput = z.infer<typeof CollectInput>;

export interface CollectResult {
  paymentId: number;
  /** 分配不完的余额 = 预收 */
  prepaidCents: number;
  debt: CustomerDebt;
}

/**
 * 收款。
 *
 * 老板的心智是"老王还了 500"，不关心具体是哪几笔 —— 所以收款记在**客户**身上，
 * 系统自动 FIFO 核销，不让他选核销哪张单。
 *
 * **收多了照收。** 分配不完的余额自动成为预收，下次挂账买货时重算会把它核销掉。
 * 不需要新表也不需要新字段 —— 它是"核销可重算"的免费副产品（docs/05）。
 */
export function collect(db: Database, raw: unknown): CollectResult {
  const input = CollectInput.parse(raw);
  const amountCents = yuanToCents(input.amountYuan);

  if (amountCents <= 0) {
    throw new Error('收款金额必须为正。录错了要撤销，走作废，不是记一笔负数');
  }

  return db.transaction((): CollectResult => {
    const exists = db.prepare('SELECT 1 FROM customers WHERE id = ?').get(input.customerId);
    if (!exists) throw new Error(`客户不存在：${input.customerId}`);

    const paymentId = Number(
      db
        .prepare(
          `INSERT INTO payments (biz_date, customer_id, amount_cents, method, source, note)
           VALUES (?, ?, ?, ?, 'collect', ?)`,
        )
        .run(input.bizDate, input.customerId, amountCents, input.method, input.note ?? '')
        .lastInsertRowid,
    );

    // 全量重算，不是增量追加 —— 补录和改期都会改变 FIFO 顺序
    const result = rebuildAllocations(db, input.customerId);

    return {
      paymentId,
      prepaidCents: result.prepaidCents,
      debt: readDebt(db, input.customerId),
    };
  })();
}
