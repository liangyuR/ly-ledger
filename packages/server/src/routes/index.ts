import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import { getDb } from '../db';
import { centsToYuan, e4ToYuan, milliToQty, yuanToCents } from '../money';
import { collect } from '../services/payments';
import { receive } from '../services/purchases';
import { checkout } from '../services/sales';
import { rebuildAllocations, readDebt } from '../services/rebuild-allocations';
import {
  returnSale,
  reviseSale,
  revisePurchase,
  voidPayment,
  voidPurchase,
  voidSale,
} from '../services/reversals';

/** Zod 的报错对人不友好，转成一句话 */
function toMessage(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues.map((i) => `${i.path.join('.') || '入参'}：${i.message}`).join('；');
  }
  return err instanceof Error ? err.message : String(err);
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((err, _req, reply) => {
    const status = err instanceof ZodError ? 400 : ((err as { statusCode?: number }).statusCode ?? 400);
    app.log.warn({ err }, '请求失败');
    reply.status(status).send({ ok: false, error: toMessage(err) });
  });

  // ── 商品 ────────────────────────────────────────────────
  app.get<{ Querystring: { q?: string } }>('/api/products', async (req) => {
    const db = getDb();
    const q = (req.query.q ?? '').trim();

    // 三路匹配：名称包含、全拼前缀、首字母前缀。
    // 两个拼音字段都要 —— 只做首字母会逼老板记缩写，只做全拼则打字太多
    const rows = q
      ? db
          .prepare(
            `SELECT * FROM products
              WHERE is_active = 1
                AND (name LIKE ? OR pinyin_full LIKE ? OR pinyin_abbr LIKE ?)
              ORDER BY sort_weight DESC, id
              LIMIT 50`,
          )
          .all(`%${q}%`, `${q}%`, `${q}%`)
      : db
          .prepare('SELECT * FROM products WHERE is_active = 1 ORDER BY sort_weight DESC, id LIMIT 50')
          .all();

    return { ok: true, items: rows };
  });

  app.post<{
    Body: {
      name: string;
      category?: 'cigarette' | 'liquor' | 'other';
      brand?: string;
      spec?: string;
      baseUnit: string;
      packUnit?: string | null;
      packRatio?: number;
      pinyinFull?: string;
      pinyinAbbr?: string;
      priceBaseYuan?: string;
      pricePackYuan?: string;
    };
  }>('/api/products', async (req, reply) => {
    const b = req.body;
    if (!b?.name?.trim()) throw new Error('商品名不能为空');
    if (!b?.baseUnit?.trim()) throw new Error('基础单位不能为空');

    const db = getDb();
    // 同名即同商品 —— 整条卖和单包卖是一个商品的两种卖法，不是两条记录。
    // 建成两条会让库存裂成两份，且错得极隐蔽（docs/02）
    const dup = db.prepare('SELECT id FROM products WHERE name = ?').get(b.name.trim());
    if (dup) {
      reply.status(409);
      return { ok: false, error: `商品「${b.name.trim()}」已存在`, productId: (dup as { id: number }).id };
    }

    const id = db
      .prepare(
        `INSERT INTO products (name, pinyin_full, pinyin_abbr, category, brand, spec,
                               base_unit, pack_unit, pack_ratio, price_base_cents, price_pack_cents)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        b.name.trim(),
        b.pinyinFull ?? '',
        b.pinyinAbbr ?? '',
        b.category ?? 'other',
        b.brand ?? '',
        b.spec ?? '',
        b.baseUnit.trim(),
        b.packUnit ?? null,
        b.packRatio ?? 1,
        b.priceBaseYuan == null ? null : yuanToCents(b.priceBaseYuan),
        b.pricePackYuan == null ? null : yuanToCents(b.pricePackYuan),
      ).lastInsertRowid;

    reply.status(201);
    return { ok: true, productId: Number(id) };
  });

  // ── 三个正向事务 action ──────────────────────────────────
  app.post('/api/sales/checkout', async (req) => {
    const r = checkout(getDb(), req.body);
    return {
      ok: true,
      saleId: r.saleId,
      total: centsToYuan(r.totalCents),
      grossProfit: centsToYuan(r.grossProfitCents),
      paymentId: r.paymentId,
    };
  });

  app.post('/api/purchases/receive', async (req) => {
    const r = receive(getDb(), req.body);
    return {
      ok: true,
      purchaseId: r.purchaseId,
      total: centsToYuan(r.totalCents),
      // 录完立刻告诉老板成本变了 —— 这是进货页要显示的东西
      newCosts: r.newCosts.map((c) => ({ productId: c.productId, avgCost: e4ToYuan(c.avgCostE4) })),
      warnings: r.warnings,
    };
  });

  app.post('/api/payments/collect', async (req) => {
    const r = collect(getDb(), req.body);
    return {
      ok: true,
      paymentId: r.paymentId,
      prepaid: centsToYuan(r.prepaidCents),
      netDebt: centsToYuan(r.debt.netDebtCents),
      earliestUnpaidDate: r.debt.earliestUnpaidDate,
    };
  });

  // ── 逆向：作废 / 改单 / 退货 ──────────────────────────────
  // 界面上老板看到的是"修改"和"退货"，不出现"作废""红冲"这类会计词汇

  app.post<{ Params: { id: string } }>('/api/sales/:id/void', async (req) => {
    const r = voidSale(getDb(), Number(req.params.id));
    return { ok: true, saleId: r.saleId, restoredQty: milliToQty(r.restoredQtyMilli) };
  });

  app.post<{ Params: { id: string } }>('/api/sales/:id/revise', async (req) => {
    const r = reviseSale(getDb(), Number(req.params.id), req.body);
    return {
      ok: true,
      saleId: r.saleId,
      rev: r.rev,
      replacedSaleId: r.voidedSaleId,
      total: centsToYuan(r.totalCents),
      grossProfit: centsToYuan(r.grossProfitCents),
    };
  });

  app.post<{ Params: { id: string } }>('/api/sales/:id/return', async (req) => {
    const r = returnSale(getDb(), Number(req.params.id), req.body);
    return {
      ok: true,
      returnSaleId: r.returnSaleId,
      originalSaleId: r.originalSaleId,
      refund: centsToYuan(r.refundCents),
    };
  });

  app.post<{ Params: { id: string } }>('/api/purchases/:id/void', async (req) => {
    const r = voidPurchase(getDb(), Number(req.params.id));
    return { ok: true, purchaseId: r.purchaseId, warnings: r.warnings };
  });

  app.post<{ Params: { id: string } }>('/api/purchases/:id/revise', async (req) => {
    const r = revisePurchase(getDb(), Number(req.params.id), req.body);
    return {
      ok: true,
      purchaseId: r.purchaseId,
      replacedPurchaseId: r.voidedPurchaseId,
      total: centsToYuan(r.totalCents),
      warnings: r.warnings,
    };
  });

  app.post<{ Params: { id: string } }>('/api/payments/:id/void', async (req) => {
    voidPayment(getDb(), Number(req.params.id));
    return { ok: true };
  });

  /**
   * 逃生舱：核销是派生数据，万一失准，重算一次即自愈，不需要人工改数据。
   * 这是把 allocations 做成派生表的额外收益。
   */
  app.post<{ Params: { id: string } }>('/api/customers/:id/rebuild-allocations', async (req) => {
    const r = rebuildAllocations(getDb(), Number(req.params.id));
    return { ok: true, allocations: r.allocations.length, prepaid: centsToYuan(r.prepaidCents) };
  });

  // ── 欠款 ────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/api/customers/:id/debt', async (req) => {
    const d = readDebt(getDb(), Number(req.params.id));
    return {
      ok: true,
      customerId: d.customerId,
      name: d.name,
      netDebt: centsToYuan(d.netDebtCents),
      isPrepaid: d.netDebtCents < 0,
      earliestUnpaidDate: d.earliestUnpaidDate,
    };
  });

  // ── 库存 ────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/api/products/:id/stock', async (req) => {
    const db = getDb();
    const row = db
      .prepare('SELECT qty_base_milli, avg_cost_base_e4 FROM inventory WHERE product_id = ?')
      .get(Number(req.params.id)) as { qty_base_milli: number; avg_cost_base_e4: number } | undefined;

    return {
      ok: true,
      qty: milliToQty(row?.qty_base_milli ?? 0),
      avgCost: e4ToYuan(row?.avg_cost_base_e4 ?? 0),
      // 负库存只提醒，不拦路（红线 1）
      negative: (row?.qty_base_milli ?? 0) < 0,
    };
  });
}
