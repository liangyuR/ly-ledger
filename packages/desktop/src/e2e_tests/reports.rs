//! 单据详情、修订链、当日流水。
//!
//! 界面上老板看到的是「这张单的经过」。链是数据驱动的，所以这里额外钉死
//! 一条：**成了环也不能把界面转死**。

use super::*;

use crate::services::sale_detail::{list_sales, sale_detail};

struct Counter {
    conn: Connection,
    zhonghua: i64,
    laowang: i64,
}

fn counter() -> Counter {
    let conn = open_memory().unwrap();
    let zhonghua = insert_product(
        &conn,
        "INSERT INTO products (name, category, base_unit, pack_unit, pack_ratio)
         VALUES ('中华(硬)', 'cigarette', '包', '条', 10)",
    );
    conn.execute("INSERT INTO customers (name) VALUES ('老王')", [])
        .unwrap();
    let laowang = conn.last_insert_rowid();

    let mut c = Counter {
        conn,
        zhonghua,
        laowang,
    };
    do_receive(
        &mut c.conn,
        json!({
            "bizDate": "2026-09-01",
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "20", "unitCostYuan": "520" }],
        }),
    )
    .unwrap();
    c
}

fn sell(c: &mut Counter, qty: &str) -> CheckoutResult {
    let zhonghua = c.zhonghua;
    do_checkout(
        &mut c.conn,
        json!({
            "bizDate": "2026-09-19", "settleType": "cash",
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": qty, "unitPriceYuan": "550" }],
        }),
    )
    .unwrap()
}

fn revise_to(c: &mut Counter, sale_id: i64, qty: &str) -> i64 {
    let zhonghua = c.zhonghua;
    do_revise(
        &mut c.conn,
        sale_id,
        json!({
            "bizDate": "2026-09-19", "settleType": "cash",
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": qty, "unitPriceYuan": "550" }],
        }),
    )
    .unwrap()
    .created
    .sale_id
}

// ═══════════════════ 单据详情 ═══════════════════

#[test]
fn 详情带成本快照和毛利() {
    let mut c = counter();
    let s = sell(&mut c, "2");
    let d = sale_detail(&c.conn, s.sale_id).unwrap();

    assert_eq!(cents_to_yuan(d.total_cents), "1100.00");
    assert_eq!(cents_to_yuan(d.profit_cents), "60.00");
    assert_eq!(d.items.len(), 1);
    assert_eq!(d.items[0].unit_cost_e4, 520_000, "成交那一刻冻结的成本");
    assert_eq!(cents_to_yuan(d.items[0].profit_cents), "60.00");
}

#[test]
fn 新单可以改也可以退() {
    let mut c = counter();
    let id = sell(&mut c, "2").sale_id;
    let d = sale_detail(&c.conn, id).unwrap();
    assert!(d.can_revise);
    assert!(d.can_return);
    assert_eq!(d.blocked_reason, None);
}

#[test]
fn 不存在的单据给人话错误() {
    let c = counter();
    let e = err_of(sale_detail(&c.conn, 99999));
    assert!(e.contains("单据不存在"), "{e}");
}

// ═══════════════════ 修订链 ═══════════════════

#[test]
fn 从新版本能看到完整经过() {
    let mut c = counter();
    let s = sell(&mut c, "2");
    let new_id = revise_to(&mut c, s.sale_id, "3");

    let d = sale_detail(&c.conn, new_id).unwrap();
    assert_eq!(d.rev, 2);
    assert_eq!(d.revision_of_sale_id, Some(s.sale_id));
    assert_eq!(d.events.len(), 2, "录入 + 改为");
    assert_eq!(d.events[0].sale_id, s.sale_id);
    assert_eq!(d.events[1].sale_id, new_id);
    assert!(d.events[1].current, "最新那版才是当前版本");
}

#[test]
fn 从旧版本打开也能看到完整经过并被挡住不让改() {
    let mut c = counter();
    let s = sell(&mut c, "2");
    let new_id = revise_to(&mut c, s.sale_id, "3");

    let old = sale_detail(&c.conn, s.sale_id).unwrap();
    assert_eq!(old.events.len(), 2, "旧版本也要能看到后来发生了什么");
    assert!(!old.can_revise);
    assert!(
        old.blocked_reason.as_deref().unwrap().contains("旧版本"),
        "{:?}",
        old.blocked_reason
    );
    assert_eq!(
        old.superseded_by_sale_id,
        Some(new_id),
        "要能指向最新那张"
    );
}

#[test]
fn 改三次串成四节链() {
    let mut c = counter();
    let mut id = sell(&mut c, "1").sale_id;
    for qty in ["2", "3", "4"] {
        id = revise_to(&mut c, id, qty);
    }
    let d = sale_detail(&c.conn, id).unwrap();
    assert_eq!(d.rev, 4);
    assert_eq!(d.events.len(), 4);
    assert_eq!(
        d.events.iter().filter(|e| e.current).count(),
        1,
        "只能有一个当前版本"
    );
}

