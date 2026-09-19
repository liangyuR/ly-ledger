//! 走一遍真实业务：进货、销售、挂账、收款、预收，外加入参防线。

use super::*;

// ═══════════════════ 一笔进货 + 两笔销售 ═══════════════════

struct Shop {
    conn: Connection,
    zhonghua: i64,
    laowang: i64,
}

fn shop() -> Shop {
    let conn = open_memory().unwrap();
    let zhonghua = insert_product(
        &conn,
        "INSERT INTO products (name, pinyin_full, pinyin_abbr, category, brand, base_unit,
                               pack_unit, pack_ratio, price_base_cents, price_pack_cents)
         VALUES ('中华(硬)', 'zhonghuaying', 'zhy', 'cigarette', '中华', '包', '条', 10, 5700, 55000)",
    );
    conn.execute(
        "INSERT INTO customers (name, pinyin_abbr) VALUES ('老王', 'lw')",
        [],
    )
    .unwrap();
    let laowang = conn.last_insert_rowid();

    Shop {
        conn,
        zhonghua,
        laowang,
    }
}

#[test]
fn 进十条中华库存变成一百包成本五十二() {
    let mut s = shop();
    let r = do_receive(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-19",
            "items": [{ "productId": s.zhonghua, "unit": "pack", "qty": "10", "unitCostYuan": "520" }],
        }),
    )
    .unwrap();

    assert_eq!(cents_to_yuan(r.total_cents), "5200.00");

    let (qty, cost) = stock_of(&s.conn, s.zhonghua);
    // 单位换算：10 条 = 100 包
    assert_eq!(milli_to_qty(qty), "100");
    // 520 / 10 = 52.0000
    assert_eq!(e4_to_yuan(cost), "52.0000");
}

#[test]
fn 卖两条再卖一包四个数字都要对() {
    let mut s = shop();
    do_receive(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-19",
            "items": [{ "productId": s.zhonghua, "unit": "pack", "qty": "10", "unitCostYuan": "520" }],
        }),
    )
    .unwrap();

    let s1 = do_checkout(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-19",
            "settleType": "cash",
            "items": [{ "productId": s.zhonghua, "unit": "pack", "qty": "2", "unitPriceYuan": "550" }],
        }),
    )
    .unwrap();

    let s2 = do_checkout(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-19",
            "settleType": "cash",
            "items": [{ "productId": s.zhonghua, "unit": "base", "qty": "1", "unitPriceYuan": "57" }],
        }),
    )
    .unwrap();

    // ① 金额
    assert_eq!(cents_to_yuan(s1.total_cents), "1100.00");
    assert_eq!(cents_to_yuan(s2.total_cents), "57.00");

    // ② 毛利：整条成本 2×10×52 = 1040，单包成本 52
    assert_eq!(cents_to_yuan(s1.gross_profit_cents), "60.00");
    assert_eq!(cents_to_yuan(s2.gross_profit_cents), "5.00");

    // ③ 结存：100 − 20 − 1 = 79 包
    let (qty, cost) = stock_of(&s.conn, s.zhonghua);
    assert_eq!(milli_to_qty(qty), "79");
    assert_eq!(e4_to_yuan(cost), "52.0000", "销售不改均价");

    // ④ 流水完整：3 条，且结存快照 == 流水重算
    let moves: Vec<(String, String, String)> = {
        let mut stmt = s
            .conn
            .prepare(
                "SELECT type, qty_base_milli, balance_after_milli
                   FROM stock_movements WHERE product_id = ?1 ORDER BY id",
            )
            .unwrap();
        let rows = stmt
            .query_map([s.zhonghua], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    milli_to_qty(r.get::<_, i64>(1)?),
                    milli_to_qty(r.get::<_, i64>(2)?),
                ))
            })
            .unwrap();
        rows.map(|r| r.unwrap()).collect()
    };

    assert_eq!(
        moves,
        vec![
            ("purchase".into(), "100".into(), "100".into()),
            ("sale".into(), "-20".into(), "80".into()),
            ("sale".into(), "-1".into(), "79".into()),
        ]
    );
    assert_eq!(
        recompute_qty_from_movements(&s.conn, s.zhonghua).unwrap(),
        qty,
        "结存快照必须等于流水重算 —— 不等就说明有人绕过了 record_movement"
    );
}

