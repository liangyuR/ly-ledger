/**
 * 售价回写 + 零成本毛利标注。
 *
 * 这两件事是启用向导的配套：向导承诺"卖到时当场填一个，软件会记住"，
 * 又允许跳过期初库存（跳过就会出现零成本毛利）。承诺和代价都得兑现。
 */
import assert from 'node:assert/strict';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, it } from 'node:test';

import { openDb } from '../db';
import { migrate } from '../db/migrate';
import { centsToYuan } from '../money';
import { costUnknownAlert, productRanking } from './profit-reports';
import { receive } from './purchases';
import { returnSale, reviseSale } from './reversals';
import { checkout } from './sales';

let db: Database;
let zhonghua: number;

function priceOf(id: number): { base: number | null; pack: number | null } {
  const r = db
    .prepare('SELECT price_base_cents AS b, price_pack_cents AS p FROM products WHERE id = ?')
    .get(id) as { b: number | null; p: number | null };
  return { base: r.b, pack: r.p };
}

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  zhonghua = Number(
    db
      .prepare(
        `INSERT INTO products (name, category, base_unit, pack_unit, pack_ratio)
         VALUES ('中华(硬)', 'cigarette', '包', '条', 10)`,
      )
      .run().lastInsertRowid,
  );
});

describe('售价回写', () => {
  it('卖一次就记住，下次不用再输', () => {
    assert.equal(priceOf(zhonghua).pack, null, '一开始没价');

    checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '1', unitPriceYuan: '550' }],
    });

    assert.equal(priceOf(zhonghua).pack, 55000);
  });

  it('整条价和单包价各记各的，互不覆盖', () => {
    checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [
        { productId: zhonghua, unit: 'pack', qty: '1', unitPriceYuan: '550' },
        { productId: zhonghua, unit: 'base', qty: '1', unitPriceYuan: '57' },
      ],
    });

    const p = priceOf(zhonghua);
    assert.equal(p.pack, 55000, '整条 550');
    assert.equal(p.base, 5700, '单包 57，不是 55');
  });

  it('改价了就跟着改', () => {
    const args = (yuan: string) => ({
      bizDate: '2026-09-19',
      settleType: 'cash' as const,
      items: [{ productId: zhonghua, unit: 'pack' as const, qty: '1', unitPriceYuan: yuan }],
    });
    checkout(db, args('550'));
    checkout(db, args('570'));
    assert.equal(priceOf(zhonghua).pack, 57000);
  });

  // 让利走抹零，不动单价 —— 否则一次让利会把默认价永久改低
  it('抹零不改商品售价', () => {
    checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      discountYuan: '50',
      items: [{ productId: zhonghua, unit: 'pack', qty: '1', unitPriceYuan: '550' }],
    });
    assert.equal(priceOf(zhonghua).pack, 55000, '记住的是 550，不是抹零后的 500');
  });

  it('改单把输错的价一起改回来', () => {
    const s = checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '1', unitPriceYuan: '55' }],
    });
    assert.equal(priceOf(zhonghua).pack, 5500, '先被错价污染了');

    reviseSale(db, s.saleId, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '1', unitPriceYuan: '550' }],
    });
    assert.equal(priceOf(zhonghua).pack, 55000, '改单是纠正错价的正路，价也得跟着正回来');
  });

  it('退货不动售价', () => {
    const s = checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '2', unitPriceYuan: '550' }],
    });
    returnSale(db, s.saleId, { bizDate: '2026-09-25' });
    assert.equal(priceOf(zhonghua).pack, 55000, '退货是退货，不是改价');
  });
});

describe('零成本毛利要标出来', () => {
  it('没进过货就卖，毛利等于全额售价', () => {
    checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'base', qty: '1', unitPriceYuan: '57' }],
    });

    const row = productRanking(db, '2026-09')[0];
    assert.equal(centsToYuan(row.profitCents), '57.00', '这就是那个虚高的数');
    assert.equal(row.costUnknown, true, '虚高就必须标出来');
  });

  it('进过货的不标', () => {
    receive(db, {
      bizDate: '2026-09-01',
      items: [{ productId: zhonghua, unit: 'pack', qty: '10', unitCostYuan: '520' }],
    });
    checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'base', qty: '1', unitPriceYuan: '57' }],
    });

    const row = productRanking(db, '2026-09')[0];
    assert.equal(row.costUnknown, false);
    assert.equal(centsToYuan(row.profitCents), '5.00');
  });

  it('汇总说清是哪几个商品、虚高了多少钱', () => {
    db.prepare(`INSERT INTO products (name, category, base_unit) VALUES ('利群', 'cigarette', '包')`).run();
    checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [
        { productId: zhonghua, unit: 'base', qty: '2', unitPriceYuan: '57' },
        { productId: 2, unit: 'base', qty: '1', unitPriceYuan: '23' },
      ],
    });

    const a = costUnknownAlert(db, '2026-09');
    assert.equal(a.productCount, 2);
    assert.equal(centsToYuan(a.revenueCents), '137.00');
    assert.deepEqual(a.names, ['中华(硬)', '利群'], '按金额从大到小，好让老板知道哪个影响最大');
  });

  // 下次进货就会校正 —— 这是向导里"跳过也能用"那句话的依据
  it('进过货之后，新卖的不再虚高', () => {
    checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'base', qty: '1', unitPriceYuan: '57' }],
    });
    receive(db, {
      bizDate: '2026-09-20',
      items: [{ productId: zhonghua, unit: 'pack', qty: '10', unitCostYuan: '520' }],
    });
    checkout(db, {
      bizDate: '2026-09-21',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'base', qty: '1', unitPriceYuan: '57' }],
    });

    const a = costUnknownAlert(db, '2026-09');
    assert.equal(centsToYuan(a.revenueCents), '57.00', '只有校正前那一笔还挂着');
  });

  it('干净的账不报警', () => {
    receive(db, {
      bizDate: '2026-09-01',
      items: [{ productId: zhonghua, unit: 'pack', qty: '10', unitCostYuan: '520' }],
    });
    checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'base', qty: '1', unitPriceYuan: '57' }],
    });
    assert.equal(costUnknownAlert(db, '2026-09').productCount, 0);
  });
});
