//! 往来对账 —— 导出的欠款表背后那份数据。
//!
//! 欠款列表答的是「现在谁欠我多少」，够催账用；对账表答的是
//! 「这一年我们之间发生过什么」。后者少一笔，年底坐下来核对时就得靠回忆。

use super::*;

use crate::services::reports::{customer_statements, list_debts, CustomerStatement};

struct Shop {
    conn: Connection,
    zhonghua: i64,
    zhangsan: i64,
}

fn shop() -> Shop {
    let conn = open_memory().unwrap();
    let zhonghua = insert_product(
        &conn,
        "INSERT INTO products (name, category, base_unit, pack_unit, pack_ratio)
         VALUES ('中华(硬)', 'cigarette', '包', '条', 10)",
    );
    conn.execute(
        "INSERT INTO customers (name, phone, note) VALUES ('张三', '13812345678', '隔壁五金店')",
        [],
    )
    .unwrap();
    let zhangsan = conn.last_insert_rowid();

    let mut s = Shop {
        conn,
        zhonghua,
        zhangsan,
    };
    do_receive(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-01",
            "items": [{ "productId": zhonghua, "unit": "pack", "qty": "20", "unitCostYuan": "400" }],
        }),
    )
    .unwrap();
    s
}

/// 挂一笔账，返回单号。
fn charge(s: &mut Shop, date: &str, yuan: &str) -> i64 {
    let (p, c) = (s.zhonghua, s.zhangsan);
    do_checkout(
        &mut s.conn,
        json!({
            "bizDate": date, "settleType": "credit", "customerId": c,
            "items": [{ "productId": p, "unit": "base", "qty": "1", "unitPriceYuan": yuan }],
        }),
    )
    .unwrap()
    .sale_id
}

fn pay(s: &mut Shop, date: &str, yuan: &str) -> i64 {
    let c = s.zhangsan;
    do_collect(
        &mut s.conn,
        json!({ "bizDate": date, "customerId": c, "amountYuan": yuan, "method": "cash" }),
    )
    .unwrap()
    .payment_id
}

fn only(conn: &Connection) -> CustomerStatement {
    let mut all = customer_statements(conn, None).unwrap();
    assert_eq!(all.len(), 1, "这个场景只该有一个客户上表");
    all.remove(0)
}

/// 流水浓缩成 (类型, 发生额分, 结余分)，断言时一眼看得完。
fn flow(st: &CustomerStatement) -> Vec<(&str, i64, i64)> {
    st.entries
        .iter()
        .map(|e| (e.kind, e.amount_cents, e.balance_cents))
        .collect()
}

// ═══════════════════ 中途部分还款 ═══════════════════

#[test]
fn 电话和备注跟着对账一起出来() {
    // 催账就是打电话。号码得跟着这份数据走，不能逼老板另外翻本子
    let mut s = shop();
    charge(&mut s, "2026-09-10", "1200");

    let st = only(&s.conn);
    assert_eq!(st.phone, "13812345678");
    assert_eq!(st.note, "隔壁五金店");

    let debts = list_debts(&s.conn, None).unwrap();
    assert_eq!(debts.owing[0].phone, "13812345678", "欠款列表也要带上");
}

#[test]
fn 挂一千二还五百三个数字都要在表上() {
    // 只给一个 700，年底对账时那 1200 和 500 就得靠回忆
    let mut s = shop();
    charge(&mut s, "2026-09-10", "1200");
    pay(&mut s, "2026-09-15", "500");

    let st = only(&s.conn);
    assert_eq!(st.charged_cents, 120_000);
    assert_eq!(st.paid_cents, 50_000);
    assert_eq!(st.balance_cents, 70_000);
    assert_eq!(
        flow(&st),
        vec![("挂账", 120_000, 120_000), ("还款", -50_000, 70_000)],
    );
}

#[test]
fn 还完的客户不从表上消失() {
    let mut s = shop();
    charge(&mut s, "2026-09-10", "1200");
    pay(&mut s, "2026-09-15", "1200");

    let st = only(&s.conn);
    assert_eq!(st.balance_cents, 0, "结清了");
    assert_eq!(st.charged_cents, 120_000, "但这一年发生过的事还在");
    assert_eq!(st.entries.len(), 2);
}

#[test]
fn 结清的排在还欠钱的后面() {
    let mut s = shop();
    charge(&mut s, "2026-09-10", "1200");
    pay(&mut s, "2026-09-15", "1200");

    s.conn
        .execute("INSERT INTO customers (name) VALUES ('李四')", [])
        .unwrap();
    let lisi = s.conn.last_insert_rowid();
    let p = s.zhonghua;
    do_checkout(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-12", "settleType": "credit", "customerId": lisi,
            "items": [{ "productId": p, "unit": "base", "qty": "1", "unitPriceYuan": "300" }],
        }),
    )
    .unwrap();

    let all = customer_statements(&s.conn, None).unwrap();
    assert_eq!(
        all.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
        vec!["李四", "张三"],
        "还欠钱的在前，结清的沉底",
    );
}

