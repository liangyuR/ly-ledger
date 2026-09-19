/**
 * 把 docs/02 的不变量逐条拿真数据撞一遍。
 *
 * 建表建出来不算数据模型做完了 —— 要证明写脏数据会被挡住。
 * 这些约束不写进库，就得靠每个调用方自觉，而"自觉"在半年后必然失效，
 * 且失效时**不会报错，只会算错**。
 *
 * 跑法：npm run verify:model
 */
import '../env';

import { getDb } from './index';
import { migrate } from './migrate';

type Check = { name: string; run: () => void };

let passed = 0;
const failures: string[] = [];

/** 断言这段写入必须被数据库拒绝 */
function mustReject(name: string, fn: () => void) {
  try {
    fn();
    failures.push(`${name} —— 脏数据被放行了`);
  } catch {
    passed += 1;
    console.log(`  ✓ ${name}`);
  }
}

/** 断言这段写入必须成功 */
function mustAccept(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failures.push(`${name} —— 正常数据被拒了：${(e as Error).message}`);
  }
}

function main() {
  migrate();
  const db = getDb();

  // 全程在一个事务里跑，最后回滚 —— 不往真实库里留垃圾
  db.exec('BEGIN');

  try {
    console.log('\n商品');
    mustAccept('可以建商品', () => {
      db.prepare(
        `INSERT INTO products (id, name, category, base_unit, pack_unit, pack_ratio, price_base_cents, price_pack_cents)
         VALUES (901, '中华(硬)', 'cigarette', '包', '条', 10, 5700, 55000)`,
      ).run();
    });

    mustReject('同名商品不能建第二条（整条卖和单包卖是一个商品）', () => {
      db.prepare(
        `INSERT INTO products (name, category, base_unit) VALUES ('中华(硬)', 'cigarette', '包')`,
      ).run();
    });

    mustReject('分类只能是三选一', () => {
      db.prepare(
        `INSERT INTO products (name, category, base_unit) VALUES ('某某', 'snack', '包')`,
      ).run();
    });

    mustReject('有包装单位换算却没填包装单位', () => {
      db.prepare(
        `INSERT INTO products (name, category, base_unit, pack_ratio) VALUES ('某某', 'liquor', '瓶', 6)`,
      ).run();
    });

    console.log('\n客户与销售单');
    db.prepare(`INSERT INTO customers (id, name) VALUES (801, '老王')`).run();

    mustAccept('现金单：无客户', () => {
      db.prepare(
        `INSERT INTO sales (id, biz_date, customer_id, settle_type,
            original_amount_cents, discount_amount_cents, total_amount_cents,
            cost_amount_cents, gross_profit_cents)
         VALUES (701, '2026-09-19', NULL, 'cash', 110000, 0, 110000, 100000, 10000)`,
      ).run();
    });

    mustAccept('挂账单：有客户', () => {
      db.prepare(
        `INSERT INTO sales (id, biz_date, customer_id, settle_type,
            original_amount_cents, discount_amount_cents, total_amount_cents,
            cost_amount_cents, gross_profit_cents)
         VALUES (702, '2026-09-19', 801, 'credit', 110000, 0, 110000, 100000, 10000)`,
      ).run();
    });

    // 不变量 1 —— 最容易被"常识"带偏的一条。
    // 一旦有人想支持"熟客付现金也记客户"，它就会被悄悄打破，
    // 而欠款列表会从那一刻开始撒谎。
    mustReject('不变量1：现金单不许挂客户', () => {
      db.prepare(
        `INSERT INTO sales (biz_date, customer_id, settle_type,
            original_amount_cents, discount_amount_cents, total_amount_cents,
            cost_amount_cents, gross_profit_cents)
         VALUES ('2026-09-19', 801, 'cash', 100, 0, 100, 50, 50)`,
      ).run();
    });

    mustReject('不变量1：挂账单必须有客户', () => {
      db.prepare(
        `INSERT INTO sales (biz_date, customer_id, settle_type,
            original_amount_cents, discount_amount_cents, total_amount_cents,
            cost_amount_cents, gross_profit_cents)
         VALUES ('2026-09-19', NULL, 'credit', 100, 0, 100, 50, 50)`,
      ).run();
    });

    console.log('\n金额自洽');
    mustReject('不变量3：应收必须等于折前减抹零', () => {
      db.prepare(
        `INSERT INTO sales (biz_date, settle_type,
            original_amount_cents, discount_amount_cents, total_amount_cents,
            cost_amount_cents, gross_profit_cents)
         VALUES ('2026-09-19', 'cash', 133000, 3000, 133000, 100000, 33000)`,
      ).run();
    });

    mustReject('毛利快照必须等于应收减成本', () => {
      db.prepare(
        `INSERT INTO sales (biz_date, settle_type,
            original_amount_cents, discount_amount_cents, total_amount_cents,
            cost_amount_cents, gross_profit_cents)
         VALUES ('2026-09-19', 'cash', 100000, 0, 100000, 60000, 99999)`,
      ).run();
    });

    mustReject('抹零不能是负数（那是加价，不是抹零）', () => {
      db.prepare(
        `INSERT INTO sales (biz_date, settle_type,
            original_amount_cents, discount_amount_cents, total_amount_cents,
            cost_amount_cents, gross_profit_cents)
         VALUES ('2026-09-19', 'cash', 100000, -500, 100500, 60000, 40500)`,
      ).run();
    });

    mustAccept('退货单：金额为负是合法的', () => {
      db.prepare(
        `INSERT INTO sales (biz_date, settle_type, return_of_sale_id,
            original_amount_cents, discount_amount_cents, total_amount_cents,
            cost_amount_cents, gross_profit_cents)
         VALUES ('2026-09-20', 'cash', 701, -55000, 0, -55000, -50000, -5000)`,
      ).run();
    });

    console.log('\n库存与收款');
    mustAccept('库存可以为负（红线1：不拦路，只提醒）', () => {
      db.prepare(
        `INSERT INTO inventory (product_id, qty_base_milli, avg_cost_base_e4)
         VALUES (901, -3000, 550000)`,
      ).run();
    });

    mustReject('加权成本不能为负', () => {
      db.prepare(`UPDATE inventory SET avg_cost_base_e4 = -1 WHERE product_id = 901`).run();
    });

    mustReject('收款金额必须为正（撤销走作废，不是记负数）', () => {
      db.prepare(
        `INSERT INTO payments (biz_date, customer_id, amount_cents, method)
         VALUES ('2026-09-19', 801, -100, 'cash')`,
      ).run();
    });

    mustReject('收款方式只能是四选一', () => {
      db.prepare(
        `INSERT INTO payments (biz_date, customer_id, amount_cents, method)
         VALUES ('2026-09-19', 801, 100, 'crypto')`,
      ).run();
    });

    mustReject('库存流水类型不能瞎写', () => {
      db.prepare(
        `INSERT INTO stock_movements (biz_date, product_id, type, qty_base_milli,
            unit_cost_base_e4, ref_type, ref_id, balance_after_milli)
         VALUES ('2026-09-19', 901, 'whatever', 1000, 550000, 'sale', 701, 1000)`,
      ).run();
    });

    console.log('\n外键');
    mustReject('销售明细不能指向不存在的商品', () => {
      db.prepare(
        `INSERT INTO sale_items (sale_id, product_id, unit, qty_milli, qty_base_milli,
            unit_price_cents, amount_cents, unit_cost_base_e4, cost_amount_cents)
         VALUES (701, 99999, 'pack', 1000, 10000, 55000, 55000, 550000, 55000)`,
      ).run();
    });

    mustAccept('删除销售单会级联删掉它的明细', () => {
      db.prepare(
        `INSERT INTO sale_items (sale_id, product_id, unit, qty_milli, qty_base_milli,
            unit_price_cents, amount_cents, unit_cost_base_e4, cost_amount_cents)
         VALUES (702, 901, 'pack', 1000, 10000, 55000, 55000, 550000, 55000)`,
      ).run();
      db.prepare('DELETE FROM sales WHERE id = 702').run();
      const { n } = db
        .prepare('SELECT count(*) AS n FROM sale_items WHERE sale_id = 702')
        .get() as { n: number };
      if (n !== 0) throw new Error(`级联没生效，还剩 ${n} 行`);
    });
  } finally {
    db.exec('ROLLBACK');
  }

  console.log(`\n通过 ${passed} 项`);
  if (failures.length) {
    console.error(`\n失败 ${failures.length} 项：`);
    failures.forEach((f) => console.error(`  ✗ ${f}`));
    process.exit(1);
  }
  console.log('数据模型的约束都咬得住。\n');
}

main();
