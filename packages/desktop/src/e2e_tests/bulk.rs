//! 论斤卖的商品 —— 茶叶。
//!
//! 烟酒的数量永远是整数：一包、两条、三瓶。茶叶不是 —— 抓半斤、称二两是常态，
//! 盘点表上直接写着「白牡丹 8.9 斤」。数量一旦带小数，两件事会一起出问题：
//! 结存对不上（截断成 8），毛利算错（按 8 斤扣成本，少扣 0.9 斤）。
//!
//! 数字全部取自店里那张人工盘点表，对不上就是软件算错了，不是测试写错了。

use super::*;

/// 一个只卖茶的柜台。茶叶没有大小包装，一个单位到底
fn tea(conn: &Connection, name: &str, unit: &str) -> i64 {
    insert_product(
        conn,
        &format!(
            "INSERT INTO products (name, category, base_unit, pack_ratio)
             VALUES ('{name}', 'other', '{unit}', 1)"
        ),
    )
}

// ═══════════════════ 小数数量 ═══════════════════

#[test]
fn 按斤进货八点九斤结存就是八点九斤() {
    // 盘点表：白牡丹 150 元/斤 × 8.9 斤 = 1335
    let mut conn = open_memory().unwrap();
    let 白牡丹 = tea(&conn, "白牡丹", "斤");

    let r = do_receive(
        &mut conn,
        json!({
            "bizDate": "2026-09-19",
            "items": [{ "productId": 白牡丹, "unit": "base", "qty": "8.9", "unitCostYuan": "150" }],
        }),
    )
    .unwrap();

    assert_eq!(cents_to_yuan(r.total_cents), "1335.00", "对得上盘点表那一行");

    let (qty, cost) = stock_of(&conn, 白牡丹);
    assert_eq!(milli_to_qty(qty), "8.9", "不能截断成 8");
    assert_eq!(e4_to_yuan(cost), "150.0000");
}

#[test]
fn 卖半斤扣的就是半斤的货和半斤的成本() {
    let mut conn = open_memory().unwrap();
    let 白牡丹 = tea(&conn, "白牡丹", "斤");
    do_receive(
        &mut conn,
        json!({
            "bizDate": "2026-09-19",
            "items": [{ "productId": 白牡丹, "unit": "base", "qty": "8.9", "unitCostYuan": "150" }],
        }),
    )
    .unwrap();

    let sale = do_checkout(
        &mut conn,
        json!({
            "bizDate": "2026-09-19",
            "settleType": "cash",
            "items": [{ "productId": 白牡丹, "unit": "base", "qty": "0.5", "unitPriceYuan": "200" }],
        }),
    )
    .unwrap();

    assert_eq!(cents_to_yuan(sale.total_cents), "100.00");
    // 成本 0.5 × 150 = 75，毛利 25。按整斤扣会变成亏 50，按零扣会变成赚 100
    assert_eq!(cents_to_yuan(sale.gross_profit_cents), "25.00");
    assert_eq!(milli_to_qty(stock_of(&conn, 白牡丹).0), "8.4");
}

#[test]
fn 称二两也算得清() {
    // 0.2 斤 × 260 = 52。这种零头最容易被四舍五入吃掉
    let mut conn = open_memory().unwrap();
    let 茉莉银针 = tea(&conn, "茉莉银针", "斤");
    do_receive(
        &mut conn,
        json!({
            "bizDate": "2026-09-19",
            "items": [{ "productId": 茉莉银针, "unit": "base", "qty": "8", "unitCostYuan": "260" }],
        }),
    )
    .unwrap();

    let sale = do_checkout(
        &mut conn,
        json!({
            "bizDate": "2026-09-19",
            "settleType": "cash",
            "items": [{ "productId": 茉莉银针, "unit": "base", "qty": "0.2", "unitPriceYuan": "400" }],
        }),
    )
    .unwrap();

    assert_eq!(cents_to_yuan(sale.total_cents), "80.00");
    assert_eq!(cents_to_yuan(sale.gross_profit_cents), "28.00", "成本 0.2 × 260 = 52");
    assert_eq!(milli_to_qty(stock_of(&conn, 茉莉银针).0), "7.8");
}

// ═══════════════════ 小数进价 ═══════════════════

#[test]
fn 进价带两位小数三十瓶也不差一分() {
    // 盘点表：金质5 153.33 元/瓶 × 30 瓶 = 4599.90
    let mut conn = open_memory().unwrap();
    let 金质5 = tea(&conn, "金质5", "瓶");

    let r = do_receive(
        &mut conn,
        json!({
            "bizDate": "2026-09-19",
            "items": [{ "productId": 金质5, "unit": "base", "qty": "30", "unitCostYuan": "153.33" }],
        }),
    )
    .unwrap();

    assert_eq!(cents_to_yuan(r.total_cents), "4599.90");
    assert_eq!(e4_to_yuan(stock_of(&conn, 金质5).1), "153.3300");
}

// ═══════════════════ 茶叶那些单位 ═══════════════════

#[test]
fn 饼套罐桶都能当单位用() {
    // 单位是自由文本，不是枚举 —— 枚举的话每进一个新品类就要改一次代码
    let mut conn = open_memory().unwrap();
    for (name, unit, qty, cost) in [
        ("老白茶", "饼", "16", "65"),
        ("古树红茶", "套", "5", "100"),
        ("宝福林", "罐", "4", "230"),
        ("小青柑", "桶", "6", "150"),
        ("大红袍", "盒", "20", "65"),
    ] {
        let id = tea(&conn, name, unit);
        do_receive(
            &mut conn,
            json!({
                "bizDate": "2026-09-19",
                "items": [{ "productId": id, "unit": "base", "qty": qty, "unitCostYuan": cost }],
            }),
        )
        .unwrap();
        assert_eq!(milli_to_qty(stock_of(&conn, id).0), qty, "{name} 按{unit}记");
    }
}

#[test]
fn 一张单里烟酒茶混着卖() {
    // 柜台上本来就是混的：一包烟、一瓶酒、半斤茶，一次结清
    let mut conn = open_memory().unwrap();
    let 中华 = tea(&conn, "中华", "盒");
    let 金质5 = tea(&conn, "金质5", "瓶");
    let 茉莉云螺 = tea(&conn, "茉莉云螺", "斤");

    for (id, qty, cost) in [(中华, "35", "40"), (金质5, "30", "153.33"), (茉莉云螺, "10", "65")] {
        do_receive(
            &mut conn,
            json!({
                "bizDate": "2026-09-19",
                "items": [{ "productId": id, "unit": "base", "qty": qty, "unitCostYuan": cost }],
            }),
        )
        .unwrap();
    }

    let sale = do_checkout(
        &mut conn,
        json!({
            "bizDate": "2026-09-20",
            "settleType": "cash",
            "items": [
                { "productId": 中华, "unit": "base", "qty": "1", "unitPriceYuan": "50" },
                { "productId": 金质5, "unit": "base", "qty": "1", "unitPriceYuan": "200" },
                { "productId": 茉莉云螺, "unit": "base", "qty": "0.5", "unitPriceYuan": "100" },
            ],
        }),
    )
    .unwrap();

    assert_eq!(cents_to_yuan(sale.total_cents), "300.00");
    // 成本 40 + 153.33 + 32.50 = 225.83
    assert_eq!(cents_to_yuan(sale.gross_profit_cents), "74.17");
    assert_eq!(milli_to_qty(stock_of(&conn, 茉莉云螺).0), "9.5");
}
