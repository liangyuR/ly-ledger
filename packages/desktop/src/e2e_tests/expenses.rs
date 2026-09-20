//! 杂项开支：房租、水电、伙食这些跟商品无关的钱。
//!
//! 这张表最容易出的错是**串月**和**作废了还在合计里** ——
//! 两种都不报错，只是月底那个数字悄悄不对，而老板没有第二个地方可以对。

use super::*;

use crate::services::expenses::{add, month, void, MonthExpenses, NewExpense};

fn do_add(conn: &mut Connection, v: Value) -> Result<i64> {
    let input: NewExpense = serde_json::from_value(v)?;
    tx(conn, |c| add(c, &input))
}

fn do_void(conn: &mut Connection, id: i64) -> Result<()> {
    tx(conn, |c| void(c, id))
}

fn sep(conn: &Connection) -> MonthExpenses {
    month(conn, "2026-09").unwrap()
}

/// 记一笔 2026-09 的开支。
fn spend(conn: &mut Connection, day: &str, category: &str, yuan: &str) -> i64 {
    do_add(
        conn,
        json!({ "bizDate": format!("2026-09-{day}"), "category": category, "amountYuan": yuan }),
    )
    .unwrap()
}

// ═══════════════════ 记下来 ═══════════════════

#[test]
fn 记一笔房租就进了当月合计() {
    let mut conn = open_memory().unwrap();
    spend(&mut conn, "01", "房租", "3000");
    spend(&mut conn, "05", "水电", "280.50");

    let m = sep(&conn);
    assert_eq!(cents_to_yuan(m.total_cents), "3280.50");
    assert_eq!(m.items.len(), 2);
}

#[test]
fn 名目随便写不做枚举() {
    // 拦了老板就会把「摩托车加油」记成「其他」，记了等于没记
    let mut conn = open_memory().unwrap();
    spend(&mut conn, "03", "摩托车加油", "50");

    assert_eq!(sep(&conn).items[0].category, "摩托车加油");
}

#[test]
fn 备注可以不填() {
    let mut conn = open_memory().unwrap();
    do_add(
        &mut conn,
        json!({ "bizDate": "2026-09-01", "category": "伙食", "amountYuan": "60" }),
    )
    .unwrap();

    assert_eq!(sep(&conn).items[0].note, "");
}

// ═══════════════════ 拦住的 ═══════════════════

#[test]
fn 金额必须大于零() {
    let mut conn = open_memory().unwrap();
    let bad = do_add(
        &mut conn,
        json!({ "bizDate": "2026-09-01", "category": "房租", "amountYuan": "0" }),
    );
    assert!(err_of(bad).contains("大于零"));

    // 负开支就是收入，那是另一回事，不在这张表里表达
    let neg = do_add(
        &mut conn,
        json!({ "bizDate": "2026-09-01", "category": "房租", "amountYuan": "-100" }),
    );
    assert!(err_of(neg).contains("大于零"));
}

#[test]
fn 名目空着不让记() {
    let mut conn = open_memory().unwrap();
    let bad = do_add(
        &mut conn,
        json!({ "bizDate": "2026-09-01", "category": "  ", "amountYuan": "100" }),
    );
    assert!(err_of(bad).contains("花在哪儿"));
}

#[test]
fn 日期不合法直接拒绝() {
    let mut conn = open_memory().unwrap();
    let bad = do_add(
        &mut conn,
        json!({ "bizDate": "2026/09/01", "category": "房租", "amountYuan": "100" }),
    );
    assert!(err_of(bad).contains("YYYY-MM-DD"));
}

// ═══════════════════ 作废 ═══════════════════

#[test]
fn 作废掉的不算进合计也不在明细里() {
    let mut conn = open_memory().unwrap();
    spend(&mut conn, "01", "房租", "3000");
    let wrong = spend(&mut conn, "02", "水电", "9999");

    do_void(&mut conn, wrong).unwrap();

    let m = sep(&conn);
    assert_eq!(cents_to_yuan(m.total_cents), "3000.00");
    assert_eq!(m.items.len(), 1);
    // 行还在库里，只是不出现 —— 钱的记录不物理删除
    assert_eq!(count(&conn, "SELECT count(*) FROM expenses"), 2);
}

