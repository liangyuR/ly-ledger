/**
 * 端到端：把数据模型证伪一遍。
 *
 * 建表建出来不算数据模型做完了。真正的验收是走一遍真实业务，
 * 检查四件事：单位换算、加权成本、流水完整性、结存数字。
 *
 * 这一步走通了，后面的接口和前端才有地基。
 */
import assert from 'node:assert/strict';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, it } from 'node:test';

import { openDb } from '../db';
import { migrate } from '../db/migrate';
import { centsToYuan, e4ToYuan, milliToQty, yuanToCents, yuanToE4 } from '../money';
import { recomputeQtyFromMovements } from './inventory';
import { collect } from './payments';
import { receive } from './purchases';
import { checkout } from './sales';
import { readDebt } from './rebuild-allocations';

let db: Database;
let zhonghua: number;
let laowang: number;

function setup() {
  db = openDb(':memory:');
  migrate(db);

  zhonghua = Number(
    db
      .prepare(
        `INSERT INTO products (name, pinyin_full, pinyin_abbr, category, brand, base_unit, pack_unit, pack_ratio,
                               price_base_cents, price_pack_cents)
         VALUES ('中华(硬)', 'zhonghuaying', 'zhy', 'cigarette', '中华', '包', '条', 10, 5700, 55000)`,
      )
      .run().lastInsertRowid,
  );

  laowang = Number(db.prepare(`INSERT INTO customers (name, pinyin_abbr) VALUES ('老王', 'lw')`).run().lastInsertRowid);
}

describe('一笔进货 + 两笔销售', () => {
  beforeEach(setup);

  it('进 10 条中华（每条 520），库存应变成 100 包，成本 52.0000/包', () => {
    const r = receive(db, {
      bizDate: '2026-09-19',
      items: [{ productId: zhonghua, unit: 'pack', qty: '10', unitCostYuan: '520' }],
    });

    assert.equal(centsToYuan(r.totalCents), '5200.00');

    const inv = db
      .prepare('SELECT qty_base_milli, avg_cost_base_e4 FROM inventory WHERE product_id = ?')
      .get(zhonghua) as { qty_base_milli: number; avg_cost_base_e4: number };

    // 单位换算：10 条 = 100 包
    assert.equal(milliToQty(inv.qty_base_milli), '100');
    // 520 / 10 = 52.0000
    assert.equal(e4ToYuan(inv.avg_cost_base_e4), '52.0000');
  });

  it('卖 2 条（550/条）再卖 1 包（57），四个数字都要对', () => {
    receive(db, {
      bizDate: '2026-09-19',
      items: [{ productId: zhonghua, unit: 'pack', qty: '10', unitCostYuan: '520' }],
    });

    const s1 = checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '2', unitPriceYuan: '550' }],
    });

    const s2 = checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'base', qty: '1', unitPriceYuan: '57' }],
    });

    // ① 金额
    assert.equal(centsToYuan(s1.totalCents), '1100.00');
    assert.equal(centsToYuan(s2.totalCents), '57.00');

    // ② 毛利：整条成本 2×10×52 = 1040，单包成本 52
    assert.equal(centsToYuan(s1.grossProfitCents), '60.00');
    assert.equal(centsToYuan(s2.grossProfitCents), '5.00');

    // ③ 结存：100 − 20 − 1 = 79 包
    const inv = db
      .prepare('SELECT qty_base_milli, avg_cost_base_e4 FROM inventory WHERE product_id = ?')
      .get(zhonghua) as { qty_base_milli: number; avg_cost_base_e4: number };
    assert.equal(milliToQty(inv.qty_base_milli), '79');
    assert.equal(e4ToYuan(inv.avg_cost_base_e4), '52.0000', '销售不改均价');

    // ④ 流水完整：3 条，且结存快照 == 流水重算
    const moves = db
      .prepare('SELECT type, qty_base_milli, balance_after_milli FROM stock_movements WHERE product_id = ? ORDER BY id')
      .all(zhonghua) as { type: string; qty_base_milli: number; balance_after_milli: number }[];

    assert.deepEqual(
      moves.map((m) => [m.type, milliToQty(m.qty_base_milli), milliToQty(m.balance_after_milli)]),
      [
        ['purchase', '100', '100'],
        ['sale', '-20', '80'],
        ['sale', '-1', '79'],
      ],
    );
    assert.equal(
      recomputeQtyFromMovements(db, zhonghua),
      inv.qty_base_milli,
      '结存快照必须等于流水重算 —— 不等就说明有人绕过了 recordMovement',
    );
  });

  it('两次不同价进货后的加权成本', () => {
    receive(db, {
      bizDate: '2026-09-01',
      items: [{ productId: zhonghua, unit: 'pack', qty: '10', unitCostYuan: '520' }],
    });
    receive(db, {
      bizDate: '2026-09-10',
      items: [{ productId: zhonghua, unit: 'pack', qty: '5', unitCostYuan: '533' }],
    });

    // (100×52 + 50×53.3) / 150 = 52.4333...
    const inv = db.prepare('SELECT avg_cost_base_e4 FROM inventory WHERE product_id = ?').get(zhonghua) as {
      avg_cost_base_e4: number;
    };
    assert.equal(e4ToYuan(inv.avg_cost_base_e4), '52.4333');
  });

  it('没进货就卖：库存变负，照样记账（红线 1）', () => {
    const r = checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: zhonghua, unit: 'pack', qty: '1', unitPriceYuan: '550' }],
    });

    assert.equal(centsToYuan(r.totalCents), '550.00');
    const inv = db.prepare('SELECT qty_base_milli FROM inventory WHERE product_id = ?').get(zhonghua) as {
      qty_base_milli: number;
    };
    assert.equal(milliToQty(inv.qty_base_milli), '-10', '不拦路，只让它变负');
  });

  it('抹零吃进毛利，不动单价', () => {
    receive(db, {
      bizDate: '2026-09-19',
      items: [{ productId: zhonghua, unit: 'pack', qty: '10', unitCostYuan: '520' }],
    });

    const r = checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      discountYuan: '30',
      items: [{ productId: zhonghua, unit: 'pack', qty: '2', unitPriceYuan: '550' }],
    });

    assert.equal(centsToYuan(r.totalCents), '1070.00');
    assert.equal(centsToYuan(r.grossProfitCents), '30.00', '让掉的 30 直接从毛利里出');

    const item = db.prepare('SELECT unit_price_cents FROM sale_items WHERE sale_id = ?').get(r.saleId) as {
      unit_price_cents: number;
    };
    assert.equal(centsToYuan(item.unit_price_cents), '550.00', '单价不能被抹零污染');
  });
});

