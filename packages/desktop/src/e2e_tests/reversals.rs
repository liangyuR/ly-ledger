//! 作废 · 改单 · 退货 —— 实现复杂度高于正向接口，全系统最需要单测的部分。

use super::*;

// ═══════════════════ 作废 · 改单 · 退货 ═══════════════════

struct Reversal {
    conn: Connection,
    zhonghua: i64,
    liqun: i64,
    laowang: i64,
}

/// 打底：10 条中华，成本 52.0000/包。
fn reversal_shop() -> Reversal {
    let conn = open_memory().unwrap();
    let zhonghua = insert_product(
        &conn,
        "INSERT INTO products (name, category, base_unit, pack_unit, pack_ratio)
         VALUES ('中华(硬)', 'cigarette', '包', '条', 10)",
    );
    let liqun = insert_product(
        &conn,
        "INSERT INTO products (name, category, base_unit, pack_unit, pack_ratio)
         VALUES ('利群', 'cigarette', '包', '条', 10)",
    );
    conn.execute("INSERT INTO customers (name) VALUES ('老王')", [])
        .unwrap();
    let laowang = conn.last_insert_rowid();

    let mut r = Reversal {
        conn,
        zhonghua,
        liqun,
        laowang,
    };
    do_receive(
        &mut r.conn,
        json!({
            "bizDate": "2026-09-01",
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "10", "unitCostYuan": "520" }],
        }),
    )
    .unwrap();
    r
}

fn cash_sale(r: &mut Reversal, biz_date: &str, qty: &str) -> CheckoutResult {
    let zhonghua = r.zhonghua;
    do_checkout(
        &mut r.conn,
        json!({
            "bizDate": biz_date,
            "settleType": "cash",
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": qty, "unitPriceYuan": "550" }],
        }),
    )
    .unwrap()
}

#[test]
fn 作废销售单货加回来均价不变() {
    let mut r = reversal_shop();
    let sale = cash_sale(&mut r, "2026-09-19", "2");
    assert_eq!(milli_to_qty(stock_of(&r.conn, r.zhonghua).0), "80");

    do_void_sale(&mut r.conn, sale.sale_id).unwrap();

    let (qty, cost) = stock_of(&r.conn, r.zhonghua);
    assert_eq!(milli_to_qty(qty), "100", "货回来了");
    assert_eq!(
        e4_to_yuan(cost),
        "52.0000",
        "均价不变 —— 卖出按 avg 扣、撤回按同一个 avg 加，自然抵消"
    );
    assert_eq!(
        recompute_qty_from_movements(&r.conn, r.zhonghua).unwrap(),
        qty,
        "快照与流水一致"
    );
}

#[test]
fn 作废单不进报表口径() {
    let mut r = reversal_shop();
    let sale = cash_sale(&mut r, "2026-09-19", "2");
    do_void_sale(&mut r.conn, sale.sale_id).unwrap();

    assert_eq!(
        sum_cents(
            &r.conn,
            "SELECT SUM(total_amount_cents) FROM sales WHERE biz_date='2026-09-19' AND voided_at IS NULL"
        ),
        0,
        "当日营业额应为 0"
    );
}

#[test]
fn 同一张单不能作废两次() {
    let mut r = reversal_shop();
    let sale = cash_sale(&mut r, "2026-09-19", "1");
    do_void_sale(&mut r.conn, sale.sale_id).unwrap();

    let e = err_of(do_void_sale(&mut r.conn, sale.sale_id));
    assert!(e.contains("已经作废过"), "{e}");
}

