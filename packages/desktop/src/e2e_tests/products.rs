//! 删商品。
//!
//! 这条路上真正要守住的是「删掉的东西不能把老账带塌」——
//! 所以验的不只是「删没删掉」，还有删完之后历史单据是不是照样读得出来。

use super::*;

use crate::services::products::{remove_product, Removal};

fn do_remove(conn: &mut Connection, id: i64) -> Result<crate::services::products::RemoveResult> {
    tx(conn, |c| remove_product(c, id))
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

fn is_active(conn: &Connection, id: i64) -> Option<i64> {
    conn.query_row("SELECT is_active FROM products WHERE id = ?1", [id], |r| r.get(0))
        .ok()
}

// ═══════════════════ 没动过的：真删 ═══════════════════

#[test]
fn 刚录错的商品直接删掉() {
    let mut conn = open_memory().unwrap();
    let id = new_product(&conn, "中华(软)");

    let r = do_remove(&mut conn, id).unwrap();

    assert_eq!(r.outcome, Removal::Deleted);
    assert_eq!(r.name, "中华(软)");
    assert_eq!(is_active(&conn, id), None, "行应该从库里没了");
    // 不数桌子费：它是随软件装好的服务项目，不是老板录的商品
    assert_eq!(count(&conn, "SELECT count(*) FROM products WHERE is_service = 0"), 0);
}

#[test]
fn 删掉之后同名商品能重新建() {
    // UNIQUE(name) 卡的是活着的行。停用不解这个锁，真删才解 ——
    // 录错名字的老板下一步一定是把它重录一遍
    let mut conn = open_memory().unwrap();
    let id = new_product(&conn, "中华(硬)");
    do_remove(&mut conn, id).unwrap();

    let again = new_product(&conn, "中华(硬)");
    assert_ne!(again, id);
}

#[test]
fn 只被读过库存的商品仍然算没动过() {
    // 读一次库存会留下一行空结存，那不是「动过」
    let mut conn = open_memory().unwrap();
    let id = new_product(&conn, "玉溪");
    conn.execute(
        "INSERT INTO inventory (product_id, qty_base_milli, avg_cost_base_e4) VALUES (?1, 0, 0)",
        [id],
    )
    .unwrap();

    assert_eq!(do_remove(&mut conn, id).unwrap().outcome, Removal::Deleted);
    assert_eq!(count(&conn, "SELECT count(*) FROM inventory"), 0, "空结存行要跟着清掉");
}

// ═══════════════════ 动过的：只停用 ═══════════════════

#[test]
fn 卖过的商品不真删只停用() {
    let mut conn = open_memory().unwrap();
    let id = new_product(&conn, "芙蓉王");

    do_receive(
        &mut conn,
        json!({
            "bizDate": "2026-09-01",
            "items": [{ "productId": id, "unit": "pack", "qty": "1", "unitCostYuan": "500" }],
        }),
    )
    .unwrap();
    do_checkout(
        &mut conn,
        json!({
            "bizDate": "2026-09-02", "settleType": "cash",
            "items": [{ "productId": id, "unit": "base", "qty": "2", "unitPriceYuan": "60" }],
        }),
    )
    .unwrap();

    let r = do_remove(&mut conn, id).unwrap();

    assert_eq!(r.outcome, Removal::Deactivated { purchases: 1, sales: 1 });
    assert_eq!(is_active(&conn, id), Some(0), "行还在，只是不再出现在列表里");
    assert_eq!(count(&conn, "SELECT count(*) FROM sale_items"), 1, "老账不能被带走");
    assert_eq!(count(&conn, "SELECT count(*) FROM stock_movements"), 2);
}

#[test]
fn 进过货就算一笔没卖出去也不真删() {
    let mut conn = open_memory().unwrap();
    let id = new_product(&conn, "利群");
    do_receive(
        &mut conn,
        json!({
            "bizDate": "2026-09-01",
            "items": [{ "productId": id, "unit": "pack", "qty": "1", "unitCostYuan": "200" }],
        }),
    )
    .unwrap();

    assert_eq!(
        do_remove(&mut conn, id).unwrap().outcome,
        Removal::Deactivated { purchases: 1, sales: 0 },
    );
}

#[test]
fn 整单作废过的商品仍然不真删() {
    // 作废不抹掉进货单，只追加一条反向流水 —— 账面上这个商品是动过的
    let mut conn = open_memory().unwrap();
    let id = new_product(&conn, "苏烟");
    let p = do_receive(
        &mut conn,
        json!({
            "bizDate": "2026-09-01",
            "items": [{ "productId": id, "unit": "pack", "qty": "1", "unitCostYuan": "300" }],
        }),
    )
    .unwrap();
    do_void_purchase(&mut conn, p.purchase_id).unwrap();

    assert!(matches!(
        do_remove(&mut conn, id).unwrap().outcome,
        Removal::Deactivated { .. }
    ));
    assert_eq!(is_active(&conn, id), Some(0));
}

// ═══════════════════ 拒绝 ═══════════════════

#[test]
fn 删不存在的商品说得清楚() {
    let mut conn = open_memory().unwrap();
    assert!(err_of(do_remove(&mut conn, 999)).contains("不存在"));
}
