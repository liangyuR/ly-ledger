import assert from 'node:assert/strict';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, it } from 'node:test';

import { openDb } from '../db';
import { migrate } from '../db/migrate';
import { centsToYuan, e4ToYuan, milliToQty } from '../money';
import { recomputeQtyFromMovements } from './inventory';
import { collect } from './payments';
import { receive } from './purchases';
import { readDebt } from './rebuild-allocations';
import { reviseSale, returnSale, voidPayment, voidPurchase, voidSale } from './reversals';
import { checkout } from './sales';

let db: Database;
let zhonghua: number;
let liqun: number;
let laowang: number;

function stock() {
  return db
    .prepare('SELECT qty_base_milli AS q, avg_cost_base_e4 AS c FROM inventory WHERE product_id = ?')
    .get(zhonghua) as { q: number; c: number };
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
  liqun = Number(
    db
      .prepare(
        `INSERT INTO products (name, category, base_unit, pack_unit, pack_ratio)
         VALUES ('利群', 'cigarette', '包', '条', 10)`,
      )
      .run().lastInsertRowid,
  );
  laowang = Number(db.prepare(`INSERT INTO customers (name) VALUES ('老王')`).run().lastInsertRowid);

  // 打底：10 条，成本 52.0000/包
  receive(db, {
    bizDate: '2026-09-01',
    items: [{ productId: zhonghua, unit: 'pack', qty: '10', unitCostYuan: '520' }],
  });
});

describe('作废销售单', () => {
  it('货加回来，均价不变', () => {
    const sale = checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '2', unitPriceYuan: '550' }],
    });
    assert.equal(milliToQty(stock().q), '80');

    voidSale(db, sale.saleId);

    const s = stock();
    assert.equal(milliToQty(s.q), '100', '货回来了');
    assert.equal(e4ToYuan(s.c), '52.0000', '均价不变 —— 卖出按 avg 扣、撤回按同一个 avg 加，自然抵消');
    assert.equal(recomputeQtyFromMovements(db, zhonghua), s.q, '快照与流水一致');
  });

  it('作废单不进报表口径', () => {
    const sale = checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '2', unitPriceYuan: '550' }],
    });
    voidSale(db, sale.saleId);

    const row = db
      .prepare(
        "SELECT COALESCE(SUM(total_amount_cents),0) AS s FROM sales WHERE biz_date='2026-09-19' AND voided_at IS NULL",
      )
      .get() as { s: number };
    assert.equal(row.s, 0, '当日营业额应为 0');
  });

  it('同一张单不能作废两次', () => {
    const sale = checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '1', unitPriceYuan: '550' }],
    });
    voidSale(db, sale.saleId);
    assert.throws(() => voidSale(db, sale.saleId), /已经作废过/);
  });

  it('作废已被核销的挂账单：款项流向下一张', () => {
    const s1 = checkout(db, {
      bizDate: '2026-09-01',
      settleType: 'credit',
      customerId: laowang,
      items: [{ productId: zhonghua, unit: 'pack', qty: '1', unitPriceYuan: '550' }],
    });
    checkout(db, {
      bizDate: '2026-09-05',
      settleType: 'credit',
      customerId: laowang,
      items: [{ productId: zhonghua, unit: 'pack', qty: '1', unitPriceYuan: '550' }],
    });
    collect(db, { bizDate: '2026-09-10', customerId: laowang, amountYuan: '550', method: 'cash' });

    // 此刻 550 核销在最早那张上
    assert.equal(readDebt(db, laowang).earliestUnpaidDate, '2026-09-05');

    voidSale(db, s1.saleId);

    const debt = readDebt(db, laowang);
    assert.equal(centsToYuan(debt.netDebtCents), '0.00', '欠 550 收 550');
    assert.equal(debt.earliestUnpaidDate, null, '释放出的款项自动补到 9-05 那张');
  });
});

