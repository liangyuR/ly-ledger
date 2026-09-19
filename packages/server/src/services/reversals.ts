/**
 * 作废 · 改单 · 退货。
 *
 * 界面上老板看到的是"修改"，系统内部执行的是**作废原单 + 建新单**。
 * 已提交单据的金额、数量、商品一律不允许原地 UPDATE —— 成本快照冻结、
 * 库存流水只追加、挂账单可能已被核销，直接改会让三张表同时失真，
 * 而且事后查不出原因（红线 6，docs/05）。
 */
import type { Database } from 'better-sqlite3';
import { z } from 'zod';

import { recordMovement } from './inventory';
import { rebuildAllocations } from './rebuild-allocations';
import { checkout, type CheckoutResult } from './sales';
import { receive, type ReceiveResult } from './purchases';

interface SaleRow {
  id: number;
  biz_date: string;
  customer_id: number | null;
  settle_type: 'cash' | 'credit';
  total_amount_cents: number;
  cost_amount_cents: number;
  rev: number;
  voided_at: string | null;
  return_of_sale_id: number | null;
}

interface SaleItemRow {
  product_id: number;
  unit: 'base' | 'pack';
  qty_milli: number;
  qty_base_milli: number;
  unit_price_cents: number;
  amount_cents: number;
  unit_cost_base_e4: number;
  cost_amount_cents: number;
}

function loadSale(db: Database, saleId: number): SaleRow {
  const row = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId) as SaleRow | undefined;
  if (!row) throw new Error(`单据不存在：${saleId}`);
  return row;
}

function loadItems(db: Database, saleId: number): SaleItemRow[] {
  return db.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(saleId) as SaleItemRow[];
}

// ─────────────────────────── 作废销售单 ───────────────────────────

export interface VoidResult {
  saleId: number;
  restoredQtyMilli: number;
}

/**
 * 作废一张销售单 —— 这笔生意**没发生过**（录错了）。
 *
 * 与退货的区别：退货是生意发生了后来退的，算在退货当天、不动当时的营业额。
 * 把退货当作废处理，会让上个月的营业额凭空缩水（docs/05）。
 */
export function voidSale(db: Database, saleId: number, reason: 'revised' | 'mistake' = 'mistake'): VoidResult {
  return db.transaction((): VoidResult => {
    const sale = loadSale(db, saleId);
    if (sale.voided_at) throw new Error(`这张单已经作废过了：${saleId}`);

    const items = loadItems(db, saleId);
    let restored = 0;

    for (const item of items) {
      // 用**原单的成本快照**把货加回去，不是当前均价
      recordMovement(db, {
        bizDate: sale.biz_date,
        productId: item.product_id,
        type: 'void',
        reverseOf: 'sale',
        qtyBaseMilli: item.qty_base_milli,
        unitCostE4: item.unit_cost_base_e4,
        refType: 'sale',
        refId: saleId,
      });
      restored += item.qty_base_milli;
    }

    db.prepare("UPDATE sales SET voided_at = datetime('now'), void_reason = ? WHERE id = ?").run(reason, saleId);

    // 作废挂账单会释放出已核销的款项，要让它流向下一张未结清的单
    if (sale.customer_id != null) {
      rebuildAllocations(db, sale.customer_id);
    }

    return { saleId, restoredQtyMilli: restored };
  })();
}

// ─────────────────────────── 改单 ───────────────────────────

export interface ReviseResult extends CheckoutResult {
  voidedSaleId: number;
  rev: number;
}

/**
 * 修改一张销售单 = 作废原单 + 建新单，两张单串成修订链。
 *
 * **未改动的行沿用原单成本快照**，只有换了商品或新增的行才取当前均价。
 * 否则老板只是改个数量，中间若进过货，这单毛利就会变 —— 他会认为软件在骗他。
 */
