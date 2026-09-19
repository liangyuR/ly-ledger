//! 售价回写 + 零成本毛利标注。
//!
//! 这两件事是启用向导的配套：向导承诺「卖到时当场填一个，软件会记住」，
//! 又允许跳过期初库存（跳过就会出现零成本毛利）。承诺和代价都得兑现。

use super::*;

use crate::services::profit_reports::{cost_unknown_alert, product_ranking};

struct Counter {
    conn: Connection,
    zhonghua: i64,
}

fn counter() -> Counter {
    let conn = open_memory().unwrap();
    let zhonghua = insert_product(
        &conn,
        "INSERT INTO products (name, category, base_unit, pack_unit, pack_ratio)
         VALUES ('中华(硬)', 'cigarette', '包', '条', 10)",
    );
    Counter { conn, zhonghua }
}

/// (单包价, 整条价)，单位分。
fn price_of(conn: &Connection, id: i64) -> (Option<i64>, Option<i64>) {
    conn.query_row(
        "SELECT price_base_cents, price_pack_cents FROM products WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .unwrap()
}

// ═══════════════════ 售价回写 ═══════════════════

#[test]
fn 卖一次就记住下次不用再输() {
    let mut c = counter();
    assert_eq!(price_of(&c.conn, c.zhonghua).1, None, "一开始没价");

    let zhonghua = c.zhonghua;
    do_checkout(
        &mut c.conn,
        json!({
            "bizDate": "2026-09-19", "settleType": "cash",
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "1", "unitPriceYuan": "550" }],
        }),
    )
    .unwrap();

    assert_eq!(price_of(&c.conn, zhonghua).1, Some(55000));
}

#[test]
fn 整条价和单包价各记各的互不覆盖() {
    let mut c = counter();
    let zhonghua = c.zhonghua;
    do_checkout(
        &mut c.conn,
        json!({
            "bizDate": "2026-09-19", "settleType": "cash",
            "items": [
                { "productId": zhonghua, "unit": "pack", "qty": "1", "unitPriceYuan": "550" },
                { "productId": zhonghua, "unit": "base", "qty": "1", "unitPriceYuan": "57" },
            ],
        }),
    )
    .unwrap();

    let (base, pack) = price_of(&c.conn, zhonghua);
    assert_eq!(pack, Some(55000), "整条 550");
    assert_eq!(base, Some(5700), "单包 57，不是 55");
}

#[test]
fn 改价了就跟着改() {
    let mut c = counter();
    let zhonghua = c.zhonghua;
    for yuan in ["550", "570"] {
        do_checkout(
            &mut c.conn,
            json!({
                "bizDate": "2026-09-19", "settleType": "cash",
                "items": [{ "productId": zhonghua, "unit": "pack", "qty": "1", "unitPriceYuan": yuan }],
            }),
        )
        .unwrap();
    }
    assert_eq!(price_of(&c.conn, zhonghua).1, Some(57000));
}

// 让利走抹零，不动单价 —— 否则一次让利会把默认价永久改低
#[test]
fn 抹零不改商品售价() {
    let mut c = counter();
    let zhonghua = c.zhonghua;
    do_checkout(
        &mut c.conn,
        json!({
            "bizDate": "2026-09-19", "settleType": "cash", "discountYuan": "50",
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "1", "unitPriceYuan": "550" }],
        }),
    )
    .unwrap();
    assert_eq!(
        price_of(&c.conn, zhonghua).1,
        Some(55000),
        "记住的是 550，不是抹零后的 500"
    );
}

#[test]
fn 改单把输错的价一起改回来() {
    let mut c = counter();
    let zhonghua = c.zhonghua;
    let s = do_checkout(
        &mut c.conn,
        json!({
            "bizDate": "2026-09-19", "settleType": "cash",
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "1", "unitPriceYuan": "55" }],
        }),
    )
    .unwrap();
    assert_eq!(price_of(&c.conn, zhonghua).1, Some(5500), "先被错价污染了");

    do_revise(
        &mut c.conn,
        s.sale_id,
        json!({
            "bizDate": "2026-09-19", "settleType": "cash",
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "1", "unitPriceYuan": "550" }],
        }),
    )
    .unwrap();
    assert_eq!(
        price_of(&c.conn, zhonghua).1,
        Some(55000),
        "改单是纠正错价的正路，价也得跟着正回来"
    );
}

#[test]
fn 退货不动售价() {
    let mut c = counter();
    let zhonghua = c.zhonghua;
    let s = do_checkout(
        &mut c.conn,
        json!({
            "bizDate": "2026-09-19", "settleType": "cash",
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "2", "unitPriceYuan": "550" }],
        }),
    )
    .unwrap();
    do_return(&mut c.conn, s.sale_id, json!({ "bizDate": "2026-09-25" })).unwrap();
    assert_eq!(
        price_of(&c.conn, zhonghua).1,
        Some(55000),
        "退货是退货，不是改价"
    );
}