describe('改单', () => {
  it('改数量：库存与毛利都跟着重算', () => {
    const sale = checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '2', unitPriceYuan: '550' }],
    });
    assert.equal(centsToYuan(sale.grossProfitCents), '60.00');

    const revised = reviseSale(db, sale.saleId, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '3', unitPriceYuan: '550' }],
    });

    assert.equal(revised.rev, 2);
    assert.equal(centsToYuan(revised.totalCents), '1650.00');
    assert.equal(centsToYuan(revised.grossProfitCents), '90.00');
    assert.equal(milliToQty(stock().q), '70', '100 − 30');
  });

  // 这是整个改单设计里最容易写错、也最要命的一条
  it('中途进过货：未改动的行仍沿用原单成本快照', () => {
    const sale = checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '2', unitPriceYuan: '550' }],
    });

    // 老板又进了一批更贵的，均价被抬高
    receive(db, {
      bizDate: '2026-09-20',
      items: [{ productId: zhonghua, unit: 'pack', qty: '10', unitCostYuan: '600' }],
    });
    assert.notEqual(e4ToYuan(stock().c), '52.0000', '当前均价确实变了');

    // 现在才想起来那单数量录错了
    const revised = reviseSale(db, sale.saleId, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '3', unitPriceYuan: '550' }],
    });

    const item = db
      .prepare('SELECT unit_cost_base_e4 AS c FROM sale_items WHERE sale_id = ?')
      .get(revised.saleId) as { c: number };
    assert.equal(
      e4ToYuan(item.c),
      '52.0000',
      '必须是原单快照。若读当前均价，老板只是改个数量，这单毛利就莫名其妙变了',
    );
    assert.equal(centsToYuan(revised.grossProfitCents), '90.00');
  });

  it('换成别的商品：新行取当前均价', () => {
    receive(db, {
      bizDate: '2026-09-01',
      items: [{ productId: liqun, unit: 'pack', qty: '5', unitCostYuan: '210' }],
    });

    const sale = checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '1', unitPriceYuan: '550' }],
    });

    const revised = reviseSale(db, sale.saleId, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: liqun, unit: 'pack', qty: '1', unitPriceYuan: '230' }],
    });

    const item = db
      .prepare('SELECT unit_cost_base_e4 AS c FROM sale_items WHERE sale_id = ?')
      .get(revised.saleId) as { c: number };
    assert.equal(e4ToYuan(item.c), '21.0000', '利群没有原快照，取当前均价');
  });

  it('修订链两头都串上了', () => {
    const sale = checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '1', unitPriceYuan: '550' }],
    });
    const revised = reviseSale(db, sale.saleId, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '2', unitPriceYuan: '550' }],
    });

    const old = db.prepare('SELECT * FROM sales WHERE id = ?').get(sale.saleId) as {
      voided_at: string | null;
      void_reason: string;
      superseded_by_sale_id: number;
    };
    const neu = db.prepare('SELECT * FROM sales WHERE id = ?').get(revised.saleId) as {
      revision_of_sale_id: number;
      rev: number;
    };

    assert.ok(old.voided_at);
    assert.equal(old.void_reason, 'revised');
    assert.equal(old.superseded_by_sale_id, revised.saleId);
    assert.equal(neu.revision_of_sale_id, sale.saleId);
    assert.equal(neu.rev, 2);
  });
});

describe('退货', () => {
  it('算在退货当天，不动原单那天的营业额', () => {
    const sale = checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '2', unitPriceYuan: '550' }],
    });

    returnSale(db, sale.saleId, { bizDate: '2026-09-25' });

    const d19 = db
      .prepare("SELECT SUM(total_amount_cents) AS s FROM sales WHERE biz_date='2026-09-19' AND voided_at IS NULL")
      .get() as { s: number };
    const d25 = db
      .prepare("SELECT SUM(total_amount_cents) AS s FROM sales WHERE biz_date='2026-09-25' AND voided_at IS NULL")
      .get() as { s: number };

    assert.equal(centsToYuan(d19.s), '1100.00', '那笔生意确实做过，不能让它凭空缩水');
    assert.equal(centsToYuan(d25.s), '-1100.00', '冲减记在退货当天');
    assert.equal(milliToQty(stock().q), '100', '货回来了');
  });

  it('退货入库用原单快照，中途进过货也不受影响', () => {
    const sale = checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '2', unitPriceYuan: '550' }],
    });

    receive(db, {
      bizDate: '2026-09-20',
      items: [{ productId: zhonghua, unit: 'pack', qty: '10', unitCostYuan: '600' }],
    });

    returnSale(db, sale.saleId, { bizDate: '2026-09-25' });

    const mv = db
      .prepare("SELECT unit_cost_base_e4 AS c FROM stock_movements WHERE type='return' ORDER BY id DESC LIMIT 1")
      .get() as { c: number };
    assert.equal(e4ToYuan(mv.c), '52.0000', '取原单快照，不是当前均价');
  });

  it('部分退：只退一半', () => {
    const sale = checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '2', unitPriceYuan: '550' }],
    });

    const r = returnSale(db, sale.saleId, {
      bizDate: '2026-09-25',
      items: [{ productId: zhonghua, qty: '1' }],
    });

    assert.equal(centsToYuan(r.refundCents), '550.00');
    assert.equal(milliToQty(stock().q), '90', '退回 1 条 = 10 包');
  });

  it('退超原单数量直接拒绝', () => {
    const sale = checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '2', unitPriceYuan: '550' }],
    });
    returnSale(db, sale.saleId, { bizDate: '2026-09-25', items: [{ productId: zhonghua, qty: '1' }] });

    assert.throws(
      () => returnSale(db, sale.saleId, { bizDate: '2026-09-26', items: [{ productId: zhonghua, qty: '2' }] }),
      /超过原单/,
    );
  });

  it('作废过的单无货可退', () => {
    const sale = checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '1', unitPriceYuan: '550' }],
    });
    voidSale(db, sale.saleId);
    assert.throws(() => returnSale(db, sale.saleId, { bizDate: '2026-09-25' }), /无货可退/);
  });

  it('挂账单退货：欠款相应减少', () => {
    const sale = checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'credit',
      customerId: laowang,
      items: [{ productId: zhonghua, unit: 'pack', qty: '2', unitPriceYuan: '550' }],
    });
    assert.equal(centsToYuan(readDebt(db, laowang).netDebtCents), '1100.00');

    returnSale(db, sale.saleId, { bizDate: '2026-09-25', items: [{ productId: zhonghua, qty: '1' }] });

    assert.equal(centsToYuan(readDebt(db, laowang).netDebtCents), '550.00');
  });
});

