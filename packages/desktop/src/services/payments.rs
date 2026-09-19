//! 收款。
//!
//! 老板的心智是「老王还了 500」，不关心具体是哪几笔 —— 所以收款记在**客户**身上，
//! 系统自动 FIFO 核销，不让他选核销哪张单。
//!
//! **收多了照收。** 分配不完的余额自动成为预收，下次挂账买货时重算会把它核销掉。
//! 不需要新表也不需要新字段 —— 它是「核销可重算」的免费副产品（docs/05）。

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;

use crate::ensure;
use crate::error::Result;
use crate::money::{yuan_to_cents, Decimalish};
use crate::services::rebuild_allocations::{rebuild_allocations, read_debt, CustomerDebt};
use crate::services::sales::PayMethod;
use crate::validate::check_biz_date;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectInput {
    pub biz_date: String,
    pub customer_id: i64,
    pub amount_yuan: Decimalish,
    pub method: PayMethod,
    #[serde(default)]
    pub note: Option<String>,
}

pub struct CollectResult {
    pub payment_id: i64,
    /// 分配不完的余额 = 预收
    pub prepaid_cents: i64,
    pub debt: CustomerDebt,
}

/// 调用方负责开事务（见 `AppState::tx`）。
pub fn collect(conn: &Connection, input: &CollectInput) -> Result<CollectResult> {
    check_biz_date(&input.biz_date)?;
    let amount_cents = yuan_to_cents(&input.amount_yuan)?;

    ensure!(
        amount_cents > 0,
        "收款金额必须为正。录错了要撤销，走作废，不是记一笔负数"
    );

    let exists: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM customers WHERE id = ?1",
            [input.customer_id],
            |r| r.get(0),
        )
        .optional()?;
    if exists.is_none() {
        crate::bail!("客户不存在：{}", input.customer_id);
    }

    conn.execute(
        "INSERT INTO payments (biz_date, customer_id, amount_cents, method, source, note)
         VALUES (?1, ?2, ?3, ?4, 'collect', ?5)",
        params![
            input.biz_date,
            input.customer_id,
            amount_cents,
            input.method.as_str(),
            input.note.as_deref().unwrap_or(""),
        ],
    )?;
    let payment_id = conn.last_insert_rowid();

    // 全量重算，不是增量追加 —— 补录和改期都会改变 FIFO 顺序
    let result = rebuild_allocations(conn, input.customer_id)?;

    Ok(CollectResult {
        payment_id,
        prepaid_cents: result.prepaid_cents,
        debt: read_debt(conn, input.customer_id)?,
    })
}
