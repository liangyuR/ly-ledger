//! 核销重算与客户欠款读数。

use rusqlite::{params, Connection, OptionalExtension};

use crate::bail;
use crate::error::Result;
use crate::services::allocations::{
    compute_allocations, AllocResult, PaymentForAlloc, SaleForAlloc,
};

/// 重算某个客户的全部核销。
///
/// **作用域是单个客户，不是全库。** 单店数据量下这是毫秒级操作，
/// 不需要增量优化 —— 而增量追加会在补录、改期、作废之后算错账龄（docs/05）。
///
/// 触发时机：新增挂账单、作废/修改挂账单、改 biz_date、退货、
/// 新增/作废/修改收款，以及手工触发（逃生舱）。
pub fn rebuild_allocations(conn: &Connection, customer_id: i64) -> Result<AllocResult> {
    let sales: Vec<SaleForAlloc> = {
        let mut stmt = conn.prepare(
            "SELECT id, biz_date, total_amount_cents, return_of_sale_id
               FROM sales
              WHERE customer_id = ?1 AND settle_type = 'credit' AND voided_at IS NULL
              ORDER BY biz_date, id",
        )?;
        let rows = stmt.query_map([customer_id], |r| {
            Ok(SaleForAlloc {
                id: r.get(0)?,
                biz_date: r.get(1)?,
                total_cents: r.get(2)?,
                return_of_sale_id: r.get(3)?,
            })
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };

    let payments: Vec<PaymentForAlloc> = {
        let mut stmt = conn.prepare(
            "SELECT id, biz_date, amount_cents
               FROM payments
              WHERE customer_id = ?1 AND voided_at IS NULL
              ORDER BY biz_date, id",
        )?;
        let rows = stmt.query_map([customer_id], |r| {
            Ok(PaymentForAlloc {
                id: r.get(0)?,
                biz_date: r.get(1)?,
                amount_cents: r.get(2)?,
            })
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };

    let result = compute_allocations(&sales, &payments);

    // 先全删再重写。核销是派生数据，不是流水 —— 删了能原样算回来。
    conn.execute(
        "DELETE FROM payment_allocations
          WHERE payment_id IN (SELECT id FROM payments WHERE customer_id = ?1)",
        [customer_id],
    )?;

    {
        let mut insert = conn.prepare(
            "INSERT INTO payment_allocations (payment_id, sale_id, amount_cents) VALUES (?1, ?2, ?3)",
        )?;
        for a in &result.allocations {
            insert.execute(params![a.payment_id, a.sale_id, a.amount_cents])?;
        }
    }

    Ok(result)
}

#[derive(Debug, Clone)]
pub struct CustomerDebt {
    pub customer_id: i64,
    pub name: String,
    /// 正数 = 欠款，负数 = 预收
    pub net_debt_cents: i64,
    /// 最早一张未结清单的业务日期
    pub earliest_unpaid_date: Option<String>,
}

/// 客户净欠款 = 未作废挂账单合计 − 未作废收款合计。
///
/// 结果为负即预收 —— 不需要额外的表或字段，它是「核销可重算」的免费副产品。
pub fn read_debt(conn: &Connection, customer_id: i64) -> Result<CustomerDebt> {
    let row = conn
        .query_row(
            "SELECT c.id, c.name,
                    COALESCE((SELECT SUM(total_amount_cents) FROM sales
                               WHERE customer_id = c.id AND settle_type = 'credit' AND voided_at IS NULL), 0)
                  - COALESCE((SELECT SUM(amount_cents) FROM payments
                               WHERE customer_id = c.id AND voided_at IS NULL), 0) AS net
               FROM customers c WHERE c.id = ?1",
            [customer_id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)),
        )
        .optional()?;

    let Some((id, name, net)) = row else {
        bail!("客户不存在：{customer_id}");
    };

    let earliest: Option<String> = conn
        .query_row(
            "SELECT s.biz_date
               FROM sales s
              WHERE s.customer_id = ?1 AND s.settle_type = 'credit' AND s.voided_at IS NULL
                AND s.return_of_sale_id IS NULL
                AND s.total_amount_cents > COALESCE(
                      (SELECT SUM(amount_cents) FROM payment_allocations WHERE sale_id = s.id), 0)
                    + COALESCE(
                      (SELECT -SUM(total_amount_cents) FROM sales r WHERE r.return_of_sale_id = s.id
                         AND r.voided_at IS NULL), 0)
              ORDER BY s.biz_date, s.id
              LIMIT 1",
            [customer_id],
            |r| r.get::<_, String>(0),
        )
        .optional()?;

    Ok(CustomerDebt {
        customer_id: id,
        name,
        net_debt_cents: net,
        earliest_unpaid_date: earliest,
    })
}