#[test]
fn 作废已被核销的挂账单款项流向下一张() {
    let mut r = reversal_shop();
    let (zhonghua, laowang) = (r.zhonghua, r.laowang);

    let s1 = do_checkout(
        &mut r.conn,
        json!({
            "bizDate": "2026-09-01", "settleType": "credit", "customerId": laowang,
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "1", "unitPriceYuan": "550" }],
        }),
    )
    .unwrap();
    do_checkout(
        &mut r.conn,
        json!({
            "bizDate": "2026-09-05", "settleType": "credit", "customerId": laowang,
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "1", "unitPriceYuan": "550" }],
        }),
    )
    .unwrap();
    do_collect(
        &mut r.conn,
        json!({ "bizDate": "2026-09-10", "customerId": laowang, "amountYuan": "550", "method": "cash" }),
    )
    .unwrap();

    // 此刻 550 核销在最早那张上
    assert_eq!(
        debt(&r.conn, laowang).earliest_unpaid_date.as_deref(),
        Some("2026-09-05")
    );

    do_void_sale(&mut r.conn, s1.sale_id).unwrap();

    let d = debt(&r.conn, laowang);
    assert_eq!(cents_to_yuan(d.net_debt_cents), "0.00", "欠 550 收 550");
    assert_eq!(
        d.earliest_unpaid_date, None,
        "释放出的款项自动补到 9-05 那张"
    );
}

#[test]
fn 改数量库存与毛利都跟着重算() {
    let mut r = reversal_shop();
    let sale = cash_sale(&mut r, "2026-09-19", "2");
    assert_eq!(cents_to_yuan(sale.gross_profit_cents), "60.00");

    let zhonghua = r.zhonghua;
    let revised = do_revise(
        &mut r.conn,
        sale.sale_id,
        json!({
            "bizDate": "2026-09-19", "settleType": "cash",
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "3", "unitPriceYuan": "550" }],
        }),
    )
    .unwrap();

    assert_eq!(revised.rev, 2);
    assert_eq!(cents_to_yuan(revised.created.total_cents), "1650.00");
    assert_eq!(cents_to_yuan(revised.created.gross_profit_cents), "90.00");
    assert_eq!(milli_to_qty(stock_of(&r.conn, zhonghua).0), "70", "100 − 30");
}

// 这是整个改单设计里最容易写错、也最要命的一条
#[test]
fn 中途进过货未改动的行仍沿用原单成本快照() {
    let mut r = reversal_shop();
    let sale = cash_sale(&mut r, "2026-09-19", "2");

    // 老板又进了一批更贵的，均价被抬高
    let zhonghua = r.zhonghua;
    do_receive(
        &mut r.conn,
        json!({
            "bizDate": "2026-09-20",
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "10", "unitCostYuan": "600" }],
        }),
    )
    .unwrap();
    assert_ne!(
        e4_to_yuan(stock_of(&r.conn, zhonghua).1),
        "52.0000",
        "当前均价确实变了"
    );

    // 现在才想起来那单数量录错了
    let revised = do_revise(
        &mut r.conn,
        sale.sale_id,
        json!({
            "bizDate": "2026-09-19", "settleType": "cash",
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "3", "unitPriceYuan": "550" }],
        }),
    )
    .unwrap();

    let snapshot: i64 = r
        .conn
        .query_row(
            "SELECT unit_cost_base_e4 FROM sale_items WHERE sale_id = ?1",
            [revised.created.sale_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        e4_to_yuan(snapshot),
        "52.0000",
        "必须是原单快照。若读当前均价，老板只是改个数量，这单毛利就莫名其妙变了"
    );
    assert_eq!(cents_to_yuan(revised.created.gross_profit_cents), "90.00");
}