describe('挂账、收款与预收', () => {
  beforeEach(setup);

  function stockUp() {
    receive(db, {
      bizDate: '2026-08-01',
      items: [{ productId: zhonghua, unit: 'pack', qty: '20', unitCostYuan: '520' }],
    });
  }

  it('挂账 → 收款 → FIFO 自动核销', () => {
    stockUp();

    checkout(db, {
      bizDate: '2026-08-05',
      settleType: 'credit',
      customerId: laowang,
      items: [{ productId: zhonghua, unit: 'pack', qty: '2', unitPriceYuan: '550' }],
    });
    checkout(db, {
      bizDate: '2026-09-01',
      settleType: 'credit',
      customerId: laowang,
      items: [{ productId: zhonghua, unit: 'pack', qty: '1', unitPriceYuan: '550' }],
    });

    let debt = readDebt(db, laowang);
    assert.equal(centsToYuan(debt.netDebtCents), '1650.00');
    assert.equal(debt.earliestUnpaidDate, '2026-08-05');

    const r = collect(db, {
      bizDate: '2026-09-10',
      customerId: laowang,
      amountYuan: '1100',
      method: 'cash',
    });

    assert.equal(r.prepaidCents, 0);
    debt = readDebt(db, laowang);
    assert.equal(centsToYuan(debt.netDebtCents), '550.00');
    assert.equal(debt.earliestUnpaidDate, '2026-09-01', '最早那张已结清，账龄前移');
  });

  it('收多了：余额成为预收，净欠款为负', () => {
    stockUp();
    checkout(db, {
      bizDate: '2026-08-05',
      settleType: 'credit',
      customerId: laowang,
      items: [{ productId: zhonghua, unit: 'pack', qty: '2', unitPriceYuan: '550' }],
    });

    const r = collect(db, {
      bizDate: '2026-09-10',
      customerId: laowang,
      amountYuan: '1200',
      method: 'wechat',
    });

    assert.equal(centsToYuan(r.prepaidCents), '100.00');
    assert.equal(centsToYuan(r.debt.netDebtCents), '-100.00', '负数即预收');
    assert.equal(r.debt.earliestUnpaidDate, null);
  });

  it('部分付：一张挂账单 + 一笔同日收款，当场核销掉', () => {
    stockUp();

    const r = checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'credit',
      customerId: laowang,
      items: [{ productId: zhonghua, unit: 'pack', qty: '2', unitPriceYuan: '550' }],
      partialPay: { amountYuan: '300', method: 'cash' },
    });

    assert.ok(r.paymentId, '部分付应产生一笔收款记录');

    const debt = readDebt(db, laowang);
    assert.equal(centsToYuan(debt.netDebtCents), '800.00', '1100 − 300');

    const alloc = db
      .prepare('SELECT SUM(amount_cents) AS s FROM payment_allocations WHERE payment_id = ?')
      .get(r.paymentId) as { s: number };
    assert.equal(centsToYuan(alloc.s), '300.00', '这 300 当场核销掉本单，不用再去收款页录一遍');
  });

  it('补录一张更早的挂账单，核销顺序跟着重算', () => {
    stockUp();

    checkout(db, {
      bizDate: '2026-09-01',
      settleType: 'credit',
      customerId: laowang,
      items: [{ productId: zhonghua, unit: 'pack', qty: '1', unitPriceYuan: '550' }],
    });
    collect(db, { bizDate: '2026-09-10', customerId: laowang, amountYuan: '550', method: 'cash' });

    // 此时无欠款
    assert.equal(readDebt(db, laowang).netDebtCents, 0);

    // 老板想起来 8 月 5 日还有一笔漏记的
    checkout(db, {
      bizDate: '2026-08-05',
      settleType: 'credit',
      customerId: laowang,
      items: [{ productId: zhonghua, unit: 'pack', qty: '1', unitPriceYuan: '550' }],
    });

    const debt = readDebt(db, laowang);
    assert.equal(centsToYuan(debt.netDebtCents), '550.00');
    // 那 550 的收款现在应该核销到更早的 8-05 那张上，未结清的变成 9-01 那张
    assert.equal(debt.earliestUnpaidDate, '2026-09-01', '账龄按重算后的顺序，不是按收款发生的顺序');
  });
});

