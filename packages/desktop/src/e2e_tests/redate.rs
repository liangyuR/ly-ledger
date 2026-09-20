//! 改业务日期与拆单 —— 补录这条路。
//!
//! 红线 2 说补录是常态：昨天忙忘了、今天补上，日期必须能改回去。
//! 但日期不是个孤立的字段 —— 挂账单的核销按它排 FIFO，账龄按它算，
//! 报表按它归月。改了不重算，账龄就是错的，而催收列表正是按账龄排的。

use super::*;

use crate::services::redate::{set_purchase_date, set_sale_date};
use crate::services::reversals::{split_purchase, SplitInput};

fn do_set_sale_date(conn: &mut Connection, id: i64, date: &str) -> Result<String> {
    tx(conn, |c| set_sale_date(c, id, date)).map(|r| r.from)
}

fn do_set_purchase_date(conn: &mut Connection, id: i64, date: &str) -> Result<String> {
    tx(conn, |c| set_purchase_date(c, id, date)).map(|r| r.from)
}

fn do_split(conn: &mut Connection, id: i64, v: Value) -> Result<crate::services::reversals::SplitResult> {
    let input: SplitInput = serde_json::from_value(v)?;
    tx(conn, |c| split_purchase(c, id, &input))
}

struct Shop {
    conn: Connection,
    zhonghua: i64,
    laowang: i64,
}

fn shop() -> Shop {
    let conn = open_memory().unwrap();
    let zhonghua = insert_product(
        &conn,
        "INSERT INTO products (name, pinyin_abbr, category, base_unit, pack_unit, pack_ratio)
         VALUES ('中华(硬)', 'zhy', 'cigarette', '包', '条', 10)",
    );
    conn.execute("INSERT INTO customers (name) VALUES ('老王')", []).unwrap();
    let laowang = conn.last_insert_rowid();
    Shop {
        conn,
        zhonghua,
        laowang,
    }
}

/// 进一批货，返回进货单 id。
fn receive(s: &mut Shop, date: &str, qty: &str) -> i64 {
    let id = s.zhonghua;
    do_receive(
        &mut s.conn,
        json!({
            "bizDate": date,
            "items": [{ "productId": id, "unit": "pack", "qty": qty, "unitCostYuan": "520" }],
        }),
    )
    .unwrap();
    s.conn
        .query_row("SELECT id FROM purchases ORDER BY id DESC LIMIT 1", [], |r| r.get(0))
        .unwrap()
}

fn revenue_on(conn: &Connection, date: &str) -> String {
    cents_to_yuan(sum_cents(
        conn,
        &format!(
            "SELECT SUM(total_amount_cents) FROM sales
              WHERE biz_date = '{date}' AND voided_at IS NULL"
        ),
    ))
}

// ═══════════════════ 销售单改期 ═══════════════════

#[test]
fn 改了日期营业额就落到新那天() {
    // 昨天卖的货今天才录，日期不能改回去的话，昨天的营业额永远少一笔
    let mut s = shop();
    receive(&mut s, "2026-09-01", "10");
    let zhonghua = s.zhonghua;
    let sale = do_checkout(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-20",
            "settleType": "cash",
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "2", "unitPriceYuan": "57" }],
        }),
    )
    .unwrap();

    let from = do_set_sale_date(&mut s.conn, sale.sale_id, "2026-09-19").unwrap();

    assert_eq!(from, "2026-09-20", "要告诉界面原来是哪天");
    assert_eq!(revenue_on(&s.conn, "2026-09-20"), "0.00");
    assert_eq!(revenue_on(&s.conn, "2026-09-19"), "114.00");
}

