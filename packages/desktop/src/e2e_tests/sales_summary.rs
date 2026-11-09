use super::*;

use crate::services::sales_summary::month;

fn product(conn: &mut Connection) -> i64 {
    let id = insert_product(
        conn,
        "INSERT INTO products (name, category, base_unit) VALUES ('测试酒', 'liquor', '瓶')",
    );
    do_receive(
        conn,
        json!({
            "bizDate": "2026-10-01",
            "items": [{"productId": id, "unit": "base", "qty": "100", "unitCostYuan": "6"}]
        }),
    )
    .unwrap();
    id
}

fn sale(conn: &mut Connection, id: i64, date: &str, qty: &str) -> i64 {
    do_checkout(
        conn,
        json!({
            "bizDate": date, "settleType": "cash",
            "items": [{"productId": id, "unit": "base", "qty": qty, "unitPriceYuan": "10"}]
        }),
    )
    .unwrap()
    .sale_id
}

#[test]
fn 纯商品抹零与单据金额毛利一致() {
    let mut conn = open_memory().unwrap();
    let id = product(&mut conn);
    let result = do_checkout(
        &mut conn,
        json!({
            "bizDate": "2026-11-09", "settleType": "cash", "discountYuan": "1.23",
            "items": [{"productId": id, "unit": "base", "qty": "2", "unitPriceYuan": "10"}]
        }),
    )
    .unwrap();
    let m = month(&conn, "2026-11").unwrap();
    assert_eq!(m.amounts.cash_sales, cents_to_yuan(result.total_cents));
    assert_eq!(m.amounts.cash_sales, "18.77");
    assert_eq!(
        m.amounts.cash_profit,
        cents_to_yuan(result.gross_profit_cents)
    );
    assert_eq!(m.amounts.cash_profit, "6.77");
    assert_eq!(m.days[0].items[0].amount, "18.77");
    assert_eq!(m.cost_unknown_count, 0);
}

#[test]
fn 混合单只统计商品并按比例分摊抹零到分() {
    let mut conn = open_memory().unwrap();
    let id = product(&mut conn);
    let fee: i64 = conn
        .query_row(
            "SELECT id FROM products WHERE is_service = 1 LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    do_checkout(
        &mut conn,
        json!({
            "bizDate": "2026-11-09", "settleType": "cash", "discountYuan": "0.01",
            "items": [
                {"productId": fee, "unit": "base", "qty": "1", "unitPriceYuan": "20"},
                {"productId": id, "unit": "base", "qty": "1", "unitPriceYuan": "10"}
            ]
        }),
    )
    .unwrap();
    sale(&mut conn, fee, "2026-11-08", "1");
    let m = month(&conn, "2026-11").unwrap();
    assert_eq!(m.amounts.cash_sales, "10.00");
    assert_eq!(m.amounts.cash_profit, "4.00");
    assert_eq!(m.days.len(), 1);
    assert_eq!(m.days[0].items.len(), 1);
    assert_eq!(m.days[0].items[0].summary, "测试酒");
    assert_eq!(m.cost_unknown_count, 0);
    do_checkout(
        &mut conn,
        json!({
            "bizDate": "2026-11-09", "settleType": "cash", "discountYuan": "3",
            "items": [
                {"productId": id, "unit": "base", "qty": "1", "unitPriceYuan": "10"},
                {"productId": fee, "unit": "base", "qty": "1", "unitPriceYuan": "20"}
            ]
        }),
    )
    .unwrap();
    let m = month(&conn, "2026-11").unwrap();
    assert_eq!(m.amounts.cash_sales, "19.00");
    assert_eq!(m.amounts.cash_profit, "7.00");
}

