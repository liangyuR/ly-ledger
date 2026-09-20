//! 常用商品 —— 卖货页那排数字键直选格子。
//!
//! 这排格子的承诺是「你最近常卖的就在这儿」。承诺一旦不兑现，老板会回去用
//! 搜索框，而且不会报告 —— 排序错了不报错、不留痕，只是慢慢没人用。
//! 所以口径必须钉死：作废的不算，三十天以前的不算。

use super::*;

use crate::services::reports::frequent_products;

fn frequent(conn: &Connection) -> Vec<crate::services::reports::FrequentProduct> {
    frequent_products(conn, 12).unwrap()
}

fn names(rows: &[crate::services::reports::FrequentProduct]) -> Vec<&str> {
    rows.iter().map(|r| r.name.as_str()).collect()
}

fn sold_of(conn: &Connection, id: i64) -> i64 {
    frequent(conn).into_iter().find(|r| r.id == id).unwrap().sold_qty_milli
}

fn new_product(conn: &Connection, name: &str) -> i64 {
    insert_product(
        conn,
        &format!(
            "INSERT INTO products (name, category, base_unit, pack_unit, pack_ratio)
             VALUES ('{name}', 'cigarette', '包', '条', 10)"
        ),
    )
}

/// 日期一律从库里算，不写死 —— 写死的「三十天前」会在某个真实的日子变成第 29 天。
fn days_ago(conn: &Connection, n: i64) -> String {
    conn.query_row(
        "SELECT date('now', 'localtime', ?1)",
        [format!("-{n} day")],
        |r| r.get(0),
    )
    .unwrap()
}

/// 备货 + 卖一笔现金单。
fn sell(conn: &mut Connection, id: i64, date: &str, qty: &str) -> i64 {
    do_receive(
        conn,
        json!({
            "bizDate": date,
            "items": [{ "productId": id, "unit": "pack", "qty": "10", "unitCostYuan": "500" }],
        }),
    )
    .unwrap();
    do_checkout(
        conn,
        json!({
            "bizDate": date, "settleType": "cash",
            "items": [{ "productId": id, "unit": "base", "qty": qty, "unitPriceYuan": "60" }],
        }),
    )
    .unwrap()
    .sale_id
}

// ═══════════════════ 口径 ═══════════════════

#[test]
fn 作废掉的单不算销量() {
    let mut conn = open_memory().unwrap();
    let id = new_product(&conn, "中华(硬)");
    let today = days_ago(&conn, 0);
    let sale = sell(&mut conn, id, &today, "5");
    assert_eq!(sold_of(&conn, id), 5_000, "作废之前先确认它本来算数");

    do_void_sale(&mut conn, sale).unwrap();

    assert_eq!(sold_of(&conn, id), 0, "作废的单不该还撑着它排在前面");
}

#[test]
fn 三十天以前卖的不算常用() {
    let mut conn = open_memory().unwrap();
    let id = new_product(&conn, "玉溪");
    let 上个季度 = days_ago(&conn, 40);
    sell(&mut conn, id, &上个季度, "9");

    assert_eq!(sold_of(&conn, id), 0);
}

#[test]
fn 正好卡在三十天边界上的还算() {
    // 口径是 >= 三十天前那一天，边界这一天算在里面
    let mut conn = open_memory().unwrap();
    let id = new_product(&conn, "利群");
    let 边界 = days_ago(&conn, 30);
    sell(&mut conn, id, &边界, "3");

    assert_eq!(sold_of(&conn, id), 3_000);
}

// ═══════════════════ 排序 ═══════════════════

#[test]
fn 陈年爆款压不住最近常卖的() {
    // 这是口径写错时唯一看得见的症状：数字对不对没人看，格子的顺序天天在眼前
    let mut conn = open_memory().unwrap();
    let 年货 = new_product(&conn, "礼盒装");
    let 香烟 = new_product(&conn, "中华(硬)");

    let 去年 = days_ago(&conn, 300);
    let 今天 = days_ago(&conn, 0);
    sell(&mut conn, 年货, &去年, "9");
    sell(&mut conn, 香烟, &今天, "1");

    assert_eq!(names(&frequent(&conn)), vec!["中华(硬)", "礼盒装"]);
}

#[test]
fn 一笔没卖过也要把格子填满() {
    // 新店没有销量时退回建档顺序 —— 不能给老板一排空格子
    let conn = open_memory().unwrap();
    new_product(&conn, "中华(硬)");
    new_product(&conn, "玉溪");

    let rows = frequent(&conn);
    assert_eq!(names(&rows), vec!["中华(硬)", "玉溪"]);
    assert!(rows.iter().all(|r| r.sold_qty_milli == 0));
}
