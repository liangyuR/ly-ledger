//! 桌子费这类服务型收费。
//!
//! 它走的是正常销售单，所以真正要验的不是「能不能记一笔」，
//! 而是**它没有把别的东西带歪**：库存里不该多出一个越卖越负的桌子费，
//! 报表里的营业额和毛利该照常包含它，撤一笔该干净地退回去。

use super::*;

use crate::services::inventory::stock_overview;
use crate::services::reports::dashboard;
use crate::services::service_fees::{list, today_fees, today_total};

/// 迁移里打底的那个桌子费。
fn table_fee(conn: &Connection) -> i64 {
    conn.query_row("SELECT id FROM products WHERE name = '桌子费'", [], |r| r.get(0))
        .unwrap()
}

/// 收一笔桌子费 —— 界面上就是「点 200，收现金」。
fn charge(conn: &mut Connection, date: &str, yuan: &str) -> i64 {
    let id = table_fee(conn);
    do_checkout(
        conn,
        json!({
            "bizDate": date,
            "settleType": "cash",
            "items": [{ "productId": id, "unit": "base", "qty": "1", "unitPriceYuan": yuan }],
        }),
    )
    .unwrap()
    .sale_id
}

// ═══════════════════ 它是收入 ═══════════════════

#[test]
fn 桌子费全额算毛利() {
    // 没有进价，收多少赚多少。若走 read_stock 拿到零成本，数字上也是零，
    // 但那是碰巧对 —— 这里要的是「服务的成本就是零」这个断言
    let mut conn = open_memory().unwrap();
    let fee = table_fee(&conn);
    let sale = do_checkout(
        &mut conn,
        json!({
            "bizDate": "2026-09-20",
            "settleType": "cash",
            "items": [{ "productId": fee, "unit": "base", "qty": "1", "unitPriceYuan": "200" }],
        }),
    )
    .unwrap();

    assert_eq!(cents_to_yuan(sale.total_cents), "200.00");
    assert_eq!(cents_to_yuan(sale.gross_profit_cents), "200.00");
}

#[test]
fn 桌子费进当天营业额() {
    // 单开一张收入表的话，这条就得在六处报表 SQL 里各补一次
    let mut conn = open_memory().unwrap();
    let today = crate::services::reports::today(&conn).unwrap();
    charge(&mut conn, &today, "200");
    charge(&mut conn, &today, "600");

    let d = dashboard(&conn).unwrap();
    assert_eq!(cents_to_yuan(d.today_revenue_cents), "800.00");
    assert_eq!(cents_to_yuan(d.today_profit_cents), "800.00");
}

#[test]
fn 桌子费可以挂在客户账上() {
    // 打完牌先记着，月底一起结 —— 这是走销售单最值钱的地方
    let mut conn = open_memory().unwrap();
    conn.execute("INSERT INTO customers (name) VALUES ('老王')", []).unwrap();
    let laowang = conn.last_insert_rowid();
    let fee = table_fee(&conn);

    do_checkout(
        &mut conn,
        json!({
            "bizDate": "2026-09-20",
            "settleType": "credit",
            "customerId": laowang,
            "items": [{ "productId": fee, "unit": "base", "qty": "1", "unitPriceYuan": "300" }],
        }),
    )
    .unwrap();

    assert_eq!(cents_to_yuan(debt(&conn, laowang).net_debt_cents), "300.00");
}

// ═══════════════════ 它不该碰库存 ═══════════════════

#[test]
fn 收桌子费不写库存流水() {
    let mut conn = open_memory().unwrap();
    charge(&mut conn, "2026-09-20", "200");

    let fee = table_fee(&conn);
    assert_eq!(
        count(&conn, &format!("SELECT COUNT(*) FROM stock_movements WHERE product_id = {fee}")),
        0,
        "写了流水，桌子费就会有个越卖越负的结存"
    );
    assert_eq!(
        count(&conn, &format!("SELECT COUNT(*) FROM inventory WHERE product_id = {fee}")),
        0,
        "连结存行都不该建出来"
    );
}

#[test]
fn 桌子费不出现在库存表和常用商品里() {
    let conn = open_memory().unwrap();
    insert_product(
        &conn,
        "INSERT INTO products (name, category, base_unit) VALUES ('中华', 'cigarette', '盒')",
    );

    let names: Vec<String> = stock_overview(&conn).unwrap().into_iter().map(|r| r.name).collect();
    assert_eq!(names, vec!["中华"], "库存页只摆有库存概念的东西");

    let frequent = crate::services::reports::frequent_products(&conn, 9).unwrap();
    assert!(
        !frequent.iter().any(|f| f.name == "桌子费"),
        "卖货页的常用位不该被它占掉 —— 它价格每次现填，有自己的页面"
    );
}

#[test]
fn 收了一次不会把价格记成固定售价() {
    // 今天 200 明天 600，记住上一次等于记错
    let mut conn = open_memory().unwrap();
    charge(&mut conn, "2026-09-20", "200");

    let price: Option<i64> = conn
        .query_row("SELECT price_base_cents FROM products WHERE name = '桌子费'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(price, None, "服务没有固定售价");
}

// ═══════════════════ 撤一笔 ═══════════════════

#[test]
fn 撤一笔桌子费营业额退回去且不凭空多出库存() {
    let mut conn = open_memory().unwrap();
    let today = crate::services::reports::today(&conn).unwrap();
    charge(&mut conn, &today, "200");
    let wrong = charge(&mut conn, &today, "600");

    do_void_sale(&mut conn, wrong).unwrap();

    assert_eq!(cents_to_yuan(dashboard(&conn).unwrap().today_revenue_cents), "200.00");
    let fee = table_fee(&conn);
    assert_eq!(
        count(&conn, &format!("SELECT COUNT(*) FROM stock_movements WHERE product_id = {fee}")),
        0,
        "作废销售本来要把货加回去，服务没有货可加"
    );
}

// ═══════════════════ 页面要的那两张数 ═══════════════════

#[test]
fn 当天流水带作废痕迹合计不含作废的() {
    let mut conn = open_memory().unwrap();
    charge(&mut conn, "2026-09-20", "200");
    let wrong = charge(&mut conn, "2026-09-20", "600");
    do_void_sale(&mut conn, wrong).unwrap();

    let rows = today_fees(&conn, "2026-09-20").unwrap();
    assert_eq!(rows.len(), 2, "撤过的留一行痕迹");
    assert!(rows[0].voided, "新的在最前面");
    assert_eq!(cents_to_yuan(today_total(&conn, "2026-09-20").unwrap()), "200.00");
}

#[test]
fn 常收的价按收的次数排() {
    // 不写死 200/300/600 —— 每家店不一样，季节一变价就变
    let mut conn = open_memory().unwrap();
    let today = crate::services::reports::today(&conn).unwrap();
    for _ in 0..3 {
        charge(&mut conn, &today, "300");
    }
    charge(&mut conn, &today, "200");

    let items = list(&conn).unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].name, "桌子费");
    assert_eq!(
        items[0].common_amounts_cents,
        vec![30_000, 20_000],
        "收得最多的排最前"
    );
}

#[test]
fn 打底的桌子费不算老板建过商品() {
    // 它是随软件装好的。算进去的话新店一打开，向导会以为商品这步做完了，
    // 而且 fresh 变 false —— 第一次启动根本不会跳到向导
    let conn = open_memory().unwrap();
    let st = crate::services::onboarding::onboarding_state(&conn).unwrap();

    assert!(st.fresh, "空库就是空库，桌子费不算");
    let products = st.steps.iter().find(|s| s.key == "products").unwrap();
    assert!(!products.done, "商品这步还没做");
}