#[test]
fn 作废排除且跨月退货冲减退货月份() {
    let mut conn = open_memory().unwrap();
    let id = product(&mut conn);
    let previous = sale(&mut conn, id, "2026-10-31", "2");
    let voided = sale(&mut conn, id, "2026-11-09", "10");
    do_void_sale(&mut conn, voided).unwrap();
    let returned = do_return(&mut conn, previous, json!({"bizDate": "2026-11-01"})).unwrap();
    let october = month(&conn, "2026-10").unwrap();
    let november = month(&conn, "2026-11").unwrap();
    assert_eq!(october.amounts.cash_sales, "20.00");
    assert_eq!(november.amounts.cash_sales, "-20.00");
    assert_eq!(november.amounts.cash_profit, "-8.00");
    assert_eq!(november.days.len(), 1);
    assert_eq!(november.days[0].items.len(), 1);
    assert!(november.days[0].items[0].is_return);
    assert_eq!(november.days[0].items[0].id, returned.return_sale_id);
}

#[test]
fn 部分付款和后续还款不改挂账销售分类() {
    let mut conn = open_memory().unwrap();
    let id = product(&mut conn);
    conn.execute("INSERT INTO customers (name) VALUES ('老张')", [])
        .unwrap();
    let customer = conn.last_insert_rowid();
    let credit = do_checkout(
        &mut conn,
        json!({
            "bizDate": "2026-11-09", "settleType": "credit", "customerId": customer,
            "partialPay": {"amountYuan": "3", "method": "cash"},
            "items": [{"productId": id, "unit": "base", "qty": "1", "unitPriceYuan": "10"}]
        }),
    )
    .unwrap();
    do_collect(
        &mut conn,
        json!({
            "bizDate": "2026-11-09", "customerId": customer, "amountYuan": "7", "method": "cash"
        }),
    )
    .unwrap();
    let m = month(&conn, "2026-11").unwrap();
    assert_eq!(m.amounts.cash_sales, "0.00");
    assert_eq!(m.amounts.credit_sales, "10.00");
    assert_eq!(m.amounts.credit_profit, "4.00");
    assert_eq!(m.days[0].items[0].settle_type, "credit");
    assert_eq!(m.days[0].items[0].customer_name.as_deref(), Some("老张"));
    assert_eq!(m.days[0].items[0].id, credit.sale_id);
}

#[test]
fn 成本未知按商品去重且空月无数据() {
    let mut conn = open_memory().unwrap();
    let id = insert_product(
        &conn,
        "INSERT INTO products (name, category, base_unit) VALUES ('未入库酒', 'liquor', '瓶')",
    );
    sale(&mut conn, id, "2026-11-08", "1");
    sale(&mut conn, id, "2026-11-09", "1");
    let m = month(&conn, "2026-11").unwrap();
    assert_eq!(m.cost_unknown_count, 1);
    assert!(m.days[0].items[0].cost_unknown);
    assert_eq!(m.days[0].date, "2026-11-09");
    assert_eq!(m.days[1].date, "2026-11-08");
    let empty = month(&conn, "2026-10").unwrap();
    assert_eq!(empty.amounts.cash_sales, "0.00");
    assert_eq!(empty.amounts.credit_sales, "0.00");
    assert_eq!(empty.amounts.cash_profit, "0.00");
    assert_eq!(empty.amounts.credit_profit, "0.00");
    assert_eq!(empty.cost_unknown_count, 0);
    assert!(empty.days.is_empty());
    let json = serde_json::to_value(m).unwrap();
    assert_eq!(json["cashSales"], "20.00");
    assert_eq!(json["days"][0]["cashSales"], "10.00");
    assert_eq!(json["days"][0]["items"][0]["costUnknown"], true);
}

#[test]
fn 拒绝无效月份而不是返回零元() {
    let conn = open_memory().unwrap();
    for invalid in [
        "",
        "2026",
        "2026-1",
        "2026-13",
        "2026-00",
        "2026-11-09",
        "年月1",
    ] {
        assert!(month(&conn, invalid).is_err(), "{invalid}");
    }
}