// 链是数据驱动的，成了环就不能把界面转死
#[test]
fn 修订链成环也不会死循环() {
    let mut c = counter();
    let a = sell(&mut c, "1").sale_id;
    let b = revise_to(&mut c, a, "2");

    // 人为制造一个环
    c.conn
        .execute(
            "UPDATE sales SET superseded_by_sale_id = ?1 WHERE id = ?2",
            [a, b],
        )
        .unwrap();

    let d = sale_detail(&c.conn, b).unwrap();
    assert!(d.events.len() >= 2, "能返回就说明没转死");
}

// ═══════════════════ 退货与作废在经过里的样子 ═══════════════════

#[test]
fn 退货作为一条经过出现原单仍是当前版本() {
    let mut c = counter();
    let s = sell(&mut c, "2");
    let zhonghua = c.zhonghua;
    do_return(
        &mut c.conn,
        s.sale_id,
        json!({ "bizDate": "2026-09-25", "items": [{ "productId": zhonghua, "qty": "1" }] }),
    )
    .unwrap();

    let d = sale_detail(&c.conn, s.sale_id).unwrap();
    let kinds: Vec<&str> = d.events.iter().map(|e| e.kind).collect();
    assert_eq!(kinds, vec!["created", "returned"]);
    assert_eq!(cents_to_yuan(d.returned_cents), "-550.00");
    assert!(d.can_return, "还剩一条没退，可以继续退");
}

#[test]
fn 全退完就不能再退了() {
    let mut c = counter();
    let s = sell(&mut c, "2");
    do_return(&mut c.conn, s.sale_id, json!({ "bizDate": "2026-09-25" })).unwrap();

    let d = sale_detail(&c.conn, s.sale_id).unwrap();
    assert!(!d.can_return, "退光了还让点退货，点下去只会报错");
}

#[test]
fn 作废的单标出来且不让改不让退() {
    let mut c = counter();
    let s = sell(&mut c, "2");
    do_void_sale(&mut c.conn, s.sale_id).unwrap();

    let d = sale_detail(&c.conn, s.sale_id).unwrap();
    assert!(d.voided_at.is_some());
    assert!(!d.can_revise);
    assert!(!d.can_return);
    assert!(d.blocked_reason.as_deref().unwrap().contains("已经作废"));
    assert!(d.events.iter().any(|e| e.kind == "voided"));
}

#[test]
fn 退货单本身不能再改再退() {
    let mut c = counter();
    let s = sell(&mut c, "2");
    let r = do_return(&mut c.conn, s.sale_id, json!({ "bizDate": "2026-09-25" })).unwrap();

    let d = sale_detail(&c.conn, r.return_sale_id).unwrap();
    assert!(!d.can_revise);
    assert!(d.blocked_reason.as_deref().unwrap().contains("退货单"));
}

// ═══════════════════ 挂账单详情 ═══════════════════

#[test]
fn 挂账单详情显示已核销多少() {
    let mut c = counter();
    let (zhonghua, laowang) = (c.zhonghua, c.laowang);

    let s = do_checkout(
        &mut c.conn,
        json!({
            "bizDate": "2026-09-19", "settleType": "credit", "customerId": laowang,
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "2", "unitPriceYuan": "550" }],
            "partialPay": { "amountYuan": "300", "method": "cash" },
        }),
    )
    .unwrap();

    let d = sale_detail(&c.conn, s.sale_id).unwrap();
    assert_eq!(d.customer_name.as_deref(), Some("老王"));
    assert_eq!(
        cents_to_yuan(d.settled_cents),
        "300.00",
        "部分付那 300 当场核销掉了"
    );
}

// ═══════════════════ 当日流水 ═══════════════════

#[test]
fn 当日流水按时间倒序作废的不出现() {
    let mut c = counter();
    let a = sell(&mut c, "1");
    sell(&mut c, "2");
    do_void_sale(&mut c.conn, a.sale_id).unwrap();

    let list = list_sales(&c.conn, "2026-09-19").unwrap();
    assert_eq!(list.len(), 1);
    assert!(list[0].summary.contains("中华(硬)"));
}

#[test]
fn 多行时摘要说清有几样() {
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
                { "productId": zhonghua, "unit": "pack", "qty": "1", "unitPriceYuan": "550" },
                { "productId": liqun,    "unit": "base", "qty": "1", "unitPriceYuan": "23" },
            ],
        }),
    )
    .unwrap();

    let list = list_sales(&c.conn, "2026-09-19").unwrap();
    assert!(list[0].summary.contains("等 2 样"), "{}", list[0].summary);
}