#[test]
fn 同一笔作废两次会被拦住() {
    let mut conn = open_memory().unwrap();
    let id = spend(&mut conn, "01", "房租", "3000");
    do_void(&mut conn, id).unwrap();

    assert!(err_of(do_void(&mut conn, id)).contains("已经作废"));
}

#[test]
fn 作废不存在的那笔说得清楚() {
    let mut conn = open_memory().unwrap();
    assert!(err_of(do_void(&mut conn, 999)).contains("没有这笔开支"));
}

// ═══════════════════ 归月与排序 ═══════════════════

#[test]
fn 上个月的钱不算进这个月() {
    let mut conn = open_memory().unwrap();
    spend(&mut conn, "01", "房租", "3000");
    do_add(
        &mut conn,
        json!({ "bizDate": "2026-08-31", "category": "房租", "amountYuan": "3000" }),
    )
    .unwrap();

    assert_eq!(cents_to_yuan(sep(&conn).total_cents), "3000.00");
    assert_eq!(
        cents_to_yuan(month(&conn, "2026-08").unwrap().total_cents),
        "3000.00",
    );
}

#[test]
fn 按名目小计花得多的排前面() {
    // 老板要知道的是「钱主要去哪儿了」
    let mut conn = open_memory().unwrap();
    spend(&mut conn, "01", "伙食", "60");
    spend(&mut conn, "02", "伙食", "80");
    spend(&mut conn, "03", "房租", "3000");

    let m = sep(&conn);
    let names: Vec<&str> = m.by_category.iter().map(|c| c.category.as_str()).collect();
    assert_eq!(names, vec!["房租", "伙食"]);
    assert_eq!(cents_to_yuan(m.by_category[1].amount_cents), "140.00");
    assert_eq!(m.by_category[1].count, 2);
}

#[test]
fn 明细最近的排最上面() {
    let mut conn = open_memory().unwrap();
    spend(&mut conn, "01", "房租", "3000");
    spend(&mut conn, "18", "水电", "280");

    let m = sep(&conn);
    assert_eq!(m.items[0].biz_date, "2026-09-18");
}

#[test]
fn 一分钱没花也给得出一张空表() {
    let conn = open_memory().unwrap();
    let m = sep(&conn);
    assert_eq!(m.total_cents, 0);
    assert!(m.items.is_empty() && m.by_category.is_empty());
}

// ═══════════════════ 改名目和备注 ═══════════════════
//
// 名目和备注不参与任何计算 —— 名目只是归类，备注只给人看。
// 写错了当场改回来，不值得走「作废 + 重记」（金额和日期错了才走那条）。

use crate::services::expenses::update;

fn do_update(conn: &mut Connection, id: i64, cat: Option<&str>, note: Option<&str>) -> Result<()> {
    tx(conn, |c| update(c, id, cat, note))
}

#[test]
fn 改名目之后按名目小计跟着变() {
    let mut conn = open_memory().unwrap();
    let id = spend(&mut conn, "03", "其他", "6000");

    do_update(&mut conn, id, Some("烟钱"), None).unwrap();

    let m = sep(&conn);
    assert_eq!(m.by_category.len(), 1);
    assert_eq!(m.by_category[0].category, "烟钱");
    assert_eq!(cents_to_yuan(m.total_cents), "6000.00", "金额不该跟着动");
}

#[test]
fn 只改备注时名目保持不变() {
    let mut conn = open_memory().unwrap();
    let id = spend(&mut conn, "03", "伙食", "216");

    do_update(&mut conn, id, None, Some("买菜")).unwrap();

    let m = sep(&conn);
    assert_eq!(m.items[0].category, "伙食");
    assert_eq!(m.items[0].note, "买菜");
}

#[test]
fn 名目不能改成空的() {
    // 空了这笔钱就归不了类，小计表上会多出一个没名字的格子
    let mut conn = open_memory().unwrap();
    let id = spend(&mut conn, "03", "伙食", "216");

    let err = err_of(do_update(&mut conn, id, Some("   "), None));
    assert!(err.contains("名目"), "{err}");
    assert_eq!(sep(&conn).items[0].category, "伙食", "拒了就一个字都别动");
}

#[test]
fn 作废过的开支改不动() {
    let mut conn = open_memory().unwrap();
    let id = spend(&mut conn, "03", "伙食", "216");
    do_void(&mut conn, id).unwrap();

    let err = err_of(do_update(&mut conn, id, Some("运费"), None));
    assert!(err.contains("作废"), "{err}");
}