#[test]
fn 一笔生意都没做过的客户不进表() {
    // 建了档没做过生意，列出来只是噪音
    let s = shop();
    assert!(customer_statements(&s.conn, None).unwrap().is_empty());
}

// ═══════════════════ 口径 ═══════════════════

#[test]
fn 作废的挂账单和作废的收款都不进表() {
    let mut s = shop();
    let good = charge(&mut s, "2026-09-10", "1200");
    let bad = charge(&mut s, "2026-09-11", "999");
    do_void_sale(&mut s.conn, bad).unwrap();

    let p = pay(&mut s, "2026-09-15", "500");
    let bad_pay = pay(&mut s, "2026-09-16", "300");
    do_void_payment(&mut s.conn, bad_pay).unwrap();

    let st = only(&s.conn);
    assert_eq!(st.balance_cents, 70_000);
    assert_eq!(st.entries.len(), 2, "作废的两笔都不该露面");
    assert!(st.entries[0].ref_label.contains(&good.to_string()));
    assert!(st.entries[1].ref_label.contains(&p.to_string()));
}

#[test]
fn 退货冲抵单独一列不混进挂账合计() {
    let mut s = shop();
    let sale = charge(&mut s, "2026-09-10", "1200");
    // 不填 items = 整单退
    do_return(&mut s.conn, sale, json!({ "bizDate": "2026-09-11" })).unwrap();

    let st = only(&s.conn);
    assert_eq!(st.charged_cents, 120_000, "挂账合计不该被退货冲小");
    assert_eq!(st.returned_cents, 120_000);
    assert_eq!(st.balance_cents, 0);
    assert_eq!(flow(&st)[1], ("退货", -120_000, 0));
}

#[test]
fn 卖货时当场付的那部分单独标出来() {
    // 部分付就是一张挂账单 + 一笔同日收款，两笔都要看得见
    let mut s = shop();
    let (p, c) = (s.zhonghua, s.zhangsan);
    do_checkout(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-10", "settleType": "credit", "customerId": c,
            "items": [{ "productId": p, "unit": "base", "qty": "1", "unitPriceYuan": "1200" }],
            "partialPay": { "amountYuan": "500", "method": "cash" },
        }),
    )
    .unwrap();

    let st = only(&s.conn);
    assert_eq!(
        flow(&st),
        vec![("挂账", 120_000, 120_000), ("当场付", -50_000, 70_000)],
        "同一天，挂账必须排在收款前面 —— 钱不可能在挂账之前还掉",
    );
    assert_eq!(st.paid_cents, 50_000);
}

#[test]
fn 结余与欠款列表的净额是同一个数() {
    // 两张表并存就会有两份真相，钉死它们必须相等
    let mut s = shop();
    charge(&mut s, "2026-09-10", "1200");
    pay(&mut s, "2026-09-15", "500");
    charge(&mut s, "2026-09-18", "300");

    let st = only(&s.conn);
    let debts = list_debts(&s.conn, None).unwrap();
    let owing = debts.owing.iter().find(|r| r.customer_id == st.customer_id).unwrap();
    assert_eq!(st.balance_cents, owing.net_debt_cents);
    assert_eq!(st.aging_days, owing.aging_days, "账龄也必须是同一个数");
}

#[test]
fn 多收的钱结余转负是预收() {
    let mut s = shop();
    charge(&mut s, "2026-09-10", "1200");
    pay(&mut s, "2026-09-15", "1500");

    let st = only(&s.conn);
    assert_eq!(st.balance_cents, -30_000);
    assert_eq!(st.paid_cents, 150_000);
}

// ═══════════════════ 只看一个客户 ═══════════════════

#[test]
fn 只看一个客户时别人的账不掺进来() {
    // 挂账归还页点开一行走的就是这条路，跟导出共用同一个函数
    let mut s = shop();
    charge(&mut s, "2026-09-10", "1200");
    pay(&mut s, "2026-09-15", "500");

    s.conn
        .execute("INSERT INTO customers (name) VALUES ('李四')", [])
        .unwrap();
    let lisi = s.conn.last_insert_rowid();
    let p = s.zhonghua;
    do_checkout(
        &mut s.conn,
        json!({
            "bizDate": "2026-09-12", "settleType": "credit", "customerId": lisi,
            "items": [{ "productId": p, "unit": "base", "qty": "1", "unitPriceYuan": "300" }],
        }),
    )
    .unwrap();

    let one = customer_statements(&s.conn, Some(s.zhangsan)).unwrap();
    assert_eq!(one.len(), 1);
    assert_eq!(one[0].name, "张三");
    assert_eq!(one[0].balance_cents, 70_000);
    assert_eq!(one[0].entries.len(), 2, "李四那笔不该混进来");

    // 全量口径不受影响
    assert_eq!(customer_statements(&s.conn, None).unwrap().len(), 2);
}

#[test]
fn 只看一个没做过生意的客户得到空表() {
    let s = shop();
    assert!(customer_statements(&s.conn, Some(s.zhangsan)).unwrap().is_empty());
}