#[test]
fn 换成别的商品新行取当前均价() {
    let mut r = reversal_shop();
    let (zhonghua, liqun) = (r.zhonghua, r.liqun);

    do_receive(
        &mut r.conn,
        json!({
            "bizDate": "2026-09-01",
            "items": [{ "productId": liqun, "unit": "pack", "qty": "5", "unitCostYuan": "210" }],
        }),
    )
    .unwrap();

    let sale = do_checkout(
        &mut r.conn,
        json!({
            "bizDate": "2026-09-19", "settleType": "cash",
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "1", "unitPriceYuan": "550" }],
        }),
    )
    .unwrap();

    let revised = do_revise(
        &mut r.conn,
        sale.sale_id,
        json!({
            "bizDate": "2026-09-19", "settleType": "cash",
            "items": [{ "productId": liqun, "unit": "pack", "qty": "1", "unitPriceYuan": "230" }],
        }),
    )
    .unwrap();

    let snapshot: i64 = r
        .conn
        .query_row(
            "SELECT unit_cost_base_e4 FROM sale_items WHERE sale_id = ?1",
            [revised.created.sale_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(e4_to_yuan(snapshot), "21.0000", "利群没有原快照，取当前均价");
}

#[test]
fn 修订链两头都串上了() {
    let mut r = reversal_shop();
    let sale = cash_sale(&mut r, "2026-09-19", "1");
    let zhonghua = r.zhonghua;
    let revised = do_revise(
        &mut r.conn,
        sale.sale_id,
        json!({
            "bizDate": "2026-09-19", "settleType": "cash",
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "2", "unitPriceYuan": "550" }],
        }),
    )
    .unwrap();

    let (voided_at, reason, superseded): (Option<String>, Option<String>, Option<i64>) = r
        .conn
        .query_row(
            "SELECT voided_at, void_reason, superseded_by_sale_id FROM sales WHERE id = ?1",
            [sale.sale_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    let (revision_of, rev): (Option<i64>, i64) = r
        .conn
        .query_row(
            "SELECT revision_of_sale_id, rev FROM sales WHERE id = ?1",
            [revised.created.sale_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();

    assert!(voided_at.is_some());
    assert_eq!(reason.as_deref(), Some("revised"));
    assert_eq!(superseded, Some(revised.created.sale_id));
    assert_eq!(revision_of, Some(sale.sale_id));
    assert_eq!(rev, 2);
}

#[test]
fn 退货算在退货当天不动原单那天的营业额() {
    let mut r = reversal_shop();
    let sale = cash_sale(&mut r, "2026-09-19", "2");

    do_return(&mut r.conn, sale.sale_id, json!({ "bizDate": "2026-09-25" })).unwrap();

    assert_eq!(
        cents_to_yuan(sum_cents(
            &r.conn,
            "SELECT SUM(total_amount_cents) FROM sales WHERE biz_date='2026-09-19' AND voided_at IS NULL"
        )),
        "1100.00",
        "那笔生意确实做过，不能让它凭空缩水"
    );
    assert_eq!(
        cents_to_yuan(sum_cents(
            &r.conn,
            "SELECT SUM(total_amount_cents) FROM sales WHERE biz_date='2026-09-25' AND voided_at IS NULL"
        )),
        "-1100.00",
        "冲减记在退货当天"
    );
    assert_eq!(milli_to_qty(stock_of(&r.conn, r.zhonghua).0), "100", "货回来了");
}

#[test]
fn 退货入库用原单快照中途进过货也不受影响() {
    let mut r = reversal_shop();
    let sale = cash_sale(&mut r, "2026-09-19", "2");

    let zhonghua = r.zhonghua;
    do_receive(
        &mut r.conn,
        json!({
            "bizDate": "2026-09-20",
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "10", "unitCostYuan": "600" }],
        }),
    )
    .unwrap();

    do_return(&mut r.conn, sale.sale_id, json!({ "bizDate": "2026-09-25" })).unwrap();

    let cost: i64 = r
        .conn
        .query_row(
            "SELECT unit_cost_base_e4 FROM stock_movements WHERE type='return' ORDER BY id DESC LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(e4_to_yuan(cost), "52.0000", "取原单快照，不是当前均价");
}

#[test]
fn 部分退只退一半() {
    let mut r = reversal_shop();
    let sale = cash_sale(&mut r, "2026-09-19", "2");
    let zhonghua = r.zhonghua;

    let out = do_return(
        &mut r.conn,
        sale.sale_id,
        json!({ "bizDate": "2026-09-25", "items": [{ "productId": zhonghua, "qty": "1" }] }),
    )
    .unwrap();

    assert_eq!(cents_to_yuan(out.refund_cents), "550.00");
    assert_eq!(
        milli_to_qty(stock_of(&r.conn, zhonghua).0),
        "90",
        "退回 1 条 = 10 包"
    );
}

#[test]
fn 退超原单数量直接拒绝() {
    let mut r = reversal_shop();
    let sale = cash_sale(&mut r, "2026-09-19", "2");
    let zhonghua = r.zhonghua;

    do_return(
        &mut r.conn,
        sale.sale_id,
        json!({ "bizDate": "2026-09-25", "items": [{ "productId": zhonghua, "qty": "1" }] }),
    )
    .unwrap();

    let e = err_of(do_return(
        &mut r.conn,
        sale.sale_id,
        json!({ "bizDate": "2026-09-26", "items": [{ "productId": zhonghua, "qty": "2" }] }),
    ));
    assert!(e.contains("超过原单"), "{e}");
}

#[test]
fn 作废过的单无货可退() {
    let mut r = reversal_shop();
    let sale = cash_sale(&mut r, "2026-09-19", "1");
    do_void_sale(&mut r.conn, sale.sale_id).unwrap();

    let e = err_of(do_return(
        &mut r.conn,
        sale.sale_id,
        json!({ "bizDate": "2026-09-25" }),
    ));
    assert!(e.contains("无货可退"), "{e}");
}

#[test]
fn 挂账单退货欠款相应减少() {
    let mut r = reversal_shop();
    let (zhonghua, laowang) = (r.zhonghua, r.laowang);

    let sale = do_checkout(
        &mut r.conn,
        json!({
            "bizDate": "2026-09-19", "settleType": "credit", "customerId": laowang,
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "2", "unitPriceYuan": "550" }],
        }),
    )
    .unwrap();
    assert_eq!(
        cents_to_yuan(debt(&r.conn, laowang).net_debt_cents),
        "1100.00"
    );

    do_return(
        &mut r.conn,
        sale.sale_id,
        json!({ "bizDate": "2026-09-25", "items": [{ "productId": zhonghua, "qty": "1" }] }),
    )
    .unwrap();

    assert_eq!(cents_to_yuan(debt(&r.conn, laowang).net_debt_cents), "550.00");
}

