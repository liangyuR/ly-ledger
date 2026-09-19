import type { Database } from 'better-sqlite3';
import { z } from 'zod';

import { divRound, qtyToMilli, yuanToCents, yuanToE4 } from '../money';
import { lineCostCents, recordMovement } from './inventory';

const decimalish = z.union([z.string(), z.number()]);

export const ReceiveInput = z.object({
  bizDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '业务日期格式应为 YYYY-MM-DD'),
  supplierId: z.number().int().positive().nullable().optional(),
  paidYuan: decimalish.optional(),
  note: z.string().optional(),
  items: z
    .array(
      z.object({
        productId: z.number().int().positive(),
        unit: z.enum(['base', 'pack']),
        qty: decimalish,
        /** 按**录入单位**的进价。整条进价会在这里换算成每包 */
        unitCostYuan: decimalish,
      }),
    )
    .min(1, '至少要有一个商品'),
});

export type ReceiveInput = z.infer<typeof ReceiveInput>;

export interface ReceiveResult {
  purchaseId: number;
  totalCents: number;
  /** 每个商品入库后的新加权成本，给界面显示"成本变了" */
  newCosts: { productId: number; avgCostE4: number }[];
  warnings: string[];
}

/** 进货入库 —— 一个事务内建单、建明细、更新加权成本、写流水 */
export function receive(db: Database, raw: unknown): ReceiveResult {
  const input = ReceiveInput.parse(raw);

  return db.transaction((): ReceiveResult => {
    const lines = input.items.map((item) => {
      const product = db
        .prepare('SELECT id, pack_ratio FROM products WHERE id = ?')
        .get(item.productId) as { id: number; pack_ratio: number } | undefined;
      if (!product) throw new Error(`商品不存在：${item.productId}`);

      const qtyMilli = qtyToMilli(item.qty);
      if (qtyMilli <= 0) throw new Error('数量必须为正');

      const qtyBaseMilli = item.unit === 'pack' ? qtyMilli * product.pack_ratio : qtyMilli;
      const unitCostEnteredE4 = yuanToE4(item.unitCostYuan);

      // 整条 550 → 每包 55.0000；整箱 333 → 每瓶 55.5000。
      // 这一步就是四位小数存在的理由，两位会累积误差。
      const unitCostBaseE4 =
        item.unit === 'pack'
          ? divRound(BigInt(unitCostEnteredE4), BigInt(product.pack_ratio))
          : unitCostEnteredE4;

      return {
        productId: product.id,
        unit: item.unit,
        qtyMilli,
        qtyBaseMilli,
        unitCostBaseE4,
        amountCents: lineCostCents(qtyBaseMilli, unitCostBaseE4),
      };
    });

    const totalCents = lines.reduce((s, l) => s + l.amountCents, 0);

    const purchaseId = Number(
      db
        .prepare(
          `INSERT INTO purchases (biz_date, supplier_id, total_amount_cents, paid_amount_cents, note)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          input.bizDate,
          input.supplierId ?? null,
          totalCents,
          input.paidYuan == null ? 0 : yuanToCents(input.paidYuan),
          input.note ?? '',
        ).lastInsertRowid,
    );

    const insertItem = db.prepare(
      `INSERT INTO purchase_items
         (purchase_id, product_id, unit, qty_milli, qty_base_milli, unit_cost_base_e4, amount_cents)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    const newCosts: ReceiveResult['newCosts'] = [];
    const warnings: string[] = [];

    for (const l of lines) {
      insertItem.run(
        purchaseId,
        l.productId,
        l.unit,
        l.qtyMilli,
        l.qtyBaseMilli,
        l.unitCostBaseE4,
        l.amountCents,
      );

      const after = recordMovement(db, {
        bizDate: input.bizDate,
        productId: l.productId,
        type: 'purchase',
        qtyBaseMilli: l.qtyBaseMilli,
        unitCostE4: l.unitCostBaseE4,
        refType: 'purchase',
        refId: purchaseId,
      });

      newCosts.push({ productId: l.productId, avgCostE4: after.avgCostE4 });
      warnings.push(...after.warnings.map((w) => w.message));
    }

    return { purchaseId, totalCents, newCosts, warnings };
  })();
}
