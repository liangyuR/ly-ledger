import assert from 'node:assert/strict';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, it } from 'node:test';

import { openDb } from '../db';
import { migrate } from '../db/migrate';
import { centsToYuan } from '../money';
import { exportDebts, exportProducts, exportSales, exportStale } from './excel';
import { inventorySummary, monthlyTrend, productRanking, staleProducts } from './profit-reports';
import { collect } from './payments';
import { receive } from './purchases';
import { checkout } from './sales';

let db: Database;
let zhonghua: number;
let liqun: number;
let laowang: number;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);

  zhonghua = Number(
    db
      .prepare(
        `INSERT INTO products (name, category, brand, base_unit, pack_unit, pack_ratio)
         VALUES ('中华(硬)', 'cigarette', '中华', '包', '条', 10)`,
      )
      .run().lastInsertRowid,
  );
  liqun = Number(
    db
      .prepare(
        `INSERT INTO products (name, category, brand, base_unit, pack_unit, pack_ratio)
         VALUES ('利群', 'cigarette', '利群', '包', '条', 10)`,
      )
      .run().lastInsertRowid,
  );
  laowang = Number(db.prepare(`INSERT INTO customers (name) VALUES ('老王')`).run().lastInsertRowid);

  receive(db, {
    bizDate: '2026-09-01',
    items: [
      { productId: zhonghua, unit: 'pack', qty: '10', unitCostYuan: '520' },
      { productId: liqun, unit: 'pack', qty: '10', unitCostYuan: '210' },
    ],
  });
});

describe('单品毛利排行', () => {
  it('按毛利额排，不是按销量', () => {
    // 中华卖 1 条赚 30，利群卖 5 条赚 100 —— 卖得多的不一定排前面，赚得多的才排前面
    checkout(db, {
      bizDate: '2026-09-10',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '1', unitPriceYuan: '550' }],
    });
    checkout(db, {
      bizDate: '2026-09-11',
      settleType: 'cash',
      items: [{ productId: liqun, unit: 'pack', qty: '5', unitPriceYuan: '230' }],
    });

    const r = productRanking(db, '2026-09');
    assert.equal(r[0].name, '利群', '利群毛利 100 > 中华 30');
    assert.equal(centsToYuan(r[0].profitCents), '100.00');
    assert.equal(centsToYuan(r[1].profitCents), '30.00');
  });

  it('毛利率按千分比算，成本为零不硬算', () => {
    checkout(db, {
      bizDate: '2026-09-10',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '1', unitPriceYuan: '550' }],
    });
    const r = productRanking(db, '2026-09');
    // 30 / 550 = 5.45%
    assert.equal(r[0].marginPermille, 55);
  });

  it('作废的单不进排行', () => {
    checkout(db, {
      bizDate: '2026-09-10',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '1', unitPriceYuan: '550' }],
    });
    db.prepare("UPDATE sales SET voided_at = datetime('now') WHERE id = (SELECT MAX(id) FROM sales)").run();
    assert.deepEqual(productRanking(db, '2026-09'), []);
  });
});

describe('月度趋势', () => {
  it('没有销售的月份也要出现', () => {
    const t = monthlyTrend(db, 6);
    assert.equal(t.length, 6, '跳月会让趋势图看起来少一截');
    assert.ok(t.every((m) => /^\d{4}-\d{2}$/.test(m.month)));
  });

  it('本月标成 partial —— 没走完不能跟完整月份比高低', () => {
    const t = monthlyTrend(db, 6);
    assert.equal(t[t.length - 1].partial, true);
    assert.ok(t.slice(0, -1).every((m) => !m.partial));
  });

  it('月份按时间升序', () => {
    const t = monthlyTrend(db, 6);
    const sorted = [...t].sort((a, b) => (a.month < b.month ? -1 : 1));
    assert.deepEqual(t.map((x) => x.month), sorted.map((x) => x.month));
  });
});

describe('滞销预警', () => {
  it('从没卖过的也算滞销，而且是最该注意的', () => {
    const s = staleProducts(db, 90);
    const names = s.map((x) => x.name);
    assert.ok(names.includes('中华(硬)'));
    assert.ok(names.includes('利群'));
    assert.ok(s.every((x) => x.lastSoldDate === null));
  });

  it('报的是压了多少钱，按金额倒序', () => {
    const s = staleProducts(db, 90);
    // 中华 100 包 × 52 = 5200，利群 100 包 × 21 = 2100
    assert.equal(s[0].name, '中华(硬)');
    assert.equal(centsToYuan(s[0].valueCents), '5200.00');
    assert.equal(centsToYuan(s[1].valueCents), '2100.00');
  });

  it('刚卖过的不算滞销', () => {
    checkout(db, {
      bizDate: new Date().toLocaleDateString('sv-SE'),
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '1', unitPriceYuan: '550' }],
    });
    const names = staleProducts(db, 90).map((x) => x.name);
    assert.ok(!names.includes('中华(硬)'));
  });
});

describe('库存汇总', () => {
  it('只算正库存 —— 负库存是漏记进货，不是负资产', () => {
    // 把利群卖成负库存
    checkout(db, {
      bizDate: '2026-09-10',
      settleType: 'cash',
      items: [{ productId: liqun, unit: 'pack', qty: '15', unitPriceYuan: '230' }],
    });

    const s = inventorySummary(db);
    assert.equal(centsToYuan(s.totalValueCents), '5200.00', '只剩中华那 5200');
    assert.equal(s.skuCount, 1);
    assert.equal(s.negativeCount, 1);
  });
});

describe('Excel 导出', () => {
  /** xlsx 本质是 zip，文件头必须是 PK */
  const isXlsx = (b: Buffer) => b.length > 1000 && b[0] === 0x50 && b[1] === 0x4b;

  beforeEach(() => {
    checkout(db, {
      bizDate: '2026-09-10',
      settleType: 'credit',
      customerId: laowang,
      discountYuan: '30',
      items: [{ productId: zhonghua, unit: 'pack', qty: '2', unitPriceYuan: '550' }],
    });
    collect(db, { bizDate: '2026-09-12', customerId: laowang, amountYuan: '500', method: 'cash' });
  });

  it('销售明细能导出', async () => {
    const out = await exportSales(db, '2026-09');
    assert.match(out.filename, /销售明细-2026-09\.xlsx$/);
    assert.ok(isXlsx(out.buffer), '产物必须是真的 xlsx');
  });

  it('欠款表能导出', async () => {
    const out = await exportDebts(db);
    assert.match(out.filename, /^欠款表-\d{4}-\d{2}-\d{2}\.xlsx$/);
    assert.ok(isXlsx(out.buffer));
  });

  it('商品表能导出 —— 它同时是导入模板', async () => {
    const out = await exportProducts(db);
    assert.ok(isXlsx(out.buffer));
  });

  it('滞销表能导出', async () => {
    const out = await exportStale(db);
    assert.ok(isXlsx(out.buffer));
  });

  it('空数据也能导出，不炸', async () => {
    const empty = openDb(':memory:');
    migrate(empty);
    const out = await exportSales(empty, '2026-01');
    assert.ok(out.buffer.length > 0, '没数据也该给一张只有表头的空表');
    empty.close();
  });
});