#[test]
fn 两次不同价进货后的加权成本() {
    let mut s = shop();
    do_receive(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-01",
            "items": [{ "productId": s.zhonghua, "unit": "pack", "qty": "10", "unitCostYuan": "520" }],
        }),
    )
    .unwrap();
    do_receive(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-10",
            "items": [{ "productId": s.zhonghua, "unit": "pack", "qty": "5", "unitCostYuan": "533" }],
        }),
    )
    .unwrap();

    // (100×52 + 50×53.3) / 150 = 52.4333...
    let (_, cost) = stock_of(&s.conn, s.zhonghua);
    assert_eq!(e4_to_yuan(cost), "52.4333");
}

#[test]
fn 没进货就卖库存变负照样记账() {
    // 红线 1：不拦路，只标红
    let mut s = shop();
    let r = do_checkout(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-19",
            "settleType": "cash",
            "items": [{ "productId": s.zhonghua, "unit": "pack", "qty": "1", "unitPriceYuan": "550" }],
        }),
    )
    .unwrap();

    assert_eq!(cents_to_yuan(r.total_cents), "550.00");
    let (qty, _) = stock_of(&s.conn, s.zhonghua);
    assert_eq!(milli_to_qty(qty), "-10", "不拦路，只让它变负");
}

#[test]
fn 抹零吃进毛利不动单价() {
    let mut s = shop();
    do_receive(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-19",
            "items": [{ "productId": s.zhonghua, "unit": "pack", "qty": "10", "unitCostYuan": "520" }],
        }),
    )
    .unwrap();

    let r = do_checkout(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-19",
            "settleType": "cash",
            "discountYuan": "30",
            "items": [{ "productId": s.zhonghua, "unit": "pack", "qty": "2", "unitPriceYuan": "550" }],
        }),
    )
    .unwrap();

    assert_eq!(cents_to_yuan(r.total_cents), "1070.00");
    assert_eq!(
        cents_to_yuan(r.gross_profit_cents),
        "30.00",
        "让掉的 30 直接从毛利里出"
    );

    let price: i64 = s
        .conn
        .query_row(
            "SELECT unit_price_cents FROM sale_items WHERE sale_id = ?1",
            [r.sale_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(cents_to_yuan(price), "550.00", "单价不能被抹零污染");
}

// ═══════════════════ 挂账、收款与预收 ═══════════════════

fn stock_up(s: &mut Shop) {
    do_receive(
        &mut s.conn,
        json!({
            "bizDate": "2026-08-01",
            "items": [{ "productId": s.zhonghua, "unit": "pack", "qty": "20", "unitCostYuan": "520" }],
        }),
    )
    .unwrap();
}

fn credit_sale(s: &mut Shop, biz_date: &str, qty: &str) {
    let (zhonghua, laowang) = (s.zhonghua, s.laowang);
    do_checkout(
        &mut s.conn,
        json!({
            "bizDate": biz_date,
            "settleType": "credit",
            "customerId": laowang,
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": qty, "unitPriceYuan": "550" }],
        }),
    )
    .unwrap();
}

#[test]
fn 挂账收款后按先进先出自动核销() {
    let mut s = shop();
    stock_up(&mut s);
    credit_sale(&mut s, "2026-08-05", "2");
    credit_sale(&mut s, "2026-09-01", "1");

    let d = debt(&s.conn, s.laowang);
    assert_eq!(cents_to_yuan(d.net_debt_cents), "1650.00");
    assert_eq!(d.earliest_unpaid_date.as_deref(), Some("2026-08-05"));

    let laowang = s.laowang;
    let r = do_collect(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-10",
            "customerId": laowang,
            "amountYuan": "1100",
            "method": "cash",
        }),
    )
    .unwrap();

    assert_eq!(r.prepaid_cents, 0);
    let d = debt(&s.conn, s.laowang);
    assert_eq!(cents_to_yuan(d.net_debt_cents), "550.00");
    assert_eq!(
        d.earliest_unpaid_date.as_deref(),
        Some("2026-09-01"),
        "最早那张已结清，账龄前移"
    );
}

#[test]
fn 收多了余额成为预收净欠款为负() {
    let mut s = shop();
    stock_up(&mut s);
    credit_sale(&mut s, "2026-08-05", "2");

    let laowang = s.laowang;
    let r = do_collect(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-10",
            "customerId": laowang,
            "amountYuan": "1200",
            "method": "wechat",
        }),
    )
    .unwrap();

    assert_eq!(cents_to_yuan(r.prepaid_cents), "100.00");
    assert_eq!(
        cents_to_yuan(r.debt.net_debt_cents),
        "-100.00",
        "负数即预收"
    );
    assert_eq!(r.debt.earliest_unpaid_date, None);
}

