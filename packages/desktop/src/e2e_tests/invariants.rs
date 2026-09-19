//! 把 docs/02 的不变量逐条拿真数据撞一遍。
//!
//! 建表建出来不算数据模型做完了 —— 要证明写脏数据会被挡住。
//! 这些约束不写进库，就得靠每个调用方自觉，而「自觉」在半年后必然失效，
//! 且失效时**不会报错，只会算错**。
//!
//! Node 版这是一个单独的脚本（`npm run verify:model`），要人记得去跑。
//! 现在它就是测试的一部分，每次 `pnpm test` 都撞一遍 —— 少一件要记的事。

use super::*;

/// 这段写入必须被数据库拒绝。
fn must_reject(conn: &Connection, what: &str, sql: &str) {
    let r = conn.execute(sql, []);
    assert!(r.is_err(), "{what} —— 脏数据被放行了");
}

/// 这段写入必须成功。
fn must_accept(conn: &Connection, what: &str, sql: &str) {
    if let Err(e) = conn.execute(sql, []) {
        panic!("{what} —— 正常数据被拒了：{e}");
    }
}

/// 建一个临时库来撞，不碰真实库。
///
/// 约束是**表结构的性质**，跟店里有什么数据无关。早先 Node 版跑在真实库上
/// （靠事务回滚不留垃圾），但夹具用的是写死的名字和 id：店里只要真有个客户
/// 叫老王，验证就直接崩在 UNIQUE 上 —— 约束明明是好的，却报成了失败。
fn model() -> Connection {
    open_memory().unwrap()
}

#[test]
fn 商品的约束() {
    let c = model();

    must_accept(
        &c,
        "可以建商品",
        "INSERT INTO products (id, name, category, base_unit, pack_unit, pack_ratio,
                               price_base_cents, price_pack_cents)
         VALUES (901, '中华(硬)', 'cigarette', '包', '条', 10, 5700, 55000)",
    );

    must_reject(
        &c,
        "同名商品不能建第二条（整条卖和单包卖是一个商品）",
        "INSERT INTO products (name, category, base_unit) VALUES ('中华(硬)', 'cigarette', '包')",
    );

    must_reject(
        &c,
        "分类只能是三选一",
        "INSERT INTO products (name, category, base_unit) VALUES ('某某', 'snack', '包')",
    );

    must_reject(
        &c,
        "有包装单位换算却没填包装单位",
        "INSERT INTO products (name, category, base_unit, pack_ratio)
         VALUES ('某某', 'liquor', '瓶', 6)",
    );
}

#[test]
fn 客户与销售单的约束() {
    let c = model();
    c.execute("INSERT INTO customers (id, name) VALUES (801, '老王')", [])
        .unwrap();

    must_accept(
        &c,
        "现金单：无客户",
        "INSERT INTO sales (id, biz_date, customer_id, settle_type,
            original_amount_cents, discount_amount_cents, total_amount_cents,
            cost_amount_cents, gross_profit_cents)
         VALUES (701, '2026-09-19', NULL, 'cash', 110000, 0, 110000, 100000, 10000)",
    );

    must_accept(
        &c,
        "挂账单：有客户",
        "INSERT INTO sales (id, biz_date, customer_id, settle_type,
            original_amount_cents, discount_amount_cents, total_amount_cents,
            cost_amount_cents, gross_profit_cents)
         VALUES (702, '2026-09-19', 801, 'credit', 110000, 0, 110000, 100000, 10000)",
    );

    // 不变量 1 —— 最容易被「常识」带偏的一条。
    // 一旦有人想支持「熟客付现金也记客户」，它就会被悄悄打破，
    // 而欠款列表会从那一刻开始撒谎。
    must_reject(
        &c,
        "不变量1：现金单不许挂客户",
        "INSERT INTO sales (biz_date, customer_id, settle_type,
            original_amount_cents, discount_amount_cents, total_amount_cents,
            cost_amount_cents, gross_profit_cents)
         VALUES ('2026-09-19', 801, 'cash', 100, 0, 100, 50, 50)",
    );

    must_reject(
        &c,
        "不变量1：挂账单必须有客户",
        "INSERT INTO sales (biz_date, customer_id, settle_type,
            original_amount_cents, discount_amount_cents, total_amount_cents,
            cost_amount_cents, gross_profit_cents)
         VALUES ('2026-09-19', NULL, 'credit', 100, 0, 100, 50, 50)",
    );
}

