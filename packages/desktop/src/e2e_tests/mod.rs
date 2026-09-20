//! 端到端：把数据模型证伪一遍。
//!
//! 建表建出来不算数据模型做完了。真正的验收是走一遍真实业务，
//! 检查四件事：单位换算、加权成本、流水完整性、结存数字。
//!
//! 入参一律从 JSON 构造 —— 前端送过来的就是 JSON，测试走同一条反序列化
//! 路径才算真的测到了。直接拼 struct 会把「字段名写错」这类错误漏掉。

use rusqlite::Connection;
use serde_json::{json, Value};

use crate::db::open_memory;
use crate::error::Result;
use crate::money::{cents_to_yuan, e4_to_yuan, milli_to_qty};
use crate::services::inventory::recompute_qty_from_movements;
use crate::services::payments::{collect, CollectInput, CollectResult};
use crate::services::purchases::{receive, ReceiveInput, ReceiveResult};
use crate::services::rebuild_allocations::{read_debt, CustomerDebt};
use crate::services::reversals::{
    return_sale, revise_sale, void_payment, void_purchase, void_sale, ReturnInput, ReturnResult,
    ReviseResult, VoidPurchaseResult, VoidReason,
};
use crate::services::sales::{checkout, CheckoutInput, CheckoutOptions, CheckoutResult};

// ── 脚手架 ────────────────────────────────────────────────

/// 把一次操作包进事务，跟 `AppState::tx` 同一套语义。
/// 出错时 Transaction 被丢弃即回滚 —— 「失败的结账不留半张单」靠的就是它。
fn tx<T>(conn: &mut Connection, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
    let t = conn.transaction()?;
    let out = f(&t)?;
    t.commit()?;
    Ok(out)
}

fn do_receive(conn: &mut Connection, v: Value) -> Result<ReceiveResult> {
    let input: ReceiveInput = serde_json::from_value(v)?;
    tx(conn, |c| receive(c, &input))
}

fn do_checkout(conn: &mut Connection, v: Value) -> Result<CheckoutResult> {
    let input: CheckoutInput = serde_json::from_value(v)?;
    tx(conn, |c| checkout(c, &input, &CheckoutOptions::default()))
}

fn do_collect(conn: &mut Connection, v: Value) -> Result<CollectResult> {
    let input: CollectInput = serde_json::from_value(v)?;
    tx(conn, |c| collect(c, &input))
}

fn do_revise(conn: &mut Connection, sale_id: i64, v: Value) -> Result<ReviseResult> {
    let input: CheckoutInput = serde_json::from_value(v)?;
    tx(conn, |c| revise_sale(c, sale_id, &input))
}

fn do_return(conn: &mut Connection, sale_id: i64, v: Value) -> Result<ReturnResult> {
    let input: ReturnInput = serde_json::from_value(v)?;
    tx(conn, |c| return_sale(c, sale_id, &input))
}

fn do_void_sale(conn: &mut Connection, sale_id: i64) -> Result<()> {
    tx(conn, |c| void_sale(c, sale_id, VoidReason::Mistake)).map(|_| ())
}

fn do_void_purchase(conn: &mut Connection, id: i64) -> Result<VoidPurchaseResult> {
    tx(conn, |c| void_purchase(c, id, VoidReason::Mistake))
}

fn do_void_payment(conn: &mut Connection, id: i64) -> Result<()> {
    tx(conn, |c| void_payment(c, id, VoidReason::Mistake))
}

fn debt(conn: &Connection, customer_id: i64) -> CustomerDebt {
    read_debt(conn, customer_id).unwrap()
}

/// 某商品的结存快照 (数量 milli, 均价 e4)。
fn stock_of(conn: &Connection, product_id: i64) -> (i64, i64) {
    conn.query_row(
        "SELECT qty_base_milli, avg_cost_base_e4 FROM inventory WHERE product_id = ?1",
        [product_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .unwrap()
}

fn sum_cents(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get::<_, Option<i64>>(0))
        .unwrap()
        .unwrap_or(0)
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |r| r.get(0)).unwrap()
}

fn insert_product(conn: &Connection, sql: &str) -> i64 {
    conn.execute(sql, []).unwrap();
    conn.last_insert_rowid()
}

/// 拿到那句拒绝的话。测试只断言关键词，不逐字对全句 ——
/// 措辞改一个字就红一片，那样的测试只会让人把它删掉。
fn err_of<T>(r: Result<T>) -> String {
    r.err().expect("这一步本该被拒绝").to_string()
}

mod bulk;
mod expenses;
mod frequent;
mod invariants;
mod ledger;
mod onboarding;
mod pricing;
mod products;
mod redate;
mod reports;
mod service_fees;
mod statements;
mod stock;
mod reversals;