#[test]
fn 挂账单改期之后账龄跟着重算() {
    // 核销按 biz_date 升序 FIFO 排。改了日期不重算，「最早一笔 45 天前」就是错的，
    // 而那正是收款页的排序依据、老板决定先给谁打电话的依据（docs/05）
    let mut s = shop();
    receive(&mut s, "2026-09-01", "10");
    let (zhonghua, laowang) = (s.zhonghua, s.laowang);

    // 两张挂账单，先卖的那张日期靠后 —— 改期之后 FIFO 顺序要翻过来
    let late = do_checkout(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-20",
            "settleType": "credit",
            "customerId": laowang,
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "1", "unitPriceYuan": "570" }],
        }),
    )
    .unwrap();
    do_checkout(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-10",
            "settleType": "credit",
            "customerId": laowang,
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "1", "unitPriceYuan": "570" }],
        }),
    )
    .unwrap();

    // 收一笔，按 FIFO 该核销 9-10 那张
    do_collect(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-21",
            "customerId": laowang,
            "amountYuan": "570",
            "method": "cash",
        }),
    )
    .unwrap();
    assert_eq!(
        debt(&s.conn, laowang).earliest_unpaid_date.as_deref(),
        Some("2026-09-20"),
        "9-10 那张被收掉了，还欠的是 9-20 那张"
    );

    // 把 9-20 那张补录成 9-01：它成了最早的一张，收的那笔该改核销到它头上
    do_set_sale_date(&mut s.conn, late.sale_id, "2026-09-01").unwrap();

    assert_eq!(
        debt(&s.conn, laowang).earliest_unpaid_date.as_deref(),
        Some("2026-09-10"),
        "核销没重算的话这里还是 2026-09-20"
    );
}

#[test]
fn 欠款总额不因为改期而变() {
    let mut s = shop();
    receive(&mut s, "2026-09-01", "10");
    let (zhonghua, laowang) = (s.zhonghua, s.laowang);
    let sale = do_checkout(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-20",
            "settleType": "credit",
            "customerId": laowang,
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "1", "unitPriceYuan": "570" }],
        }),
    )
    .unwrap();

    let before = debt(&s.conn, laowang).net_debt_cents;
    do_set_sale_date(&mut s.conn, sale.sale_id, "2026-08-15").unwrap();

    assert_eq!(debt(&s.conn, laowang).net_debt_cents, before, "改的是日期，不是金额");
}

#[test]
fn 作废的单不给改日期() {
    let mut s = shop();
    receive(&mut s, "2026-09-01", "10");
    let zhonghua = s.zhonghua;
    let sale = do_checkout(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-20",
            "settleType": "cash",
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "1", "unitPriceYuan": "570" }],
        }),
    )
    .unwrap();
    do_void_sale(&mut s.conn, sale.sale_id).unwrap();

    let err = err_of(do_set_sale_date(&mut s.conn, sale.sale_id, "2026-09-19"));
    assert!(err.contains("作废"), "{err}");
}

#[test]
fn 日期格式不对直接挡住() {
    let mut s = shop();
    receive(&mut s, "2026-09-01", "10");
    let zhonghua = s.zhonghua;
    let sale = do_checkout(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-20",
            "settleType": "cash",
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "1", "unitPriceYuan": "570" }],
        }),
    )
    .unwrap();

    assert!(do_set_sale_date(&mut s.conn, sale.sale_id, "2026/09/19").is_err());
    assert!(do_set_sale_date(&mut s.conn, sale.sale_id, "2026-02-30").is_err());
}

// ═══════════════════ 进货单改期 ═══════════════════

#[test]
fn 改进货日期不动库存也不动均价() {
    // 加权成本是按流水写入顺序累积的，不按业务日期重排 —— 改期只改它算进哪个月
    let mut s = shop();
    let p = receive(&mut s, "2026-09-20", "10");
    let before = stock_of(&s.conn, s.zhonghua);

    do_set_purchase_date(&mut s.conn, p, "2026-07-03").unwrap();

    assert_eq!(stock_of(&s.conn, s.zhonghua), before);
    let date: String = s
        .conn
        .query_row("SELECT biz_date FROM purchases WHERE id = ?1", [p], |r| r.get(0))
        .unwrap();
    assert_eq!(date, "2026-07-03");
}

