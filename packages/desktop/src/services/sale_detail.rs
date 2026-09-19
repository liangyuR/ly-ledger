//! 单据详情。
//!
//! 界面上老板看到的是「这张单的经过」，不是「作废/红冲/反向凭证」那套会计词汇。
//! 但底下的修订链必须是完整可查的 —— 改错账是产品功能，而不是「直接改库」，
//! 代价就是每次改动都留一条记录（docs/05）。

use std::collections::HashSet;

use rusqlite::{Connection, OptionalExtension};

use crate::bail;
use crate::error::Result;
use crate::money::milli_to_qty;

pub struct SaleItemDetail {
    pub product_id: i64,
    pub name: String,
    pub unit: String,
    pub unit_label: String,
    pub qty_milli: i64,
    pub unit_price_cents: i64,
    pub amount_cents: i64,
    pub unit_cost_e4: i64,
    pub cost_cents: i64,
    pub profit_cents: i64,
}

pub struct SaleEvent {
    pub kind: &'static str,
    pub sale_id: i64,
    pub at: String,
    pub rev: i64,
    pub summary: String,
    pub current: bool,
}

pub struct SaleDetail {
    pub id: i64,
    pub biz_date: String,
    pub created_at: String,
    pub settle_type: String,
    pub customer_id: Option<i64>,
    pub customer_name: Option<String>,
    pub original_cents: i64,
    pub discount_cents: i64,
    pub total_cents: i64,
    pub cost_cents: i64,
    pub profit_cents: i64,
    pub note: String,
    pub voided_at: Option<String>,
    pub void_reason: Option<String>,
    pub rev: i64,
    // 修订链的三根指针。界面不显示它们（出参里也没有，跟 Node 版一致），
    // 但「旧版本要能指向最新那张」这条结论要靠它们来断言
    #[allow(dead_code)]
    pub revision_of_sale_id: Option<i64>,
    #[allow(dead_code)]
    pub superseded_by_sale_id: Option<i64>,
    #[allow(dead_code)]
    pub return_of_sale_id: Option<i64>,
    /// 已退回多少（金额为负）
    pub returned_cents: i64,
    /// 挂账单已核销多少
    pub settled_cents: i64,
    pub items: Vec<SaleItemDetail>,
    pub events: Vec<SaleEvent>,
    /// 能不能改 / 能不能退 —— 由后端判断，前端不要自己猜
    pub can_revise: bool,
    pub can_return: bool,
    pub blocked_reason: Option<String>,
}

#[derive(Clone)]
struct Row {
    id: i64,
    biz_date: String,
    created_at: String,
    settle_type: String,
    customer_id: Option<i64>,
    customer_name: Option<String>,
    original_amount_cents: i64,
    discount_amount_cents: i64,
    total_amount_cents: i64,
    cost_amount_cents: i64,
    gross_profit_cents: i64,
    note: String,
    voided_at: Option<String>,
    void_reason: Option<String>,
    rev: i64,
    revision_of_sale_id: Option<i64>,
    superseded_by_sale_id: Option<i64>,
    return_of_sale_id: Option<i64>,
}