export function reviseSale(db: Database, saleId: number, newInput: unknown): ReviseResult {
  return db.transaction((): ReviseResult => {
    const original = loadSale(db, saleId);
    if (original.voided_at) throw new Error(`这张单已经作废过了，不能再改：${saleId}`);
    if (original.return_of_sale_id != null) throw new Error('退货单不能改，要撤就作废它');

    // 原单每个商品的成本快照，按商品归集
    const costOverrideE4 = new Map<number, number>();
    for (const item of loadItems(db, saleId)) {
      costOverrideE4.set(item.product_id, item.unit_cost_base_e4);
    }

    voidSale(db, saleId, 'revised');

    const created = checkout(db, newInput, {
      costOverrideE4,
      revisionOfSaleId: saleId,
      rev: original.rev + 1,
    });

    db.prepare('UPDATE sales SET superseded_by_sale_id = ? WHERE id = ?').run(created.saleId, saleId);

    return { ...created, voidedSaleId: saleId, rev: original.rev + 1 };
  })();
}

// ─────────────────────────── 退货 ───────────────────────────

export const ReturnInput = z.object({
  /** 退货发生的日期，**不是原单日期** */
  bizDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '业务日期格式应为 YYYY-MM-DD'),
  note: z.string().optional(),
  /** 不填 = 整单退 */
  items: z
    .array(
      z.object({
        productId: z.number().int().positive(),
        /** 退多少（按原单的录入单位） */
        qty: z.union([z.string(), z.number()]),
      }),
    )
    .optional(),
});

export interface ReturnResult {
  returnSaleId: number;
  originalSaleId: number;
  refundCents: number;
}

/**
 * 退货 —— 这笔生意发生了，后来退了。
 *
 * 原单保留、照常进它那天的营业额；退货冲减**退货当天**。
 * 入库成本取原单快照，不是当前均价 —— 否则中间进过一次货、均价变了，
 * 退一笔货就会凭空产生毛利或亏损。
 */