#[test]
fn 进货改到九十天以前就不算常补了() {
    // 库存页按「近 90 天补过几次货」排序，这个排序吃的就是进货单的业务日期
    let mut s = shop();
    let today = crate::services::reports::today(&s.conn).unwrap();
    let p = receive(&mut s, &today, "10");
    assert_eq!(
        crate::services::inventory::stock_overview(&s.conn).unwrap()[0].restock_count,
        1
    );

    do_set_purchase_date(&mut s.conn, p, "2020-01-01").unwrap();

    assert_eq!(
        crate::services::inventory::stock_overview(&s.conn).unwrap()[0].restock_count,
        0,
        "挪到三年前就不该再算「常补」"
    );
}

#[test]
fn 撤销过的进货单不给改日期() {
    let mut s = shop();
    let p = receive(&mut s, "2026-09-20", "10");
    do_void_purchase(&mut s.conn, p).unwrap();

    let err = err_of(do_set_purchase_date(&mut s.conn, p, "2026-09-19"));
    assert!(err.contains("撤销"), "{err}");
}

// ═══════════════════ 拆单 ═══════════════════

#[test]
fn 四条拆成两条六月两条七月() {
    let mut s = shop();
    let p = receive(&mut s, "2026-06-15", "4");
    let before = stock_of(&s.conn, s.zhonghua);

    let r = do_split(
        &mut s.conn,
        p,
        json!({ "productId": s.zhonghua, "qty": "2", "bizDate": "2026-07-20" }),
    )
    .unwrap();

    // 库存总量一点没变 —— 拆的是单据，不是货
    assert_eq!(stock_of(&s.conn, s.zhonghua), before, "拆单不该动库存和均价");

    let row = |id: i64| -> (String, i64, String) {
        s.conn
            .query_row(
                "SELECT p.biz_date, pi.qty_milli, p.total_amount_cents || ''
                   FROM purchases p JOIN purchase_items pi ON pi.purchase_id = p.id
                  WHERE p.id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap()
    };

    let (kept_date, kept_qty, kept_total) = row(r.kept_purchase_id);
    let (moved_date, moved_qty, moved_total) = row(r.moved_purchase_id);

    assert_eq!((kept_date.as_str(), milli_to_qty(kept_qty)), ("2026-06-15", "2".to_string()));
    assert_eq!((moved_date.as_str(), milli_to_qty(moved_qty)), ("2026-07-20", "2".to_string()));
    // 520 一条 × 2 条 = 1040，两张各一半
    assert_eq!((kept_total.as_str(), moved_total.as_str()), ("104000", "104000"));
}

#[test]
fn 拆完原单作废两张新单挂在它名下() {
    let mut s = shop();
    let p = receive(&mut s, "2026-06-15", "4");
    let r = do_split(
        &mut s.conn,
        p,
        json!({ "productId": s.zhonghua, "qty": "2", "bizDate": "2026-07-20" }),
    )
    .unwrap();

    let voided: Option<String> = s
        .conn
        .query_row("SELECT voided_at FROM purchases WHERE id = ?1", [p], |r| r.get(0))
        .unwrap();
    assert!(voided.is_some(), "原单要作废，不原地改数量（红线 6）");

    let parents: Vec<i64> = {
        let mut stmt = s
            .conn
            .prepare("SELECT revision_of_purchase_id FROM purchases WHERE id IN (?1, ?2)")
            .unwrap();
        let rows = stmt
            .query_map([r.kept_purchase_id, r.moved_purchase_id], |x| x.get(0))
            .unwrap();
        rows.collect::<rusqlite::Result<_>>().unwrap()
    };
    assert_eq!(parents, vec![p, p], "两张都指回原单，查得出这批货是怎么来的");
}

#[test]
fn 拆单保留原单的成本快照() {
    // 拆一下不该改变进价。若走 receive 重录，按基础单位的成本要换算回录入单位，
    // 除不尽的那几厘会丢，两张单加起来就跟原来对不上
    let mut s = shop();
    let p = receive(&mut s, "2026-06-15", "3"); // 520 / 10 = 52.0000 每包
    let r = do_split(
        &mut s.conn,
        p,
        json!({ "productId": s.zhonghua, "qty": "1", "bizDate": "2026-07-20" }),
    )
    .unwrap();

    let cost = |id: i64| -> i64 {
        s.conn
            .query_row(
                "SELECT unit_cost_base_e4 FROM purchase_items WHERE purchase_id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap()
    };
    assert_eq!(cost(r.kept_purchase_id), 520_000);
    assert_eq!(cost(r.moved_purchase_id), 520_000);
    assert_eq!(e4_to_yuan(stock_of(&s.conn, s.zhonghua).1), "52.0000");
}

#[test]
fn 多商品的单只拆指定那一行() {
    let mut s = shop();
    let yuxi = insert_product(
        &s.conn,
        "INSERT INTO products (name, category, base_unit, pack_unit, pack_ratio)
         VALUES ('玉溪', 'cigarette', '包', '条', 10)",
    );
    let zhonghua = s.zhonghua;
    do_receive(
        &mut s.conn,
        json!({
            "bizDate": "2026-06-15",
            "items": [
                { "productId": zhonghua, "unit": "pack", "qty": "4", "unitCostYuan": "520" },
                { "productId": yuxi, "unit": "pack", "qty": "3", "unitCostYuan": "220" },
            ],
        }),
    )
    .unwrap();
    let p: i64 = s
        .conn
        .query_row("SELECT id FROM purchases ORDER BY id DESC LIMIT 1", [], |r| r.get(0))
        .unwrap();

    let r = do_split(
        &mut s.conn,
        p,
        json!({ "productId": zhonghua, "qty": "2", "bizDate": "2026-07-20" }),
    )
    .unwrap();

    let lines = |id: i64| -> i64 {
        count(
            &s.conn,
            &format!("SELECT COUNT(*) FROM purchase_items WHERE purchase_id = {id}"),
        )
    };
    assert_eq!(lines(r.kept_purchase_id), 2, "玉溪还在原来那张上");
    assert_eq!(lines(r.moved_purchase_id), 1, "挪走的只有中华那一行");
    assert_eq!(milli_to_qty(stock_of(&s.conn, yuxi).0), "30", "玉溪的库存一点没动");
}

#[test]
fn 要挪全部数量时让他去改日期() {
    // 整张单换个日期就完事了，没必要作废再建两张 —— 而且那样会留一张空单
    let mut s = shop();
    let p = receive(&mut s, "2026-06-15", "4");

    let err = err_of(do_split(
        &mut s.conn,
        p,
        json!({ "productId": s.zhonghua, "qty": "4", "bizDate": "2026-07-20" }),
    ));
    assert!(err.contains("改这张单的日期"), "得指一条出路：{err}");
}

#[test]
fn 拆不存在的商品说得清楚() {
    let mut s = shop();
    let p = receive(&mut s, "2026-06-15", "4");
    let err = err_of(do_split(
        &mut s.conn,
        p,
        json!({ "productId": 999, "qty": "1", "bizDate": "2026-07-20" }),
    ));
    assert!(err.contains("没有这个商品"), "{err}");
}

#[test]
fn 拆完流水加起来仍然等于结存() {
    // 拆单要写一堆流水：撤销的反向流水 + 两张新单的正向流水。
    // 少写一条或方向写反，结存快照和流水就对不上了，而这正是「账对不上又查不出原因」
    let mut s = shop();
    let p = receive(&mut s, "2026-06-15", "4");
    do_split(
        &mut s.conn,
        p,
        json!({ "productId": s.zhonghua, "qty": "2", "bizDate": "2026-07-20" }),
    )
    .unwrap();

    let from_movements = recompute_qty_from_movements(&s.conn, s.zhonghua).unwrap();
    assert_eq!(from_movements, stock_of(&s.conn, s.zhonghua).0);
    assert_eq!(milli_to_qty(from_movements), "40");
}
