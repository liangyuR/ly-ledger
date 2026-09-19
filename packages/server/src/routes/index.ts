import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

import { getDb } from '../db';
import { centsToYuan, e4ToYuan, milliToQty, yuanToCents } from '../money';
import { collect } from '../services/payments';
import { receive } from '../services/purchases';
import { checkout } from '../services/sales';
import { toPinyin } from '../services/pinyin';
import { importProductList, parseProductList } from '../services/product-import';
import { rebuildAllocations, readDebt } from '../services/rebuild-allocations';
import {
  backupStatus,
  copyLatestToUsb,
  listBackups,
  removableDrives,
  runBackup,
} from '../services/backup';
import {
  exportDebts,
  exportProducts,
  exportRanking,
  exportSales,
  exportStale,
} from '../services/excel';
import {
  dailyTrend,
  inventorySummary,
  monthlyTrend,
  productRanking,
  staleProducts,
} from '../services/profit-reports';
import { dashboard, frequentProducts, listDebts, today } from '../services/reports';
import { importSeedBrands, listSeedBrands } from '../services/seed-import';
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
    const py = toPinyin(b.name);
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
        // 拼音自动生成，老板不用管。多音字可以事后手工改
        b.pinyinFull ?? py.full,
        b.pinyinAbbr ?? py.abbr,
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

  // ── 商品批量导入 ─────────────────────────────────────────
  // 把商品弄进来的三条路：预置目录勾选、手工清单、卖货时就地建。
  // 三条并行，缺一不可 —— 商品库不全不能阻塞记账（docs/01）

  app.get('/api/seed/brands', async () => {
    return { ok: true, brands: listSeedBrands(getDb()) };
  });

  app.post<{ Body: { brands?: string[] } }>('/api/seed/import', async (req) => {
    const brands = req.body?.brands ?? [];
    if (!Array.isArray(brands) || brands.length === 0) {
      throw new Error('至少勾一个牌子。全量导入会让搜索跳出一堆你根本不卖的牌子');
    }
    const r = importSeedBrands(getDb(), brands);
    return { ok: true, created: r.created, skipped: r.skipped };
  });

  /** 解析预览，不落库。看不懂的行标出来，允许就地改完再导 */
  app.post<{ Body: { text?: string } }>('/api/products/parse-import', async (req) => {
    const r = parseProductList(getDb(), req.body?.text ?? '');
    return { ok: true, ...r };
  });

  app.post<{ Body: { text?: string; category?: string } }>('/api/products/import', async (req) => {
    const r = importProductList(getDb(), req.body?.text ?? '', req.body?.category ?? 'other');
    return { ok: true, created: r.created, skipped: r.skipped, invalid: r.invalid };
  });

  /**
   * 改商品。商品页支持双击格子直接改 —— 批量填价格是启用期最高频的操作，
   * 不该逐个进详情页（docs/04）。
   */
  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      brand?: string;
      spec?: string;
      baseUnit?: string;
      packUnit?: string | null;
      packRatio?: number;
      priceBaseYuan?: string | null;
      pricePackYuan?: string | null;
      sortWeight?: number;
      isActive?: boolean;
    };
  }>('/api/products/:id', async (req) => {
    const db = getDb();
    const id = Number(req.params.id);
    const b = req.body ?? {};

    const current = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!current) throw new Error(`商品不存在：${id}`);

    const sets: string[] = [];
    const args: unknown[] = [];
    const put = (col: string, val: unknown) => {
      sets.push(`${col} = ?`);
      args.push(val);
    };

    if (b.name !== undefined) {
      const name = b.name.trim();
      if (!name) throw new Error('商品名不能为空');
      const dup = db.prepare('SELECT id FROM products WHERE name = ? AND id <> ?').get(name, id);
      if (dup) throw new Error(`已经有叫「${name}」的商品了`);
      const py = toPinyin(name);
      put('name', name);
      put('pinyin_full', py.full);
      put('pinyin_abbr', py.abbr);
    }
    if (b.brand !== undefined) put('brand', b.brand);
    if (b.spec !== undefined) put('spec', b.spec);
    if (b.baseUnit !== undefined) put('base_unit', b.baseUnit);
    if (b.packUnit !== undefined) put('pack_unit', b.packUnit);
    if (b.packRatio !== undefined) put('pack_ratio', b.packRatio);
    if (b.priceBaseYuan !== undefined) {
      put('price_base_cents', b.priceBaseYuan == null || b.priceBaseYuan === '' ? null : yuanToCents(b.priceBaseYuan));
    }
    if (b.pricePackYuan !== undefined) {
      put('price_pack_cents', b.pricePackYuan == null || b.pricePackYuan === '' ? null : yuanToCents(b.pricePackYuan));
    }
    if (b.sortWeight !== undefined) put('sort_weight', b.sortWeight);
    if (b.isActive !== undefined) put('is_active', b.isActive ? 1 : 0);

    if (sets.length === 0) return { ok: true, productId: id, changed: 0 };

    put('updated_at', new Date().toISOString().slice(0, 19).replace('T', ' '));
    args.push(id);
    db.prepare(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).run(...args);

    return { ok: true, productId: id, changed: sets.length };
  });

  /** 常用商品：近 30 天销量前 12，数字键直选用 */
  app.get('/api/products/frequent', async () => {
    return {
      ok: true,
      items: frequentProducts(getDb()).map((p) => ({
        ...p,
        priceBase: p.price_base_cents == null ? null : centsToYuan(p.price_base_cents),
        pricePack: p.price_pack_cents == null ? null : centsToYuan(p.price_pack_cents),
      })),
    };
  });

  // ── 客户与供应商 ─────────────────────────────────────────
  app.get<{ Querystring: { q?: string } }>('/api/customers', async (req) => {
    const db = getDb();
    const q = (req.query.q ?? '').trim();
    const items = q
      ? db
          .prepare(
            `SELECT * FROM customers
              WHERE is_active = 1 AND (name LIKE ? OR pinyin_full LIKE ? OR pinyin_abbr LIKE ?)
              ORDER BY id LIMIT 30`,
          )
          .all(`%${q}%`, `${q}%`, `${q}%`)
      : db.prepare('SELECT * FROM customers WHERE is_active = 1 ORDER BY id LIMIT 30').all();
    return { ok: true, items };
  });

  app.post<{ Body: { name?: string; phone?: string } }>('/api/customers', async (req, reply) => {
    const name = req.body?.name?.trim();
    if (!name) throw new Error('客户名不能为空');

    const db = getDb();
    const dup = db.prepare('SELECT id FROM customers WHERE name = ?').get(name);
    if (dup) {
      reply.status(409);
      return { ok: false, error: `客户「${name}」已存在`, customerId: (dup as { id: number }).id };
    }

    const py = toPinyin(name);
    const id = db
      .prepare('INSERT INTO customers (name, pinyin_full, pinyin_abbr, phone) VALUES (?, ?, ?, ?)')
      .run(name, py.full, py.abbr, req.body?.phone ?? '').lastInsertRowid;

    reply.status(201);
    return { ok: true, customerId: Number(id) };
  });

  app.get('/api/suppliers', async () => {
    return { ok: true, items: getDb().prepare('SELECT * FROM suppliers ORDER BY id').all() };
  });

  app.post<{ Body: { name?: string; phone?: string } }>('/api/suppliers', async (req, reply) => {
    const name = req.body?.name?.trim();
    if (!name) throw new Error('供应商名不能为空');
    const db = getDb();
    const dup = db.prepare('SELECT id FROM suppliers WHERE name = ?').get(name);
    if (dup) {
      reply.status(409);
      return { ok: false, error: `供应商「${name}」已存在`, supplierId: (dup as { id: number }).id };
    }
    const id = db
      .prepare('INSERT INTO suppliers (name, phone) VALUES (?, ?)')
      .run(name, req.body?.phone ?? '').lastInsertRowid;
    reply.status(201);
    return { ok: true, supplierId: Number(id) };
  });

  // ── 利润报表 ─────────────────────────────────────────────
  // 每个数字都是毛利：售价 − 成本，不含房租水电人工（红线 5）

  app.get<{ Querystring: { month?: string } }>('/api/reports/profit', async (req) => {
    const db = getDb();
    const month = req.query.month;
    const inv = inventorySummary(db);

    return {
      ok: true,
      month: month ?? today(db).slice(0, 7),
      monthly: monthlyTrend(db).map((m) => ({
        month: m.month,
        revenue: centsToYuan(m.revenueCents),
        profit: centsToYuan(m.profitCents),
        profitCents: m.profitCents,
        partial: m.partial,
      })),
      daily: dailyTrend(db).map((d) => ({
        date: d.date,
        revenue: centsToYuan(d.revenueCents),
        profit: centsToYuan(d.profitCents),
      })),
      ranking: productRanking(db, month).map((r) => ({
        productId: r.productId,
        name: r.name,
        qty: milliToQty(r.qtyBaseMilli),
        revenue: centsToYuan(r.revenueCents),
        profit: centsToYuan(r.profitCents),
        profitCents: r.profitCents,
        margin: r.marginPermille == null ? null : (r.marginPermille / 10).toFixed(1),
      })),
      stale: staleProducts(db).map((s) => ({
        productId: s.productId,
        name: s.name,
        qty: `${milliToQty(s.qtyBaseMilli)} ${s.baseUnit}`,
        value: centsToYuan(s.valueCents),
        lastSoldDate: s.lastSoldDate,
        idleDays: s.idleDays,
      })),
      inventory: {
        totalValue: centsToYuan(inv.totalValueCents),
        skuCount: inv.skuCount,
        negativeCount: inv.negativeCount,
      },
    };
  });

  // ── Excel 导出 ───────────────────────────────────────────
  // 一个按钮直接下 .xlsx，不弹导出配置（docs/04）

  function sendXlsx(reply: import('fastify').FastifyReply, out: { filename: string; buffer: Buffer }) {
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      // 文件名有中文，必须走 RFC 5987 的 filename*，否则浏览器会存成乱码
      .header(
        'Content-Disposition',
        `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(out.filename)}`,
      )
      .send(out.buffer);
  }

  app.get<{ Querystring: { month?: string } }>('/api/reports/export', async (req, reply) => {
    sendXlsx(reply, await exportSales(getDb(), req.query.month));
  });

  app.get<{ Querystring: { month?: string } }>('/api/reports/export-ranking', async (req, reply) => {
    sendXlsx(reply, await exportRanking(getDb(), req.query.month));
  });

  app.get('/api/reports/export-stale', async (_req, reply) => {
    sendXlsx(reply, await exportStale(getDb()));
  });

  app.get('/api/customers/export-debts', async (_req, reply) => {
    sendXlsx(reply, await exportDebts(getDb()));
  });

  app.get('/api/products/export', async (_req, reply) => {
    sendXlsx(reply, await exportProducts(getDb()));
  });

  // ── 备份 ────────────────────────────────────────────────
  // 备份状态常驻在顶栏，超过 3 天没成功备份就标红 ——
  // 静默失败的备份等于没有备份（docs/03）

  app.get('/api/backup/status', async () => {
    const s = backupStatus();
    return { ok: true, ...s, files: listBackups().slice(0, 10) };
  });

  app.post('/api/backup/now', async () => {
    const r = await runBackup();
    if (!r.ok) throw new Error(r.error ?? '备份失败');
    return { ok: true, file: r.file, sizeBytes: r.sizeBytes };
  });

  app.get('/api/backup/drives', async () => {
    return { ok: true, drives: removableDrives() };
  });

  app.post<{ Body: { drive?: string } }>('/api/backup/to-usb', async (req) => {
    const drive = req.body?.drive;
    if (!drive) throw new Error('先选一个盘符');
    const r = copyLatestToUsb(drive);
    if (!r.ok) throw new Error(r.error ?? '复制失败');
    return { ok: true, target: r.target };
  });

  // ── 看板与欠款列表 ────────────────────────────────────────
  app.get('/api/reports/dashboard', async () => {
    const d = dashboard(getDb());
    return {
      ok: true,
      date: d.date,
      todayRevenue: centsToYuan(d.todayRevenueCents),
      todayProfit: centsToYuan(d.todayProfitCents),
      monthProfit: centsToYuan(d.monthProfitCents),
      inventoryValue: centsToYuan(d.inventoryValueCents),
      debtTotal: centsToYuan(d.debtTotalCents),
      debtCount: d.debtCount,
      alerts: d.alerts,
      recentSales: d.recentSales.map((s) => ({
        ...s,
        total: centsToYuan(s.totalCents),
      })),
    };
  });

  app.get('/api/customers/debts', async () => {
    const d = listDebts(getDb());
    const fmt = (r: { customerId: number; name: string; netDebtCents: number; earliestUnpaidDate: string | null; agingDays: number | null }) => ({
      customerId: r.customerId,
      name: r.name,
      // 预收对外显示成正数，前端只管标签不同
      amount: centsToYuan(Math.abs(r.netDebtCents)),
      earliestUnpaidDate: r.earliestUnpaidDate,
      agingDays: r.agingDays,
    });
    return {
      ok: true,
      today: today(getDb()),
      owing: d.owing.map(fmt),
      prepaid: d.prepaid.map(fmt),
      totalOwing: centsToYuan(d.owing.reduce((s, r) => s + r.netDebtCents, 0)),
    };
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
