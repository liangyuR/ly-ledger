import assert from 'node:assert/strict';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, it } from 'node:test';

import { openDb } from '../db';
import { migrate } from '../db/migrate';
import { dismissOnboarding, onboardingState, skipOpeningStock } from './onboarding';
import { receive } from './purchases';
import { checkout } from './sales';
import { voidSale } from './reversals';

let db: Database;

function addProduct(name = '中华(硬)', priced = false): number {
  return Number(
    db
      .prepare(
        `INSERT INTO products (name, category, base_unit, pack_unit, pack_ratio, price_base_cents)
         VALUES (?, 'cigarette', '包', '条', 10, ?)`,
      )
      .run(name, priced ? 5700 : null).lastInsertRowid,
  );
}

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
});

const step = (s: ReturnType<typeof onboardingState>, key: string) =>
  s.steps.find((x) => x.key === key)!;

describe('向导进度', () => {
  it('空库时四步全没做', () => {
    const s = onboardingState(db);
    assert.equal(s.doneCount, 0);
    assert.equal(s.complete, false);
    assert.equal(s.fresh, true, '一个商品一笔生意都没有，该进全屏向导');
  });

  it('只有期初库存那步能跳', () => {
    const optional = onboardingState(db)
      .steps.filter((x) => x.optional)
      .map((x) => x.key);
    assert.deepEqual(optional, ['stock']);
  });

  it('建了商品，第一步就算做完', () => {
    addProduct();
    const s = onboardingState(db);
    assert.equal(step(s, 'products').done, true);
    assert.equal(step(s, 'prices').done, false, '建了商品不等于填了价');
  });

  // 老板从商品页自己填的价，向导也得认 —— 否则会催他做已经做完的事
  it('绕开向导填的价一样算数', () => {
    const id = addProduct();
    db.prepare('UPDATE products SET price_pack_cents = 55000 WHERE id = ?').run(id);
    assert.equal(step(onboardingState(db), 'prices').done, true);
  });

  it('进了货，期初那步就算做完，不用点跳过', () => {
    const id = addProduct(undefined, true);
    receive(db, {
      bizDate: '2026-09-01',
      items: [{ productId: id, unit: 'pack', qty: '10', unitCostYuan: '520' }],
    });
    assert.equal(step(onboardingState(db), 'stock').done, true);
  });

  it('跳过期初库存：不算做完，但算处理过了', () => {
    const id = addProduct(undefined, true);
    skipOpeningStock(db);

    const s = onboardingState(db);
    assert.equal(step(s, 'stock').done, false);
    assert.equal(step(s, 'stock').skipped, true);
    assert.equal(s.complete, false, '还差第一笔生意');

    checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: id, unit: 'pack', qty: '1', unitPriceYuan: '550' }],
    });
    assert.equal(onboardingState(db).complete, true, '跳过的那步不该挡住"装好了"');
  });

  it('卖出第一笔才算装好', () => {
    const id = addProduct(undefined, true);
    receive(db, {
      bizDate: '2026-09-01',
      items: [{ productId: id, unit: 'pack', qty: '10', unitCostYuan: '520' }],
    });
    assert.equal(onboardingState(db).complete, false, '前三步做完了也不算');

    checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: id, unit: 'pack', qty: '1', unitPriceYuan: '550' }],
    });
    assert.equal(onboardingState(db).complete, true);
  });

  // 试卖那一笔多半要撤掉，撤掉之后不能倒回去催他再卖一次
  it('唯一一笔被作废，就回到没卖过的状态', () => {
    const id = addProduct(undefined, true);
    const sale = checkout(db, {
      bizDate: '2026-09-19',
      settleType: 'cash',
      items: [{ productId: id, unit: 'pack', qty: '1', unitPriceYuan: '550' }],
    });
    assert.equal(step(onboardingState(db), 'firstSale').done, true);

    voidSale(db, sale.saleId);
    assert.equal(step(onboardingState(db), 'firstSale').done, false);
    assert.equal(onboardingState(db).fresh, false, '商品还在，不该再弹全屏向导');
  });

  it('关掉清单不影响进度本身', () => {
    addProduct();
    dismissOnboarding(db);
    const s = onboardingState(db);
    assert.equal(s.dismissed, true);
    assert.equal(s.doneCount, 1, '关掉的是清单，不是进度');

    dismissOnboarding(db, false);
    assert.equal(onboardingState(db).dismissed, false, '要能重新打开');
  });
});