#[test]
fn 退货单出现在当日流水里且标出来() {
    // 退货记在退货当天，不是原单那天（docs/05）。它就是那天的一张单据，
    // 金额为负 —— 列表里不标出来，老板会以为自己那天卖了负数
    let mut c = counter();
    let sale = sell(&mut c, "2");
    do_return(
        &mut c.conn,
        sale.sale_id,
        json!({ "bizDate": "2026-09-20" }),
    )
    .unwrap();

    let 原单那天 = list_sales(&c.conn, "2026-09-19").unwrap();
    assert_eq!(原单那天.len(), 1);
    assert!(!原单那天[0].is_return, "原单照常留在它那天");

    let 退货那天 = list_sales(&c.conn, "2026-09-20").unwrap();
    assert_eq!(退货那天.len(), 1);
    assert!(退货那天[0].is_return);
    assert!(退货那天[0].total_cents < 0, "退货金额为负");
}

#[test]
fn 当天合计把退货冲掉() {
    // 单据页底下那个合计要跟看板的营业额对得上，否则老板会以为哪边算错了
    let mut c = counter();
    let a = sell(&mut c, "1");
    sell(&mut c, "2");
    do_return(&mut c.conn, a.sale_id, json!({ "bizDate": "2026-09-19" })).unwrap();

    let list = list_sales(&c.conn, "2026-09-19").unwrap();
    let sum: i64 = list.iter().map(|s| s.total_cents).sum();
    assert_eq!(list.len(), 3, "两张销售单加一张退货单");
    assert_eq!(
        sum,
        sum_cents(
            &c.conn,
            "SELECT SUM(total_amount_cents) FROM sales
              WHERE biz_date = '2026-09-19' AND voided_at IS NULL"
        ),
        "合计得跟报表口径一致"
    );
}

#[test]
fn 按月看能把整月的单据都捞出来() {
    let mut c = counter();
    let zhonghua = c.zhonghua;
    for day in ["01", "19", "28"] {
        do_checkout(
            &mut c.conn,
            json!({
                "bizDate": format!("2026-09-{day}"), "settleType": "cash",
                "items": [{ "productId": zhonghua, "unit": "pack", "qty": "1", "unitPriceYuan": "550" }],
            }),
        )
        .unwrap();
    }
    // 隔壁月的不该混进来
    do_checkout(
        &mut c.conn,
        json!({
            "bizDate": "2026-08-31", "settleType": "cash",
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "1", "unitPriceYuan": "550" }],
        }),
    )
    .unwrap();

    let 整月 = list_sales(&c.conn, "2026-09").unwrap();
    assert_eq!(整月.len(), 3);
    assert_eq!(
        整月.iter().map(|s| s.biz_date.as_str()).collect::<Vec<_>>(),
        vec!["2026-09-28", "2026-09-19", "2026-09-01"],
        "按天倒序"
    );

    assert_eq!(list_sales(&c.conn, "2026-09-19").unwrap().len(), 1, "按天看还是只有那天");
}

#[test]
fn 补录的单按日期排不按录入顺序排() {
    // 补录的单 id 最大但日期最早。只按 id 排，它会窜到月初那天的上面
    let mut c = counter();
    let zhonghua = c.zhonghua;
    for day in ["20", "02"] {
        do_checkout(
            &mut c.conn,
            json!({
                "bizDate": format!("2026-09-{day}"), "settleType": "cash",
                "items": [{ "productId": zhonghua, "unit": "pack", "qty": "1", "unitPriceYuan": "550" }],
            }),
        )
        .unwrap();
    }

    let list = list_sales(&c.conn, "2026-09").unwrap();
    assert_eq!(
        list.iter().map(|s| s.biz_date.as_str()).collect::<Vec<_>>(),
        vec!["2026-09-20", "2026-09-02"]
    );
}

#[test]
fn 趋势图以选中的月份为最后一根柱子() {
    // 报表页翻到 7 月去看，趋势图也得跟着翻过去 —— 不然翻了月份却还盯着
    // 9 月那根柱子，两边对不上
    use crate::services::profit_reports::monthly_trend;

    let mut c = counter();
    let zhonghua = c.zhonghua;
    for m in ["07", "08", "09"] {
        do_checkout(
            &mut c.conn,
            json!({
                "bizDate": format!("2026-{m}-10"), "settleType": "cash",
                "items": [{ "productId": zhonghua, "unit": "pack", "qty": "1", "unitPriceYuan": "550" }],
            }),
        )
        .unwrap();
    }

    let 到七月 = monthly_trend(&c.conn, 3, Some("2026-07")).unwrap();
    assert_eq!(
        到七月.iter().map(|p| p.month.as_str()).collect::<Vec<_>>(),
        vec!["2026-05", "2026-06", "2026-07"]
    );
    assert_eq!(
        cents_to_yuan(到七月.last().unwrap().revenue_cents),
        "550.00",
        "最后那根是 7 月自己的数"
    );
    assert!(!到七月.last().unwrap().partial, "7 月已经走完了，不该画成空心");

    let 不传锚点 = monthly_trend(&c.conn, 3, None).unwrap();
    assert_eq!(
        不传锚点.last().unwrap().month,
        crate::services::reports::today(&c.conn).unwrap()[..7],
        "不传就还是到本月为止"
    );
}
