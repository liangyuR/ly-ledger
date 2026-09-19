import type { Database } from 'better-sqlite3';
import { z } from 'zod';

import { qtyToMilli, yuanToCents } from '../money';
import { lineAmountCents, lineCostCents, readStock, recordMovement } from './inventory';
import { rebuildAllocations } from './rebuild-allocations';

const decimalish = z.union([z.string(), z.number()]);

export const CheckoutInput = z.object({
  bizDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '业务日期格式应为 YYYY-MM-DD'),
  settleType: z.enum(['cash', 'credit']),
  customerId: z.number().int().positive().nullable().optional(),
  /** 抹零，让掉的钱。不是折后总额 */
  discountYuan: decimalish.optional(),
  note: z.string().optional(),
  items: z
    .array(
      z.object({
        productId: z.number().int().positive(),
        unit: z.enum(['base', 'pack']),
        qty: decimalish,
        unitPriceYuan: decimalish,
      }),
    )
    .min(1, '至少要有一个商品'),
  /** F7 部分付：卖货时先收一部分 */
  partialPay: z
    .object({
      amountYuan: decimalish,
      method: z.enum(['cash', 'wechat', 'alipay', 'transfer']),
    })
    .optional(),
});

export type CheckoutInput = z.infer<typeof CheckoutInput>;

export interface CheckoutResult {
  saleId: number;
  totalCents: number;
  grossProfitCents: number;
  paymentId: number | null;
}

/**
 * 结账 —— 一个事务内完成全部副作用。
 *
 * 若前端拆成"建单 → 建明细 → 扣库存 → 写流水"四个请求，中间任何一步失败
 * 数据就脏了且无法自愈。所以必须在服务端事务里包住（docs/03）。
 */
export function checkout(db: Database, raw: unknown): CheckoutResult {
  const input = CheckoutInput.parse(raw);

  // 不变量 1：customer_id 非空 ⟺ settle_type = 'credit'
  // 库里有 CHECK 兜底，这里提前拦是为了给出人话错误
  const customerId = input.settleType === 'credit' ? (input.customerId ?? null) : null;
  if (input.settleType === 'credit' && customerId == null) {
    throw new Error('挂账必须指定客户');
  }
  if (input.settleType === 'cash' && input.customerId != null) {
    throw new Error('现金单不能挂客户 —— 要记客户就走挂账');
  }
  if (input.partialPay && input.settleType !== 'credit') {
    throw new Error('部分付属于挂账：剩余部分要记在客户账上');
  }

  const discountCents = input.discountYuan == null ? 0 : yuanToCents(input.discountYuan);
  if (discountCents < 0) {
    throw new Error('抹零不能是负数 —— 那是加价，不是抹零');
  }

  return db.transaction((): CheckoutResult => {
    const lines = input.items.map((item) => {
      const product = db
        .prepare('SELECT id, pack_ratio FROM products WHERE id = ?')
        .get(item.productId) as { id: number; pack_ratio: number } | undefined;
      if (!product) throw new Error(`商品不存在：${item.productId}`);

      const qtyMilli = qtyToMilli(item.qty);
      if (qtyMilli <= 0) throw new Error('数量必须为正');

      const qtyBaseMilli = item.unit === 'pack' ? qtyMilli * product.pack_ratio : qtyMilli;
      const unitPriceCents = yuanToCents(item.unitPriceYuan);

      // 成本快照：读**当前**加权成本并就地冻结。
      // 历史单据的成本是既成事实，不是计算结果（红线 3）
      const unitCostE4 = readStock(db, product.id).avgCostE4;

      return {
        productId: product.id,
        unit: item.unit,
        qtyMilli,
        qtyBaseMilli,
        unitPriceCents,
        amountCents: lineAmountCents(qtyMilli, unitPriceCents),
        unitCostE4,
        costCents: lineCostCents(qtyBaseMilli, unitCostE4),
      };
    });

    const originalCents = lines.reduce((s, l) => s + l.amountCents, 0);
    const totalCents = originalCents - discountCents;
    const costCents = lines.reduce((s, l) => s + l.costCents, 0);

    const saleId = Number(
      db
        .prepare(
          `INSERT INTO sales
             (biz_date, customer_id, settle_type, original_amount_cents, discount_amount_cents,
              total_amount_cents, cost_amount_cents, gross_profit_cents, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.bizDate,
          customerId,
          input.settleType,
          originalCents,
          discountCents,
          totalCents,
          costCents,
          totalCents - costCents,
          input.note ?? '',
        ).lastInsertRowid,
    );

    const insertItem = db.prepare(
      `INSERT INTO sale_items
         (sale_id, product_id, unit, qty_milli, qty_base_milli,
          unit_price_cents, amount_cents, unit_cost_base_e4, cost_amount_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const l of lines) {
      insertItem.run(
        saleId,
        l.productId,
        l.unit,
        l.qtyMilli,
        l.qtyBaseMilli,
        l.unitPriceCents,
        l.amountCents,
        l.unitCostE4,
        l.costCents,
      );

      recordMovement(db, {
        bizDate: input.bizDate,
        productId: l.productId,
        type: 'sale',
        qtyBaseMilli: l.qtyBaseMilli,
        unitCostE4: l.unitCostE4,
        refType: 'sale',
        refId: saleId,
      });
    }

    let paymentId: number | null = null;

    // 部分付不是第三种结算方式，它就是一张挂账单 + 一笔同日收款。
    // 这样欠款、账龄、核销、预收全部沿用既有逻辑，一行特殊代码都不用写（docs/05）
    if (input.partialPay && customerId != null) {
      paymentId = Number(
        db
          .prepare(
            `INSERT INTO payments (biz_date, customer_id, amount_cents, method, source)
             VALUES (?, ?, ?, ?, 'partial_pay')`,
          )
          .run(
            input.bizDate,
            customerId,
            yuanToCents(input.partialPay.amountYuan),
            input.partialPay.method,
          ).lastInsertRowid,
      );
    }

    if (customerId != null) {
      rebuildAllocations(db, customerId);
    }

    return { saleId, totalCents, grossProfitCents: totalCents - costCents, paymentId };
  })();
}
