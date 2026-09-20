//! 改业务日期 —— 补录用。
//!
//! `biz_date` 是**唯二允许原地改**的字段之一（另一个是 `note`）：红线 2 说补录是
//! 常态，昨天忙忘了、今天补上，日期必须能改回昨天。金额、数量、商品一律不许
//! 原地改，那些走作废重建（docs/05）。
//!
//! 改期不是没有副作用的：挂账单的核销按 `biz_date` 升序 FIFO 排，改了日期不重算，
//! 账龄就是错的 —— 而「最早一笔 45 天前」正是收款页的排序依据，也是老板决定
//! 先给谁打电话的依据。一个按错误账龄排序的催收列表，比没有列表更糟（docs/05）。
//!
//! **库存流水的 biz_date 不跟着改。** 它是只追加的表（docs/02），而且全系统没有
//! 任何一处按它的日期取数 —— 结存是全量求和，报表看的是单据上的日期。
//! 为了一个没人读的字段去 UPDATE 一张声明为只追加的表，不划算也不安全。

use rusqlite::{params, Connection, OptionalExtension};

use crate::bail;
use crate::error::Result;
use crate::services::rebuild_allocations::rebuild_allocations;
use crate::validate::check_biz_date;

pub struct Redated {
    pub id: i64,
    pub from: String,
    pub to: String,
}

/// 改一张销售单的业务日期。
///
/// 退货单也能改 —— 退货发生在哪天就记在哪天，记错了同样要能纠。
pub fn set_sale_date(conn: &Connection, sale_id: i64, biz_date: &str) -> Result<Redated> {
    check_biz_date(biz_date)?;

    let row = conn
        .query_row(
            "SELECT biz_date, customer_id, voided_at FROM sales WHERE id = ?1",
            [sale_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<i64>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()?;

    let Some((from, customer_id, voided_at)) = row else {
        bail!("单据不存在：{sale_id}");
    };
    if voided_at.is_some() {
        bail!("这张单已经作废了，改日期没有意义");
    }

    conn.execute(
        "UPDATE sales SET biz_date = ?1 WHERE id = ?2",
        params![biz_date, sale_id],
    )?;

    // 挂账单换了日期就换了 FIFO 里的位置，核销和账龄必须重算（docs/05）。
    //
    // 部分付那笔收款留在原来的日期上：payments 没有指回销售单的外键，
    // 认不出哪一笔是这张单带出来的。重算本身不受影响 —— 它把该客户所有
    // 未作废的单和款全量重排，只是那笔款的账龄仍按它自己的日期算
    if let Some(cid) = customer_id {
        rebuild_allocations(conn, cid)?;
    }

    Ok(Redated {
        id: sale_id,
        from,
        to: biz_date.to_string(),
    })
}

/// 改一张进货单的业务日期。
///
/// 比销售单简单：进货不挂客户，没有核销要重算。加权成本也不受影响 ——
/// 它是按流水**写入顺序**累积的，不按业务日期重排（docs/05 那条取舍）。
/// 改日期只改这批货算进哪个月的进货额、以及「近 90 天补过几次货」那个排序。
pub fn set_purchase_date(conn: &Connection, purchase_id: i64, biz_date: &str) -> Result<Redated> {
    check_biz_date(biz_date)?;

    let row = conn
        .query_row(
            "SELECT biz_date, voided_at FROM purchases WHERE id = ?1",
            [purchase_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
        )
        .optional()?;

    let Some((from, voided_at)) = row else {
        bail!("进货单不存在：{purchase_id}");
    };
    if voided_at.is_some() {
        bail!("这张进货单已经撤销了，改日期没有意义");
    }

    conn.execute(
        "UPDATE purchases SET biz_date = ?1 WHERE id = ?2",
        params![biz_date, purchase_id],
    )?;

    Ok(Redated {
        id: purchase_id,
        from,
        to: biz_date.to_string(),
    })
}