#[test]
fn 作废进货单库存扣回均价还原() {
    let mut r = reversal_shop();
    let zhonghua = r.zhonghua;
    do_receive(
        &mut r.conn,
        json!({
            "bizDate": "2026-09-10",
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "5", "unitCostYuan": "600" }],
        }),
    )
    .unwrap();
    let purchase_id: i64 = r
        .conn
        .query_row("SELECT id FROM purchases ORDER BY id DESC LIMIT 1", [], |r| r.get(0))
        .unwrap();

    do_void_purchase(&mut r.conn, purchase_id).unwrap();

    let (qty, cost) = stock_of(&r.conn, zhonghua);
    assert_eq!(milli_to_qty(qty), "100");
    // 加权平均**不是无损可逆**的：进货时 82,000,000/150 除不尽，
    // 舍入的那 0.33 在撤回时会放大成 1 个 e4 单位（0.0001 元/包）。
    // 这是算法固有性质，不是 bug —— 误差上限就是 1 个 e4，且下次进货会覆盖掉
    assert!(
        (cost - 520_000).abs() <= 1,
        "均价应回到 52 附近，实际 {}",
        e4_to_yuan(cost)
    );
}

#[test]
fn 作废进货反算出负成本时归零并告警() {
    // 触发条件：贵货进来后大半已卖掉（库存总值被抽走），此时才发现那张进货单录错。
    // 用另一个商品，避开打底的那批中华
    let mut r = reversal_shop();
    let mao = insert_product(
        &r.conn,
        "INSERT INTO products (name, category, base_unit) VALUES ('茅台', 'liquor', '瓶')",
    );

    do_receive(
        &mut r.conn,
        json!({ "bizDate": "2026-09-01", "items": [{ "productId": mao, "unit": "base", "qty": "10", "unitCostYuan": "100" }] }),
    )
    .unwrap();
    let pricey: i64 = r
        .conn
        .query_row("SELECT id FROM purchases ORDER BY id DESC LIMIT 1", [], |r| r.get(0))
        .unwrap();

    // 卖掉 9 瓶，库存总值从 1000 掉到 100
    do_checkout(
        &mut r.conn,
        json!({
            "bizDate": "2026-09-05", "settleType": "cash",
            "items": [{ "productId": mao, "unit": "base", "qty": "9", "unitPriceYuan": "150" }],
        }),
    )
    .unwrap();
    // 再进一批便宜的
    do_receive(
        &mut r.conn,
        json!({ "bizDate": "2026-09-06", "items": [{ "productId": mao, "unit": "base", "qty": "100", "unitCostYuan": "1" }] }),
    )
    .unwrap();

    // 撤那张 1000 块的进货单：库存总值只有约 200，减 1000 必为负
    let out = do_void_purchase(&mut r.conn, pricey).unwrap();
    assert!(
        !out.warnings.is_empty(),
        "必须告警，否则后续毛利全错且无人察觉"
    );

    assert_eq!(stock_of(&r.conn, mao).1, 0, "绝不写入负成本");
}