describe('入参防线', () => {
  beforeEach(setup);

  it('现金单不能挂客户', () => {
    assert.throws(
      () =>
        checkout(db, {
          bizDate: '2026-09-19',
          settleType: 'cash',
          customerId: laowang,
          items: [{ productId: zhonghua, unit: 'base', qty: '1', unitPriceYuan: '57' }],
        }),
      /现金单不能挂客户/,
    );
  });

  it('挂账必须指定客户', () => {
    assert.throws(
      () =>
        checkout(db, {
          bizDate: '2026-09-19',
          settleType: 'credit',
          items: [{ productId: zhonghua, unit: 'base', qty: '1', unitPriceYuan: '57' }],
        }),
      /挂账必须指定客户/,
    );
  });

  it('部分付只能配挂账', () => {
    assert.throws(
      () =>
        checkout(db, {
          bizDate: '2026-09-19',
          settleType: 'cash',
          items: [{ productId: zhonghua, unit: 'base', qty: '1', unitPriceYuan: '57' }],
          partialPay: { amountYuan: '10', method: 'cash' },
        }),
      /部分付属于挂账/,
    );
  });

  it('收款金额为负直接拒绝', () => {
    assert.throws(
      () => collect(db, { bizDate: '2026-09-19', customerId: laowang, amountYuan: '-100', method: 'cash' }),
      /必须为正/,
    );
  });

  it('失败的结账不留半张单', () => {
    const before = db.prepare('SELECT count(*) AS n FROM sales').get() as { n: number };
    assert.throws(() =>
      checkout(db, {
        bizDate: '2026-09-19',
        settleType: 'cash',
        items: [
          { productId: zhonghua, unit: 'base', qty: '1', unitPriceYuan: '57' },
          { productId: 999999, unit: 'base', qty: '1', unitPriceYuan: '57' },
        ],
      }),
    );
    const after = db.prepare('SELECT count(*) AS n FROM sales').get() as { n: number };
    assert.equal(after.n, before.n, '整个事务回滚，不留幽灵记录');
  });
});