#[test]
fn 部分付是一张挂账单加一笔同日收款() {
    let mut s = shop();
    stock_up(&mut s);

    let (zhonghua, laowang) = (s.zhonghua, s.laowang);
    let r = do_checkout(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-19",
            "settleType": "credit",
            "customerId": laowang,
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "2", "unitPriceYuan": "550" }],
            "partialPay": { "amountYuan": "300", "method": "cash" },
        }),
    )
    .unwrap();

    let payment_id = r.payment_id.expect("部分付应产生一笔收款记录");

    assert_eq!(
        cents_to_yuan(debt(&s.conn, s.laowang).net_debt_cents),
        "800.00",
        "1100 − 300"
    );

    let allocated: i64 = s
        .conn
        .query_row(
            "SELECT COALESCE(SUM(amount_cents), 0) FROM payment_allocations WHERE payment_id = ?1",
            [payment_id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        cents_to_yuan(allocated),
        "300.00",
        "这 300 当场核销掉本单，不用再去收款页录一遍"
    );
}

#[test]
fn 补录一张更早的挂账单核销顺序跟着重算() {
    let mut s = shop();
    stock_up(&mut s);

    credit_sale(&mut s, "2026-09-01", "1");
    let laowang = s.laowang;
    do_collect(
        &mut s.conn,
        json!({ "bizDate": "2026-09-10", "customerId": laowang, "amountYuan": "550", "method": "cash" }),
    )
    .unwrap();

    // 此时无欠款
    assert_eq!(debt(&s.conn, s.laowang).net_debt_cents, 0);

    // 老板想起来 8 月 5 日还有一笔漏记的
    credit_sale(&mut s, "2026-08-05", "1");

    let d = debt(&s.conn, s.laowang);
    assert_eq!(cents_to_yuan(d.net_debt_cents), "550.00");
    // 那 550 的收款现在应该核销到更早的 8-05 那张上，未结清的变成 9-01 那张
    assert_eq!(
        d.earliest_unpaid_date.as_deref(),
        Some("2026-09-01"),
        "账龄按重算后的顺序，不是按收款发生的顺序"
    );
}

// ═══════════════════ 入参防线 ═══════════════════

#[test]
fn 现金单不能挂客户() {
    let mut s = shop();
    let (zhonghua, laowang) = (s.zhonghua, s.laowang);
    let e = err_of(do_checkout(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-19",
            "settleType": "cash",
            "customerId": laowang,
            "items": [{ "productId": zhonghua, "unit": "base", "qty": "1", "unitPriceYuan": "57" }],
        }),
    ));
    assert!(e.contains("现金单不能挂客户"), "{e}");
}

#[test]
fn 挂账必须指定客户() {
    let mut s = shop();
    let zhonghua = s.zhonghua;
    let e = err_of(do_checkout(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-19",
            "settleType": "credit",
            "items": [{ "productId": zhonghua, "unit": "base", "qty": "1", "unitPriceYuan": "57" }],
        }),
    ));
    assert!(e.contains("挂账必须指定客户"), "{e}");
}

#[test]
fn 部分付只能配挂账() {
    let mut s = shop();
    let zhonghua = s.zhonghua;
    let e = err_of(do_checkout(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-19",
            "settleType": "cash",
            "items": [{ "productId": zhonghua, "unit": "base", "qty": "1", "unitPriceYuan": "57" }],
            "partialPay": { "amountYuan": "10", "method": "cash" },
        }),
    ));
    assert!(e.contains("部分付属于挂账"), "{e}");
}

#[test]
fn 收款金额为负直接拒绝() {
    let mut s = shop();
    let laowang = s.laowang;
    let e = err_of(do_collect(
        &mut s.conn,
        json!({ "bizDate": "2026-09-19", "customerId": laowang, "amountYuan": "-100", "method": "cash" }),
    ));
    assert!(e.contains("必须为正"), "{e}");
}

#[test]
fn 失败的结账不留半张单() {
    let mut s = shop();
    let before = count(&s.conn, "SELECT count(*) FROM sales");
    let zhonghua = s.zhonghua;

    let r = do_checkout(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-19",
            "settleType": "cash",
            "items": [
                { "productId": zhonghua, "unit": "base", "qty": "1", "unitPriceYuan": "57" },
                { "productId": 999999,   "unit": "base", "qty": "1", "unitPriceYuan": "57" },
            ],
        }),
    );
    assert!(r.is_err());

    assert_eq!(
        count(&s.conn, "SELECT count(*) FROM sales"),
        before,
        "整个事务回滚，不留幽灵记录"
    );
}
