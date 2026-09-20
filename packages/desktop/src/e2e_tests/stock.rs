//! 库存总览 —— 进货页进来先看见的那张表。
//!
//! 这张表只要排错一次，老板补货就会从头翻到尾，然后再也不看它。
//! 所以验的重点是排序的输入干不干净：作废的单、陈年老单都不该顶上来。

use super::*;

use crate::services::inventory::{stock_overview, StockLine};

fn overview(conn: &Connection) -> Vec<StockLine> {
    stock_overview(conn).unwrap()
}

fn names(rows: &[StockLine]) -> Vec<&str> {
    rows.iter().map(|r| r.name.as_str()).collect()
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

/// 进一次货。`date` 是业务日期，用来验 90 天窗口。
fn restock(conn: &mut Connection, id: i64, date: &str) -> i64 {
    do_receive(
        conn,
        json!({
            "bizDate": date,
            "items": [{ "productId": id, "unit": "pack", "qty": "1", "unitCostYuan": "500" }],
        }),
    )
    .unwrap()
    .purchase_id
}

fn today_str(conn: &Connection) -> String {
    crate::services::reports::today(conn).unwrap()
}

// ═══════════════════ 列什么 ═══════════════════

#[test]
fn 一次货都没进过也要把商品列出来() {
    // 新店打开进货页看见空白，第一反应是「软件坏了」
    let conn = open_memory().unwrap();
    new_product(&conn, "中华(硬)");
    new_product(&conn, "玉溪");

    let rows = overview(&conn);
    assert_eq!(names(&rows), vec!["中华(硬)", "玉溪"], "退回建档顺序");
    assert!(rows.iter().all(|r| r.qty_milli == 0 && r.restock_count == 0));
}

#[test]
fn 没有结存行算零库存不算查不到() {
    let mut conn = open_memory().unwrap();
    let id = new_product(&conn, "芙蓉王");
    let today = today_str(&conn);
    restock(&mut conn, id, &today);

    let rows = overview(&conn);
    assert_eq!(rows[0].qty_milli, 10_000, "1 条 = 10 包");
    assert_eq!(rows[0].avg_cost_e4, 500_000, "500 元 / 条 ÷ 10 = 50 元 / 包");
}

#[test]
fn 停用的商品不出现在库存表里() {
    let conn = open_memory().unwrap();
    new_product(&conn, "中华(硬)");
    let gone = new_product(&conn, "录错的");
    conn.execute("UPDATE products SET is_active = 0 WHERE id = ?1", [gone])
        .unwrap();

    assert_eq!(names(&overview(&conn)), vec!["中华(硬)"]);
}

// ═══════════════════ 怎么排 ═══════════════════

#[test]
fn 经常补货的排在最前面() {
    let mut conn = open_memory().unwrap();
    let 中华 = new_product(&conn, "中华(硬)");
    let 玉溪 = new_product(&conn, "玉溪");
    new_product(&conn, "利群");
    let today = today_str(&conn);

    restock(&mut conn, 玉溪, &today);
    restock(&mut conn, 中华, &today);
    restock(&mut conn, 中华, &today);
    restock(&mut conn, 中华, &today);

    // 利群一次没进过，排最后；建档顺序在频次面前不作数
    assert_eq!(names(&overview(&conn)), vec!["中华(硬)", "玉溪", "利群"]);
    assert_eq!(overview(&conn)[0].restock_count, 3);
}

#[test]
fn 作废掉的进货单不算补货过() {
    let mut conn = open_memory().unwrap();
    let id = new_product(&conn, "苏烟");
    let today = today_str(&conn);
    let p = restock(&mut conn, id, &today);
    do_void_purchase(&mut conn, p).unwrap();

    assert_eq!(overview(&conn)[0].restock_count, 0, "作废的单不该把它顶上来");
}

#[test]
fn 九十天以前的进货不再算常补() {
    // 去年进过一次的年货，不该压在每周都补的烟上面
    let mut conn = open_memory().unwrap();
    let 年货 = new_product(&conn, "礼盒装");
    let 香烟 = new_product(&conn, "中华(硬)");
    let today = today_str(&conn);

    restock(&mut conn, 年货, "2020-01-01");
    restock(&mut conn, 香烟, &today);

    let rows = overview(&conn);
    assert_eq!(names(&rows), vec!["中华(硬)", "礼盒装"]);
    assert_eq!(rows[1].restock_count, 0);
    assert_eq!(rows[1].qty_milli, 10_000, "不算常补，但货还在货架上");
}

// ═══════════════════ 最近入库 ═══════════════════
//
// 撤销的前提是**认得出那一单**。这张表只要认不出来，老板就只能带着
// 一单错货继续做生意 —— 库存和成本从此一直是歪的。

use crate::services::purchases::{recent, PurchaseListRow};

fn recent_rows(conn: &Connection) -> Vec<PurchaseListRow> {
    recent(conn, 20).unwrap()
}

#[test]
fn 最近入库新的排在最前面() {
    let mut conn = open_memory().unwrap();
    let 中华 = new_product(&conn, "中华(硬)");
    let 苏烟 = new_product(&conn, "苏烟");

    restock(&mut conn, 中华, "2026-09-10");
    let 后进的 = restock(&mut conn, 苏烟, "2026-09-11");

    let rows = recent_rows(&conn);
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0].id, 后进的, "刚录的那单要在第一行，录错的十有八九是它");
}