// ═══════════════════ 零成本毛利要标出来 ═══════════════════

#[test]
fn 没进过货就卖毛利等于全额售价() {
    let mut c = counter();
    let zhonghua = c.zhonghua;
    do_checkout(
        &mut c.conn,
        json!({
            "bizDate": "2026-09-19", "settleType": "cash",
            "items": [{ "productId": zhonghua, "unit": "base", "qty": "1", "unitPriceYuan": "57" }],
        }),
    )
    .unwrap();

    let rows = product_ranking(&c.conn, Some("2026-09"), 20).unwrap();
    assert_eq!(
        cents_to_yuan(rows[0].profit_cents),
        "57.00",
        "这就是那个虚高的数"
    );
    assert!(rows[0].cost_unknown, "虚高就必须标出来");
}

#[test]
fn 进过货的不标() {
    let mut c = counter();
    let zhonghua = c.zhonghua;
    do_receive(
        &mut c.conn,
        json!({
            "bizDate": "2026-09-01",
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "10", "unitCostYuan": "520" }],
        }),
    )
    .unwrap();
    do_checkout(
        &mut c.conn,
        json!({
            "bizDate": "2026-09-19", "settleType": "cash",
            "items": [{ "productId": zhonghua, "unit": "base", "qty": "1", "unitPriceYuan": "57" }],
        }),
    )
    .unwrap();

    let rows = product_ranking(&c.conn, Some("2026-09"), 20).unwrap();
    assert!(!rows[0].cost_unknown);
    assert_eq!(cents_to_yuan(rows[0].profit_cents), "5.00");
}

#[test]
fn 汇总说清是哪几个商品虚高了多少钱() {
    let mut c = counter();
    let zhonghua = c.zhonghua;
    let liqun = insert_product(
        &c.conn,
        "INSERT INTO products (name, category, base_unit) VALUES ('利群', 'cigarette', '包')",
    );

    do_checkout(
        &mut c.conn,
        json!({
            "bizDate": "2026-09-19", "settleType": "cash",
            "items": [
                { "productId": zhonghua, "unit": "base", "qty": "2", "unitPriceYuan": "57" },
                { "productId": liqun,    "unit": "base", "qty": "1", "unitPriceYuan": "23" },
            ],
        }),
    )
    .unwrap();

    let a = cost_unknown_alert(&c.conn, Some("2026-09")).unwrap();
    assert_eq!(a.product_count, 2);
    assert_eq!(cents_to_yuan(a.revenue_cents), "137.00");
    assert_eq!(
        a.names,
        vec!["中华(硬)".to_string(), "利群".to_string()],
        "按金额从大到小，好让老板知道哪个影响最大"
    );
}

// 下次进货就会校正 —— 这是向导里「跳过也能用」那句话的依据
#[test]
fn 进过货之后新卖的不再虚高() {
    let mut c = counter();
    let zhonghua = c.zhonghua;

    do_checkout(
        &mut c.conn,
        json!({
            "bizDate": "2026-09-19", "settleType": "cash",
            "items": [{ "productId": zhonghua, "unit": "base", "qty": "1", "unitPriceYuan": "57" }],
        }),
    )
    .unwrap();
    do_receive(
        &mut c.conn,
        json!({
            "bizDate": "2026-09-20",
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "10", "unitCostYuan": "520" }],
        }),
    )
    .unwrap();
    do_checkout(
        &mut c.conn,
        json!({
            "bizDate": "2026-09-21", "settleType": "cash",
            "items": [{ "productId": zhonghua, "unit": "base", "qty": "1", "unitPriceYuan": "57" }],
        }),
    )
    .unwrap();

    let a = cost_unknown_alert(&c.conn, Some("2026-09")).unwrap();
    assert_eq!(
        cents_to_yuan(a.revenue_cents),
        "57.00",
        "只有校正前那一笔还挂着"
    );
}

#[test]
fn 干净的账不报警() {
    let mut c = counter();
    let zhonghua = c.zhonghua;
    do_receive(
        &mut c.conn,
        json!({
            "bizDate": "2026-09-01",
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "10", "unitCostYuan": "520" }],
        }),
    )
    .unwrap();
    do_checkout(
        &mut c.conn,
        json!({
            "bizDate": "2026-09-19", "settleType": "cash",
            "items": [{ "productId": zhonghua, "unit": "base", "qty": "1", "unitPriceYuan": "57" }],
        }),
    )
    .unwrap();

    assert_eq!(
        cost_unknown_alert(&c.conn, Some("2026-09")).unwrap().product_count,
        0
    );
}
