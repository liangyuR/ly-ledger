import assert from 'node:assert/strict';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, it } from 'node:test';

import { openDb } from '../db';
import { migrate } from '../db/migrate';
import { centsToYuan } from '../money';
import { receive } from './purchases';
import { returnSale, reviseSale, voidSale } from './reversals';
import { listSales, saleDetail } from './sale-detail';
import { checkout } from './sales';

let db: Database;
let zhonghua: number;
let laowang: number;

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
  laowang = Number(db.prepare(`INSERT INTO customers (name) VALUES ('老王')`).run().lastInsertRowid);
  receive(db, {
    bizDate: '2026-09-01',
    items: [{ productId: zhonghua, unit: 'pack', qty: '20', unitCostYuan: '520' }],
  });
});

function sell(qty = '2', opts: Record<string, unknown> = {}) {
  return checkout(db, {
    bizDate: '2026-09-19',
    settleType: 'cash',
    items: [{ productId: zhonghua, unit: 'pack', qty, unitPriceYuan: '550' }],
    ...opts,
  });
}

describe('单据详情', () => {
  it('带成本快照和毛利', () => {
    const s = sell();
    const d = saleDetail(db, s.saleId);

    assert.equal(centsToYuan(d.totalCents), '1100.00');
    assert.equal(centsToYuan(d.profitCents), '60.00');
    assert.equal(d.items.length, 1);
    assert.equal(d.items[0].unitCostE4, 520000, '成交那一刻冻结的成本');
    assert.equal(centsToYuan(d.items[0].profitCents), '60.00');
  });

  it('新单可以改也可以退', () => {
    const d = saleDetail(db, sell().saleId);
    assert.equal(d.canRevise, true);
    assert.equal(d.canReturn, true);
    assert.equal(d.blockedReason, null);
  });

  it('不存在的单据给人话错误', () => {
    assert.throws(() => saleDetail(db, 99999), /单据不存在/);
  });
});

describe('修订链', () => {
  it('从新版本能看到完整经过', () => {
    const s = sell('2');
    const r = reviseSale(db, s.saleId, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '3', unitPriceYuan: '550' }],
    });

    const d = saleDetail(db, r.saleId);
    assert.equal(d.rev, 2);
    assert.equal(d.revisionOfSaleId, s.saleId);
    assert.equal(d.events.length, 2, '录入 + 改为');
    assert.equal(d.events[0].saleId, s.saleId);
    assert.equal(d.events[1].saleId, r.saleId);
    assert.equal(d.events[1].current, true, '最新那版才是当前版本');
  });

  it('从旧版本打开也能看到完整经过，并被挡住不让改', () => {
    const s = sell('2');
    const r = reviseSale(db, s.saleId, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '3', unitPriceYuan: '550' }],
    });

    const old = saleDetail(db, s.saleId);
    assert.equal(old.events.length, 2, '旧版本也要能看到后来发生了什么');
    assert.equal(old.canRevise, false);
    assert.match(old.blockedReason!, /旧版本/);
    assert.equal(old.supersededBySaleId, r.saleId, '要能指向最新那张');
  });

  it('改三次串成四节链', () => {
    let id = sell('1').saleId;
    for (const qty of ['2', '3', '4']) {
      id = reviseSale(db, id, {
        bizDate: '2026-09-19',
        settleType: 'cash',
        items: [{ productId: zhonghua, unit: 'pack', qty, unitPriceYuan: '550' }],
      }).saleId;
    }
    const d = saleDetail(db, id);
    assert.equal(d.rev, 4);
    assert.equal(d.events.length, 4);
    assert.equal(d.events.filter((e) => e.current).length, 1, '只能有一个当前版本');
  });

  // 链是数据驱动的，成了环就不能把界面转死
  it('修订链成环也不会死循环', () => {
    const a = sell('1').saleId;
    const b = reviseSale(db, a, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '2', unitPriceYuan: '550' }],
    }).saleId;
    // 人为制造一个环
    db.prepare('UPDATE sales SET superseded_by_sale_id = ? WHERE id = ?').run(a, b);

    const d = saleDetail(db, b);
    assert.ok(d.events.length >= 2, '能返回就说明没转死');
  });
});

describe('退货与作废在经过里的样子', () => {
  it('退货作为一条经过出现，原单仍是当前版本', () => {
    const s = sell('2');
    returnSale(db, s.saleId, { bizDate: '2026-09-25', items: [{ productId: zhonghua, qty: '1' }] });

    const d = saleDetail(db, s.saleId);
    const kinds = d.events.map((e) => e.kind);
    assert.deepEqual(kinds, ['created', 'returned']);
    assert.equal(centsToYuan(d.returnedCents), '-550.00');
    assert.equal(d.canReturn, true, '还剩一条没退，可以继续退');
  });

  it('全退完就不能再退了', () => {
    const s = sell('2');
    returnSale(db, s.saleId, { bizDate: '2026-09-25' });
    const d = saleDetail(db, s.saleId);
    assert.equal(d.canReturn, false, '退光了还让点退货，点下去只会报错');
  });

  it('作废的单标出来且不让改不让退', () => {
    const s = sell('2');
    voidSale(db, s.saleId);

    const d = saleDetail(db, s.saleId);
    assert.ok(d.voidedAt);
    assert.equal(d.canRevise, false);
    assert.equal(d.canReturn, false);
    assert.match(d.blockedReason!, /已经作废/);
    assert.ok(d.events.some((e) => e.kind === 'voided'));
  });

  it('退货单本身不能再改再退', () => {
    const s = sell('2');
    const r = returnSale(db, s.saleId, { bizDate: '2026-09-25' });
    const d = saleDetail(db, r.returnSaleId);
    assert.equal(d.canRevise, false);
    assert.match(d.blockedReason!, /退货单/);
  });
});

describe('挂账单详情', () => {
  it('显示已核销多少', () => {
    const s = checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'credit',
      customerId: laowang,
      items: [{ productId: zhonghua, unit: 'pack', qty: '2', unitPriceYuan: '550' }],
      partialPay: { amountYuan: '300', method: 'cash' },
    });

    const d = saleDetail(db, s.saleId);
    assert.equal(d.customerName, '老王');
    assert.equal(centsToYuan(d.settledCents), '300.00', '部分付那 300 当场核销掉了');
  });
});

describe('当日流水', () => {
  it('按时间倒序，作废的不出现', () => {
    const a = sell('1');
    sell('2');
    voidSale(db, a.saleId);

    const list = listSales(db, '2026-09-19');
    assert.equal(list.length, 1);
    assert.ok(list[0].summary.includes('中华(硬)'));
  });

  it('多行时摘要说清有几样', () => {
    db.prepare(`INSERT INTO products (name, category, base_unit) VALUES ('利群', 'cigarette', '包')`).run();
    checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [
        { productId: zhonghua, unit: 'pack', qty: '1', unitPriceYuan: '550' },
        { productId: 2, unit: 'base', qty: '1', unitPriceYuan: '23' },
      ],
    });
    const list = listSales(db, '2026-09-19');
    assert.match(list[0].summary, /等 2 样/);
  });
});