describe('作废进货单', () => {
  it('库存扣回，均价还原', () => {
    receive(db, {
      bizDate: '2026-09-10',
      items: [{ productId: zhonghua, unit: 'pack', qty: '5', unitCostYuan: '600' }],
    });
    const p = db.prepare('SELECT id FROM purchases ORDER BY id DESC LIMIT 1').get() as { id: number };

    voidPurchase(db, p.id);

    const s = stock();
    assert.equal(milliToQty(s.q), '100');
    // 加权平均**不是无损可逆**的：进货时 82,000,000/150 除不尽，
    // 舍入的那 0.33 在撤回时会放大成 1 个 e4 单位（0.0001 元/包）。
    // 这是算法固有性质，不是 bug —— 误差上限就是 1 个 e4，且下次进货会覆盖掉
    assert.ok(Math.abs(s.c - 520000) <= 1, `均价应回到 52 附近，实际 ${e4ToYuan(s.c)}`);
  });

  it('反算出负成本时归零并告警', () => {
    // 触发条件：贵货进来后大半已卖掉（库存总值被抽走），此时才发现那张进货单录错。
    // 用另一个商品，避开 beforeEach 打的底
    const mao = Number(
      db
        .prepare(`INSERT INTO products (name, category, base_unit) VALUES ('茅台', 'liquor', '瓶')`)
        .run().lastInsertRowid,
    );

    receive(db, { bizDate: '2026-09-01', items: [{ productId: mao, unit: 'base', qty: '10', unitCostYuan: '100' }] });
    const pricey = db.prepare('SELECT id FROM purchases ORDER BY id DESC LIMIT 1').get() as { id: number };

    // 卖掉 9 瓶，库存总值从 1000 掉到 100
    checkout(db, {
      bizDate: '2026-09-05',
      settleType: 'cash',
      items: [{ productId: mao, unit: 'base', qty: '9', unitPriceYuan: '150' }],
    });
    // 再进一批便宜的
    receive(db, { bizDate: '2026-09-06', items: [{ productId: mao, unit: 'base', qty: '100', unitCostYuan: '1' }] });

    // 撤那张 1000 块的进货单：库存总值只有约 200，减 1000 必为负
    const r = voidPurchase(db, pricey.id);
    assert.ok(r.warnings.length >= 1, '必须告警，否则后续毛利全错且无人察觉');

    const after = db
      .prepare('SELECT avg_cost_base_e4 AS c FROM inventory WHERE product_id = ?')
      .get(mao) as { c: number };
    assert.equal(after.c, 0, '绝不写入负成本');
  });

  it('不回溯修改历史成本快照', () => {
    const sale = checkout(db, {
      bizDate: '2026-09-05',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '1', unitPriceYuan: '550' }],
    });
    const before = db
      .prepare('SELECT cost_amount_cents AS c FROM sales WHERE id = ?')
      .get(sale.saleId) as { c: number };

    const p = db.prepare('SELECT id FROM purchases ORDER BY id LIMIT 1').get() as { id: number };
    voidPurchase(db, p.id);

    const after = db
      .prepare('SELECT cost_amount_cents AS c FROM sales WHERE id = ?')
      .get(sale.saleId) as { c: number };
    assert.equal(after.c, before.c, '上个月的利润不能因为今天的作废而变（红线 3）');
  });
});

describe('作废收款', () => {
  it('欠款回到作废前的数字', () => {
    checkout(db, {
      bizDate: '2026-09-01',
      settleType: 'credit',
      customerId: laowang,
      items: [{ productId: zhonghua, unit: 'pack', qty: '2', unitPriceYuan: '550' }],
    });
    const p = collect(db, { bizDate: '2026-09-10', customerId: laowang, amountYuan: '600', method: 'cash' });
    assert.equal(centsToYuan(readDebt(db, laowang).netDebtCents), '500.00');

    voidPayment(db, p.paymentId);

    assert.equal(centsToYuan(readDebt(db, laowang).netDebtCents), '1100.00');
    const n = db
      .prepare('SELECT count(*) AS n FROM payment_allocations WHERE payment_id = ?')
      .get(p.paymentId) as { n: number };
    assert.equal(n.n, 0, '作废的收款不该还留着核销记录');
  });

  it('同一笔收款不能作废两次', () => {
    checkout(db, {
      bizDate: '2026-09-01',
      settleType: 'credit',
      customerId: laowang,
      items: [{ productId: zhonghua, unit: 'pack', qty: '1', unitPriceYuan: '550' }],
    });
    const p = collect(db, { bizDate: '2026-09-10', customerId: laowang, amountYuan: '100', method: 'cash' });
    voidPayment(db, p.paymentId);
    assert.throws(() => voidPayment(db, p.paymentId), /已经作废过/);
  });
});
