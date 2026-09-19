//! 启用向导的进度判定。
//!
//! 进度一律现算。这组用例盯的就是「绕开向导把事做了，向导也得认」——
//! 存进度就会有第二份真相，然后催老板做已经做完的事。

use super::*;

use crate::services::onboarding::{
    dismiss_onboarding, onboarding_state, skip_opening_stock, OnboardingState, Step,
};

fn fresh_db() -> Connection {
    open_memory().unwrap()
}

fn add_product(conn: &Connection, name: &str, priced: bool) -> i64 {
    conn.execute(
        "INSERT INTO products (name, category, base_unit, pack_unit, pack_ratio, price_base_cents)
         VALUES (?1, 'cigarette', '包', '条', 10, ?2)",
        rusqlite::params![name, if priced { Some(5700) } else { None }],
    )
    .unwrap();
    conn.last_insert_rowid()
}

fn state(conn: &Connection) -> OnboardingState {
    onboarding_state(conn).unwrap()
}

fn step<'a>(s: &'a OnboardingState, key: &str) -> &'a Step {
    s.steps.iter().find(|x| x.key == key).expect("没有这一步")
}

fn sell_one(conn: &mut Connection, product_id: i64) -> i64 {
    do_checkout(
        conn,
        json!({
            "bizDate": "2026-09-19", "settleType": "cash",
            "items": [{ "productId": product_id, "unit": "pack", "qty": "1", "unitPriceYuan": "550" }],
        }),
    )
    .unwrap()
    .sale_id
}

#[test]
fn 空库时四步全没做() {
    let conn = fresh_db();
    let s = state(&conn);
    assert_eq!(s.done_count, 0);
    assert!(!s.complete);
    assert!(s.fresh, "一个商品一笔生意都没有，该进全屏向导");
}

#[test]
fn 只有期初库存那步能跳() {
    let conn = fresh_db();
    let optional: Vec<&str> = state(&conn)
        .steps
        .iter()
        .filter(|x| x.optional)
        .map(|x| x.key)
        .collect();
    assert_eq!(optional, vec!["stock"]);
}

#[test]
fn 建了商品第一步就算做完() {
    let conn = fresh_db();
    add_product(&conn, "中华(硬)", false);
    let s = state(&conn);
    assert!(step(&s, "products").done);
    assert!(!step(&s, "prices").done, "建了商品不等于填了价");
}

// 老板从商品页自己填的价，向导也得认 —— 否则会催他做已经做完的事
#[test]
fn 绕开向导填的价一样算数() {
    let conn = fresh_db();
    let id = add_product(&conn, "中华(硬)", false);
    conn.execute(
        "UPDATE products SET price_pack_cents = 55000 WHERE id = ?1",
        [id],
    )
    .unwrap();
    assert!(step(&state(&conn), "prices").done);
}

#[test]
fn 进了货期初那步就算做完不用点跳过() {
    let mut conn = fresh_db();
    let id = add_product(&conn, "中华(硬)", true);
    do_receive(
        &mut conn,
        json!({
            "bizDate": "2026-09-01",
            "items": [{ "productId": id, "unit": "pack", "qty": "10", "unitCostYuan": "520" }],
        }),
    )
    .unwrap();
    assert!(step(&state(&conn), "stock").done);
}

#[test]
fn 跳过期初库存不算做完但算处理过了() {
    let mut conn = fresh_db();
    let id = add_product(&conn, "中华(硬)", true);
    skip_opening_stock(&conn, true).unwrap();

    let s = state(&conn);
    assert!(!step(&s, "stock").done);
    assert!(step(&s, "stock").skipped);
    assert!(!s.complete, "还差第一笔生意");

    sell_one(&mut conn, id);
    assert!(
        state(&conn).complete,
        "跳过的那步不该挡住「装好了」"
    );
}

#[test]
fn 卖出第一笔才算装好() {
    let mut conn = fresh_db();
    let id = add_product(&conn, "中华(硬)", true);
    do_receive(
        &mut conn,
        json!({
            "bizDate": "2026-09-01",
            "items": [{ "productId": id, "unit": "pack", "qty": "10", "unitCostYuan": "520" }],
        }),
    )
    .unwrap();
    assert!(!state(&conn).complete, "前三步做完了也不算");

    sell_one(&mut conn, id);
    assert!(state(&conn).complete);
}

// 试卖那一笔多半要撤掉，撤掉之后不能倒回去催他再卖一次
#[test]
fn 唯一一笔被作废就回到没卖过的状态() {
    let mut conn = fresh_db();
    let id = add_product(&conn, "中华(硬)", true);
    let sale_id = sell_one(&mut conn, id);
    assert!(step(&state(&conn), "firstSale").done);

    do_void_sale(&mut conn, sale_id).unwrap();

    assert!(!step(&state(&conn), "firstSale").done);
    assert!(!state(&conn).fresh, "商品还在，不该再弹全屏向导");
}

#[test]
fn 关掉清单不影响进度本身() {
    let conn = fresh_db();
    add_product(&conn, "中华(硬)", false);

    dismiss_onboarding(&conn, true).unwrap();
    let s = state(&conn);
    assert!(s.dismissed);
    assert_eq!(s.done_count, 1, "关掉的是清单，不是进度");

    dismiss_onboarding(&conn, false).unwrap();
    assert!(!state(&conn).dismissed, "要能重新打开");
}
