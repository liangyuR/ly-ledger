//! 服务型收费 —— 桌子费、包间费这类。
//!
//! 它不是杂项收入，是**卖出去的东西**：有价、有收入、可能挂在客户账上，
//! 也该进当月毛利。所以它走的是正常销售单，跟卖一包烟同一条路径 ——
//! 报表、挂账、核销、作废、改单全部免费复用（migrations/004 里写了为什么）。
//!
//! 跟实物的唯一区别是没有库存：不进 stock_movements、没有进价、毛利就是全额。
//! 这个区别由 `products.is_service` 表达，在 `sales::checkout` 里分叉。

use rusqlite::Connection;

use crate::error::Result;

/// 一个收费项目。桌子费是打底的那个，以后可以再建包间费、茶位费。
#[derive(Debug, serde::Serialize)]
pub struct ServiceItem {
    pub id: i64,
    pub name: String,
    /// 计价单位，「次」「小时」这类
    pub unit: String,
    /// 最近常收的几个价，点一下就填上
    pub common_amounts_cents: Vec<i64>,
}

/// 老板常收的那几个价。
///
/// 不写死 200/300/600 —— 每家店不一样，而且季节一变价就变。
/// 数最近 90 天收过的，按次数排：他这个月收得最多的那几个自然浮上来。
fn common_amounts(conn: &Connection, product_id: i64) -> Result<Vec<i64>> {
    let day = crate::services::reports::today(conn)?;
    let mut stmt = conn.prepare(
        "SELECT si.unit_price_cents, COUNT(*) AS n
           FROM sale_items si JOIN sales s ON s.id = si.sale_id
          WHERE si.product_id = ?1
            AND s.voided_at IS NULL
            AND s.biz_date >= date(?2, '-90 day')
            AND si.unit_price_cents > 0
          GROUP BY si.unit_price_cents
          ORDER BY n DESC, si.unit_price_cents
          LIMIT 6",
    )?;
    let rows = stmt.query_map(rusqlite::params![product_id, day], |r| r.get::<_, i64>(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn list(conn: &Connection) -> Result<Vec<ServiceItem>> {
    let raw: Vec<(i64, String, String)> = {
        let mut stmt = conn.prepare(
            "SELECT id, name, base_unit FROM products
              WHERE is_service = 1 AND is_active = 1
              ORDER BY sort_weight DESC, id",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };

    let mut out = Vec::with_capacity(raw.len());
    for (id, name, unit) in raw {
        out.push(ServiceItem {
            common_amounts_cents: common_amounts(&conn, id)?,
            id,
            name,
            unit,
        });
    }
    Ok(out)
}

/// 今天收了哪几笔。作废过的也列出来，标一下 —— 撤完就消失会让人以为撤错了别的。
pub struct FeeRow {
    pub sale_id: i64,
    pub time: String,
    pub name: String,
    pub amount_cents: i64,
    pub settle_type: String,
    pub customer_name: Option<String>,
    pub voided: bool,
}

pub fn today_fees(conn: &Connection, biz_date: &str) -> Result<Vec<FeeRow>> {
    let mut stmt = conn.prepare(
        "SELECT s.id, s.created_at, p.name, si.amount_cents, s.settle_type, c.name,
                s.voided_at IS NOT NULL
           FROM sales s
           JOIN sale_items si ON si.sale_id = s.id
           JOIN products p    ON p.id = si.product_id
           LEFT JOIN customers c ON c.id = s.customer_id
          WHERE p.is_service = 1 AND s.biz_date = ?1
          ORDER BY s.id DESC",
    )?;
    let rows = stmt.query_map([biz_date], |r| {
        Ok(FeeRow {
            sale_id: r.get(0)?,
            time: r.get::<_, String>(1)?.chars().skip(11).take(5).collect(),
            name: r.get(2)?,
            amount_cents: r.get(3)?,
            settle_type: r.get(4)?,
            customer_name: r.get(5)?,
            voided: r.get(6)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// 今天一共收了多少（不含作废的）。
pub fn today_total(conn: &Connection, biz_date: &str) -> Result<i64> {
    let v: Option<i64> = conn.query_row(
        "SELECT SUM(si.amount_cents)
           FROM sales s
           JOIN sale_items si ON si.sale_id = s.id
           JOIN products p    ON p.id = si.product_id
          WHERE p.is_service = 1 AND s.biz_date = ?1 AND s.voided_at IS NULL",
        [biz_date],
        |r| r.get(0),
    )?;
    Ok(v.unwrap_or(0))
}