fn load_row(conn: &Connection, id: i64) -> Result<Option<Row>> {
    let row = conn
        .query_row(
            "SELECT s.id, s.biz_date, s.created_at, s.settle_type, s.customer_id, c.name,
                    s.original_amount_cents, s.discount_amount_cents, s.total_amount_cents,
                    s.cost_amount_cents, s.gross_profit_cents, s.note, s.voided_at, s.void_reason,
                    s.rev, s.revision_of_sale_id, s.superseded_by_sale_id, s.return_of_sale_id
               FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
              WHERE s.id = ?1",
            [id],
            |r| {
                Ok(Row {
                    id: r.get(0)?,
                    biz_date: r.get(1)?,
                    created_at: r.get(2)?,
                    settle_type: r.get(3)?,
                    customer_id: r.get(4)?,
                    customer_name: r.get(5)?,
                    original_amount_cents: r.get(6)?,
                    discount_amount_cents: r.get(7)?,
                    total_amount_cents: r.get(8)?,
                    cost_amount_cents: r.get(9)?,
                    gross_profit_cents: r.get(10)?,
                    note: r.get(11)?,
                    voided_at: r.get(12)?,
                    void_reason: r.get(13)?,
                    rev: r.get(14)?,
                    revision_of_sale_id: r.get(15)?,
                    superseded_by_sale_id: r.get(16)?,
                    return_of_sale_id: r.get(17)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

/// 顺着 revision_of_sale_id 一路回溯到最初那张单。
fn origin_of(conn: &Connection, row: &Row) -> Result<Row> {
    let mut cur = row.clone();
    let mut seen: HashSet<i64> = HashSet::from([cur.id]);
    while let Some(prev_id) = cur.revision_of_sale_id {
        // 理论上不会成环，但链是数据驱动的，出了环就得停 —— 不能把界面转死
        let Some(prev) = load_row(conn, prev_id)? else {
            break;
        };
        if !seen.insert(prev.id) {
            break;
        }
        cur = prev;
    }
    Ok(cur)
}

/// 从最初那张单顺着 superseded_by_sale_id 往下走完整条链。
fn chain_of(conn: &Connection, row: &Row) -> Result<Vec<Row>> {
    let first = origin_of(conn, row)?;
    let mut seen: HashSet<i64> = HashSet::from([first.id]);
    let mut chain = vec![first];
    loop {
        let Some(next) = chain[chain.len() - 1].superseded_by_sale_id else {
            break;
        };
        if seen.contains(&next) {
            break;
        }
        let Some(r) = load_row(conn, next)? else {
            break;
        };
        seen.insert(r.id);
        chain.push(r);
    }
    Ok(chain)
}

pub fn items_of(conn: &Connection, sale_id: i64) -> Result<Vec<SaleItemDetail>> {
    let mut stmt = conn.prepare(
        "SELECT si.product_id, p.name, si.unit, p.base_unit, p.pack_unit,
                si.qty_milli, si.unit_price_cents, si.amount_cents,
                si.unit_cost_base_e4, si.cost_amount_cents
           FROM sale_items si JOIN products p ON p.id = si.product_id
          WHERE si.sale_id = ?1 ORDER BY si.id",
    )?;
    let rows = stmt.query_map([sale_id], |r| {
        let unit: String = r.get(2)?;
        let base_unit: String = r.get(3)?;
        let pack_unit: Option<String> = r.get(4)?;
        let amount_cents: i64 = r.get(7)?;
        let cost_cents: i64 = r.get(9)?;
        Ok(SaleItemDetail {
            product_id: r.get(0)?,
            name: r.get(1)?,
            unit_label: if unit == "pack" {
                pack_unit.unwrap_or_else(|| base_unit.clone())
            } else {
                base_unit.clone()
            },
            unit,
            qty_milli: r.get(5)?,
            unit_price_cents: r.get(6)?,
            amount_cents,
            unit_cost_e4: r.get(8)?,
            cost_cents,
            profit_cents: amount_cents - cost_cents,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// 一句话说清这张单是什么。
fn summarize(conn: &Connection, sale_id: i64) -> Result<String> {
    let items = items_of(conn, sale_id)?;
    if items.is_empty() {
        return Ok("没有明细".to_string());
    }
    let head = &items[0];
    let first = format!(
        "{} {} {}",
        head.name,
        milli_to_qty(head.qty_milli.abs()),
        head.unit_label
    );
    Ok(if items.len() > 1 {
        format!("{first} 等 {} 样", items.len())
    } else {
        first
    })
}

pub fn sale_detail(conn: &Connection, id: i64) -> Result<SaleDetail> {
    let Some(row) = load_row(conn, id)? else {
        bail!("单据不存在：{id}");
    };

    let chain = chain_of(conn, &row)?;

    let mut events: Vec<SaleEvent> = Vec::new();
    for (i, r) in chain.iter().enumerate() {
        events.push(SaleEvent {
            kind: if i == 0 { "created" } else { "revised" },
            sale_id: r.id,
            at: r.created_at.clone(),
            rev: r.rev,
            summary: summarize(conn, r.id)?,
            current: r.voided_at.is_none(),
        });
    }

    // 退货挂在这张单上，按发生时间插进经过里
    let returns: Vec<(i64, String, String, i64)> = {
        let mut stmt = conn.prepare(
            "SELECT id, biz_date, created_at, total_amount_cents
               FROM sales WHERE return_of_sale_id = ?1 AND voided_at IS NULL ORDER BY id",
        )?;
        let rows = stmt.query_map([row.id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };

    for (rid, biz_date, created_at, _) in &returns {
        events.push(SaleEvent {
            kind: "returned",
            sale_id: *rid,
            at: created_at.clone(),
            rev: 0,
            summary: format!("退货　{biz_date}"),
            current: false,
        });
    }

    if let Some(voided_at) = &row.voided_at {
        if row.void_reason.as_deref() != Some("revised") {
            events.push(SaleEvent {
                kind: "voided",
                sale_id: row.id,
                at: voided_at.clone(),
                rev: row.rev,
                summary: "这笔生意没发生过".to_string(),
                current: false,
            });
        }
    }

    events.sort_by(|a, b| (&a.at, a.sale_id).cmp(&(&b.at, b.sale_id)));

    let returned_cents: i64 = returns.iter().map(|(_, _, _, amt)| amt).sum();
    let settled_cents: i64 = conn.query_row(
        "SELECT COALESCE(SUM(amount_cents), 0) FROM payment_allocations WHERE sale_id = ?1",
        [row.id],
        |r| r.get(0),
    )?;

    // 能不能改 / 能不能退，由后端说了算 —— 前端各自猜一遍迟早猜岔
    let blocked_reason: Option<String> = if row.voided_at.is_some() {
        Some(if row.void_reason.as_deref() == Some("revised") {
            "这是旧版本，请打开最新那张".to_string()
        } else {
            "这张单已经作废了".to_string()
        })
    } else if row.return_of_sale_id.is_some() {
        Some("这是一张退货单".to_string())
    } else {
        None
    };

    let can_revise = blocked_reason.is_none();
    let can_return = can_revise && row.total_amount_cents + returned_cents > 0;

    Ok(SaleDetail {
        id: row.id,
        biz_date: row.biz_date,
        created_at: row.created_at,
        settle_type: row.settle_type,
        customer_id: row.customer_id,
        customer_name: row.customer_name,
        original_cents: row.original_amount_cents,
        discount_cents: row.discount_amount_cents,
        total_cents: row.total_amount_cents,
        cost_cents: row.cost_amount_cents,
        profit_cents: row.gross_profit_cents,
        note: row.note,
        voided_at: row.voided_at,
        void_reason: row.void_reason,
        rev: row.rev,
        revision_of_sale_id: row.revision_of_sale_id,
        superseded_by_sale_id: row.superseded_by_sale_id,
        return_of_sale_id: row.return_of_sale_id,
        returned_cents,
        settled_cents,
        items: items_of(conn, row.id)?,
        events,
        can_revise,
        can_return,
        blocked_reason,
    })
}

pub struct SaleListRow {
    pub id: i64,
    pub time: String,
    pub summary: String,
    pub total_cents: i64,
    pub settle_type: String,
    pub customer_name: Option<String>,
}

/// 某天的流水，给看板和单据列表用。
pub fn list_sales(conn: &Connection, biz_date: &str) -> Result<Vec<SaleListRow>> {
    let raw: Vec<(i64, String, i64, String, Option<String>)> = {
        let mut stmt = conn.prepare(
            "SELECT s.id, s.created_at, s.total_amount_cents, s.settle_type, c.name
               FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
              WHERE s.biz_date = ?1 AND s.voided_at IS NULL
              ORDER BY s.id DESC",
        )?;
        let rows = stmt.query_map([biz_date], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };

    let mut out = Vec::with_capacity(raw.len());
    for (id, created_at, total_cents, settle_type, customer_name) in raw {
        out.push(SaleListRow {
            id,
            time: created_at.chars().skip(11).take(5).collect(),
            summary: summarize(conn, id)?,
            total_cents,
            settle_type,
            customer_name,
        });
    }
    Ok(out)
}