#[test]
fn 摘要按录入单位说话() {
    // 他录的是「2 条」，摘要写「20 包」他就对不上自己刚才按的数
    let mut conn = open_memory().unwrap();
    let id = new_product(&conn, "中华(硬)");
    do_receive(
        &mut conn,
        json!({
            "bizDate": "2026-09-10",
            "items": [{ "productId": id, "unit": "pack", "qty": "2", "unitCostYuan": "500" }],
        }),
    )
    .unwrap();

    assert_eq!(recent_rows(&conn)[0].summary, "中华(硬) 2 条");
}

#[test]
fn 一单进了几样只报第一样加个数() {
    let mut conn = open_memory().unwrap();
    let 中华 = new_product(&conn, "中华(硬)");
    let 苏烟 = new_product(&conn, "苏烟");
    do_receive(
        &mut conn,
        json!({
            "bizDate": "2026-09-10",
            "items": [
                { "productId": 中华, "unit": "base", "qty": "3", "unitCostYuan": "50" },
                { "productId": 苏烟, "unit": "pack", "qty": "1", "unitCostYuan": "400" },
            ],
        }),
    )
    .unwrap();

    assert_eq!(recent_rows(&conn)[0].summary, "中华(硬) 3 包 等 2 样");
}

#[test]
fn 撤销过的单留在表里标成已撤销() {
    // 撤完就从列表里消失，老板会以为自己撤错了别的单，接着再撤一单
    let mut conn = open_memory().unwrap();
    let id = new_product(&conn, "苏烟");
    let p = restock(&mut conn, id, "2026-09-10");
    do_void_purchase(&mut conn, p).unwrap();

    let rows = recent_rows(&conn);
    assert_eq!(rows.len(), 1);
    assert!(rows[0].voided, "痕迹要留着");
}

// ═══════════════════ 按月分组 ═══════════════════
//
// 老板找货是按批次找的：「6 月进的那批茶还剩多少」。
// 一张按补货频次排的平表回答不了这个问题 —— 6 月和 9 月的货混在一起。

#[test]
fn 最近进货的月份排在上面() {
    let mut conn = open_memory().unwrap();
    let 六月 = new_product(&conn, "老白茶");
    let 九月 = new_product(&conn, "中华(硬)");
    let 七月 = new_product(&conn, "玉溪");

    restock(&mut conn, 六月, "2026-06-15");
    restock(&mut conn, 九月, "2026-09-20");
    restock(&mut conn, 七月, "2026-07-03");

    assert_eq!(names(&overview(&conn)), vec!["中华(硬)", "玉溪", "老白茶"]);
}

#[test]
fn 同一个月里仍然按补货频次排() {
    // 月份之内，每周都要补的那几样还是该在前面
    let mut conn = open_memory().unwrap();
    let 常补 = new_product(&conn, "中华(硬)");
    let 偶尔 = new_product(&conn, "玉溪");

    restock(&mut conn, 偶尔, "2026-09-02");
    for day in ["01", "10", "20"] {
        restock(&mut conn, 常补, &format!("2026-09-{day}"));
    }

    assert_eq!(names(&overview(&conn)), vec!["中华(硬)", "玉溪"]);
}

#[test]
fn 没进过货的排在最后() {
    // 一次货都没进过的商品没有月份可归。排在前面会把真正有货的挤下去
    let mut conn = open_memory().unwrap();
    let 建了没进 = new_product(&conn, "苏烟");
    let 进过 = new_product(&conn, "中华(硬)");
    let _ = 建了没进;

    restock(&mut conn, 进过, "2020-01-01");

    assert_eq!(
        names(&overview(&conn)),
        vec!["中华(硬)", "苏烟"],
        "哪怕是六年前进的，也排在从没进过货的前面"
    );
}

#[test]
fn 最近进货日期不受九十天窗口限制() {
    // 「补过几次」只数 90 天内的，但月份分组得看全部历史 ——
    // 去年进的货今天还在货架上，它照样得有个月份可归
    let mut conn = open_memory().unwrap();
    let id = new_product(&conn, "礼盒装");
    restock(&mut conn, id, "2025-01-15");

    let row = &overview(&conn)[0];
    assert_eq!(row.restock_count, 0, "90 天窗口之外，不算常补");
    assert_eq!(row.last_intake.as_deref(), Some("2025-01-15"), "但月份还在");
}

#[test]
fn 撤销过的进货不算最近进货() {
    let mut conn = open_memory().unwrap();
    let id = new_product(&conn, "苏烟");
    restock(&mut conn, id, "2026-06-01");
    let 撤掉的 = restock(&mut conn, id, "2026-09-20");
    do_void_purchase(&mut conn, 撤掉的).unwrap();

    assert_eq!(
        overview(&conn)[0].last_intake.as_deref(),
        Some("2026-06-01"),
        "撤掉的那次不该把它顶到 9 月那组去"
    );
}