#[test]
fn 作废进货不回溯修改历史成本快照() {
    let mut r = reversal_shop();
    let sale = cash_sale(&mut r, "2026-09-05", "1");

    let before: i64 = r
        .conn
        .query_row(
            "SELECT cost_amount_cents FROM sales WHERE id = ?1",
            [sale.sale_id],
            |r| r.get(0),
        )
        .unwrap();

    let purchase_id: i64 = r
        .conn
        .query_row("SELECT id FROM purchases ORDER BY id LIMIT 1", [], |r| r.get(0))
        .unwrap();
    do_void_purchase(&mut r.conn, purchase_id).unwrap();

    let after: i64 = r
        .conn
        .query_row(
            "SELECT cost_amount_cents FROM sales WHERE id = ?1",
            [sale.sale_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        after, before,
        "上个月的利润不能因为今天的作废而变（红线 3）"
    );
}

#[test]
fn 作废收款后欠款回到作废前的数字() {
    let mut r = reversal_shop();
    let (zhonghua, laowang) = (r.zhonghua, r.laowang);

    do_checkout(
        &mut r.conn,
        json!({
            "bizDate": "2026-09-01", "settleType": "credit", "customerId": laowang,
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "2", "unitPriceYuan": "550" }],
        }),
    )
    .unwrap();
    let p = do_collect(
        &mut r.conn,
        json!({ "bizDate": "2026-09-10", "customerId": laowang, "amountYuan": "600", "method": "cash" }),
    )
    .unwrap();
    assert_eq!(cents_to_yuan(debt(&r.conn, laowang).net_debt_cents), "500.00");

    do_void_payment(&mut r.conn, p.payment_id).unwrap();

    assert_eq!(
        cents_to_yuan(debt(&r.conn, laowang).net_debt_cents),
        "1100.00"
    );
    let left: i64 = r
        .conn
        .query_row(
            "SELECT count(*) FROM payment_allocations WHERE payment_id = ?1",
            [p.payment_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(left, 0, "作废的收款不该还留着核销记录");
}

#[test]
fn 同一笔收款不能作废两次() {
    let mut r = reversal_shop();
    let (zhonghua, laowang) = (r.zhonghua, r.laowang);

    do_checkout(
        &mut r.conn,
        json!({
            "bizDate": "2026-09-01", "settleType": "credit", "customerId": laowang,
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "1", "unitPriceYuan": "550" }],
        }),
    )
    .unwrap();
    let p = do_collect(
        &mut r.conn,
        json!({ "bizDate": "2026-09-10", "customerId": laowang, "amountYuan": "100", "method": "cash" }),
    )
    .unwrap();
    do_void_payment(&mut r.conn, p.payment_id).unwrap();

    let e = err_of(do_void_payment(&mut r.conn, p.payment_id));
    assert!(e.contains("已经作废过"), "{e}");
}