export function returnSale(db: Database, originalSaleId: number, raw: unknown): ReturnResult {
  const input = ReturnInput.parse(raw);

  return db.transaction((): ReturnResult => {
    const original = loadSale(db, originalSaleId);
    if (original.voided_at) throw new Error('原单已作废，无货可退 —— 作废意味着这笔生意没发生过');
    if (original.return_of_sale_id != null) throw new Error('退货单不能再退');

    const originalItems = loadItems(db, originalSaleId);

    // 已退过多少，防止退超
    const returned = new Map<number, number>();
    const priorReturns = db
      .prepare(
        `SELECT si.product_id, SUM(si.qty_base_milli) AS q
           FROM sales s JOIN sale_items si ON si.sale_id = s.id
          WHERE s.return_of_sale_id = ? AND s.voided_at IS NULL
          GROUP BY si.product_id`,
      )
      .all(originalSaleId) as { product_id: number; q: number }[];
    for (const r of priorReturns) returned.set(r.product_id, Math.abs(r.q));

    const lines = (input.items ?? originalItems.map((i) => ({ productId: i.product_id, qty: null }))).map(
      (want) => {
        const src = originalItems.find((i) => i.product_id === want.productId);
        if (!src) throw new Error(`原单里没有这个商品：${want.productId}`);

        const ratio =
          want.qty == null
            ? 1
            : Number(want.qty) / (src.qty_milli / 1000);
        if (!(ratio > 0)) throw new Error('退货数量必须为正');

        const qtyBaseMilli = Math.round(src.qty_base_milli * ratio);
        const already = returned.get(want.productId) ?? 0;
        if (already + qtyBaseMilli > src.qty_base_milli) {
          throw new Error(`退货数量超过原单：商品 ${want.productId}`);
        }

        return {
          productId: src.product_id,
          unit: src.unit,
          qtyMilli: -Math.round(src.qty_milli * ratio),
          qtyBaseMilli: -qtyBaseMilli,
          unitPriceCents: src.unit_price_cents,
          amountCents: -Math.round(src.amount_cents * ratio),
          unitCostE4: src.unit_cost_base_e4,
          costCents: -Math.round(src.cost_amount_cents * ratio),
        };
      },
    );

    const originalCents = lines.reduce((s, l) => s + l.amountCents, 0);
    const costCents = lines.reduce((s, l) => s + l.costCents, 0);

    const returnSaleId = Number(
      db
        .prepare(
          `INSERT INTO sales
             (biz_date, customer_id, settle_type, original_amount_cents, discount_amount_cents,
              total_amount_cents, cost_amount_cents, gross_profit_cents, return_of_sale_id, note)
           VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.bizDate,
          original.customer_id,
          original.settle_type,
          originalCents,
          originalCents,
          costCents,
          originalCents - costCents,
          originalSaleId,
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
        returnSaleId,
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
        type: 'return',
        qtyBaseMilli: -l.qtyBaseMilli, // 货回来了，正数入库
        unitCostE4: l.unitCostE4,
        refType: 'sale_return',
        refId: returnSaleId,
      });
    }

    if (original.customer_id != null) {
      rebuildAllocations(db, original.customer_id);
    }

    return { returnSaleId, originalSaleId, refundCents: -originalCents };
  })();
}

// ─────────────────────────── 进货单 ───────────────────────────

export interface VoidPurchaseResult {
  purchaseId: number;
  warnings: string[];
}

/**
 * 作废进货单。
 *
 * **只调整当前库存和均价，不回溯修改任何历史成本快照** —— 那会违反红线 3，
 * 让老板上个月已经看过的利润数字发生变化。代价是此后该商品的毛利会有偏差，
 * 直到下次进货把均价拉回合理区间（docs/05）。
 */
export function voidPurchase(
  db: Database,
  purchaseId: number,
  reason: 'revised' | 'mistake' = 'mistake',
): VoidPurchaseResult {
  return db.transaction((): VoidPurchaseResult => {
    const row = db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchaseId) as
      | { id: number; biz_date: string; voided_at: string | null }
      | undefined;
    if (!row) throw new Error(`进货单不存在：${purchaseId}`);
    if (row.voided_at) throw new Error(`这张进货单已经作废过了：${purchaseId}`);

    const items = db
      .prepare('SELECT product_id, qty_base_milli, unit_cost_base_e4 FROM purchase_items WHERE purchase_id = ?')
      .all(purchaseId) as { product_id: number; qty_base_milli: number; unit_cost_base_e4: number }[];

    const warnings: string[] = [];

    for (const item of items) {
      const after = recordMovement(db, {
        bizDate: row.biz_date,
        productId: item.product_id,
        type: 'void',
        reverseOf: 'purchase',
        qtyBaseMilli: item.qty_base_milli,
        unitCostE4: item.unit_cost_base_e4,
        refType: 'purchase',
        refId: purchaseId,
      });
      warnings.push(...after.warnings.map((w) => w.message));
    }

    db.prepare("UPDATE purchases SET voided_at = datetime('now'), void_reason = ? WHERE id = ?").run(
      reason,
      purchaseId,
    );

    return { purchaseId, warnings };
  })();
}

export interface RevisePurchaseResult extends ReceiveResult {
  voidedPurchaseId: number;
}

/** 修改进货单 = 作废 + 重录 */
export function revisePurchase(db: Database, purchaseId: number, newInput: unknown): RevisePurchaseResult {
  return db.transaction((): RevisePurchaseResult => {
    const voided = voidPurchase(db, purchaseId, 'revised');
    const created = receive(db, newInput);

    db.prepare(
      'UPDATE purchases SET revision_of_purchase_id = ?, rev = (SELECT rev + 1 FROM purchases WHERE id = ?) WHERE id = ?',
    ).run(purchaseId, purchaseId, created.purchaseId);
    db.prepare('UPDATE purchases SET superseded_by_purchase_id = ? WHERE id = ?').run(
      created.purchaseId,
      purchaseId,
    );

    return {
      ...created,
      warnings: [...voided.warnings, ...created.warnings],
      voidedPurchaseId: purchaseId,
    };
  })();
}

// ─────────────────────────── 收款 ───────────────────────────

/** 作废收款。三者里最简单：没有成本快照，也不动库存 */
export function voidPayment(db: Database, paymentId: number, reason: 'revised' | 'mistake' = 'mistake'): void {
  db.transaction(() => {
    const row = db.prepare('SELECT customer_id, voided_at FROM payments WHERE id = ?').get(paymentId) as
      | { customer_id: number; voided_at: string | null }
      | undefined;
    if (!row) throw new Error(`收款记录不存在：${paymentId}`);
    if (row.voided_at) throw new Error(`这笔收款已经作废过了：${paymentId}`);

    db.prepare("UPDATE payments SET voided_at = datetime('now'), void_reason = ? WHERE id = ?").run(
      reason,
      paymentId,
    );
    rebuildAllocations(db, row.customer_id);
  })();
}