#[test]
fn 金额必须自洽() {
    let c = model();
    c.execute(
        "INSERT INTO sales (id, biz_date, settle_type, original_amount_cents,
            discount_amount_cents, total_amount_cents, cost_amount_cents, gross_profit_cents)
         VALUES (701, '2026-09-19', 'cash', 110000, 0, 110000, 100000, 10000)",
        [],
    )
    .unwrap();

    must_reject(
        &c,
        "不变量3：应收必须等于折前减抹零",
        "INSERT INTO sales (biz_date, settle_type,
            original_amount_cents, discount_amount_cents, total_amount_cents,
            cost_amount_cents, gross_profit_cents)
         VALUES ('2026-09-19', 'cash', 133000, 3000, 133000, 100000, 33000)",
    );

    must_reject(
        &c,
        "毛利快照必须等于应收减成本",
        "INSERT INTO sales (biz_date, settle_type,
            original_amount_cents, discount_amount_cents, total_amount_cents,
            cost_amount_cents, gross_profit_cents)
         VALUES ('2026-09-19', 'cash', 100000, 0, 100000, 60000, 99999)",
    );

    must_reject(
        &c,
        "抹零不能是负数（那是加价，不是抹零）",
        "INSERT INTO sales (biz_date, settle_type,
            original_amount_cents, discount_amount_cents, total_amount_cents,
            cost_amount_cents, gross_profit_cents)
         VALUES ('2026-09-19', 'cash', 100000, -500, 100500, 60000, 40500)",
    );

    must_accept(
        &c,
        "退货单：金额为负是合法的",
        "INSERT INTO sales (biz_date, settle_type, return_of_sale_id,
            original_amount_cents, discount_amount_cents, total_amount_cents,
            cost_amount_cents, gross_profit_cents)
         VALUES ('2026-09-20', 'cash', 701, -55000, 0, -55000, -50000, -5000)",
    );
}

#[test]
fn 库存与收款的约束() {
    let c = model();
    c.execute(
        "INSERT INTO products (id, name, category, base_unit) VALUES (901, '中华(硬)', 'cigarette', '包')",
        [],
    )
    .unwrap();
    c.execute("INSERT INTO customers (id, name) VALUES (801, '老王')", [])
        .unwrap();

    must_accept(
        &c,
        "库存可以为负（红线1：不拦路，只提醒）",
        "INSERT INTO inventory (product_id, qty_base_milli, avg_cost_base_e4)
         VALUES (901, -3000, 550000)",
    );

    must_reject(
        &c,
        "加权成本不能为负",
        "UPDATE inventory SET avg_cost_base_e4 = -1 WHERE product_id = 901",
    );

    must_reject(
        &c,
        "收款金额必须为正（撤销走作废，不是记负数）",
        "INSERT INTO payments (biz_date, customer_id, amount_cents, method)
         VALUES ('2026-09-19', 801, -100, 'cash')",
    );

    must_reject(
        &c,
        "收款方式只能是四选一",
        "INSERT INTO payments (biz_date, customer_id, amount_cents, method)
         VALUES ('2026-09-19', 801, 100, 'crypto')",
    );

    must_reject(
        &c,
        "库存流水类型不能瞎写",
        "INSERT INTO stock_movements (biz_date, product_id, type, qty_base_milli,
            unit_cost_base_e4, ref_type, ref_id, balance_after_milli)
         VALUES ('2026-09-19', 901, 'whatever', 1000, 550000, 'sale', 701, 1000)",
    );
}

#[test]
fn 外键咬得住() {
    let c = model();
    c.execute(
        "INSERT INTO products (id, name, category, base_unit) VALUES (901, '中华(硬)', 'cigarette', '包')",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO sales (id, biz_date, settle_type, original_amount_cents,
            discount_amount_cents, total_amount_cents, cost_amount_cents, gross_profit_cents)
         VALUES (702, '2026-09-19', 'cash', 110000, 0, 110000, 100000, 10000)",
        [],
    )
    .unwrap();

    must_reject(
        &c,
        "销售明细不能指向不存在的商品",
        "INSERT INTO sale_items (sale_id, product_id, unit, qty_milli, qty_base_milli,
            unit_price_cents, amount_cents, unit_cost_base_e4, cost_amount_cents)
         VALUES (702, 99999, 'pack', 1000, 10000, 55000, 55000, 550000, 55000)",
    );

    must_accept(
        &c,
        "建一行明细",
        "INSERT INTO sale_items (sale_id, product_id, unit, qty_milli, qty_base_milli,
            unit_price_cents, amount_cents, unit_cost_base_e4, cost_amount_cents)
         VALUES (702, 901, 'pack', 1000, 10000, 55000, 55000, 550000, 55000)",
    );

    c.execute("DELETE FROM sales WHERE id = 702", []).unwrap();
    let left: i64 = c
        .query_row(
            "SELECT count(*) FROM sale_items WHERE sale_id = 702",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(left, 0, "删除销售单要级联删掉它的明细，实际还剩 {left} 行");
}
