//! 看板与列表查询。
//!
//! 所有口径一律 `voided_at IS NULL`、一律按 `biz_date` 统计 ——
//! 用 created_at 当业务时间，补录一笔上周的账会静默算错上周报表（红线 2）。

use chrono::NaiveDate;
use rusqlite::Connection;

use crate::error::Result;
use crate::money::div_round;

/// 本机日期。老板说的「今天」是他那台电脑上的今天。
pub fn today(conn: &Connection) -> Result<String> {
    let d: String = conn.query_row("SELECT date('now', 'localtime')", [], |r| r.get(0))?;
    Ok(d)
}

fn month_of(date: &str) -> &str {
    &date[..7]
}

/// `to` 距 `from` 多少天。算账龄和闲置天数都用它。
pub fn days_since(from: &str, to: &str) -> Option<i64> {
    let a = NaiveDate::parse_from_str(from, "%Y-%m-%d").ok()?;
    let b = NaiveDate::parse_from_str(to, "%Y-%m-%d").ok()?;
    Some((b - a).num_days())
}

#[derive(Debug, Clone)]
pub struct DebtRow {
    pub customer_id: i64,
    pub name: String,
    /// 正数 = 欠款，负数 = 预收
    pub net_debt_cents: i64,
    pub earliest_unpaid_date: Option<String>,
    pub aging_days: Option<i64>,
}

pub struct Debts {
    pub owing: Vec<DebtRow>,
    pub prepaid: Vec<DebtRow>,
}

/// 欠款列表。**按账龄倒序 —— 拖得最久的排最前**，
/// 这才是老板该先打电话的人（docs/04）。
///
/// 预收客户（净额为负）单独返回，不混进催收队列 ——
/// 混进去会让这个列表失去可信度。
pub fn list_debts(conn: &Connection, as_of: Option<&str>) -> Result<Debts> {
    let day = match as_of {
        Some(d) => d.to_string(),
        None => today(conn)?,
    };

    let rows: Vec<DebtRow> = {
        let mut stmt = conn.prepare(
            "SELECT c.id, c.name,
                    COALESCE((SELECT SUM(total_amount_cents) FROM sales
                               WHERE customer_id = c.id AND settle_type = 'credit' AND voided_at IS NULL), 0)
                  - COALESCE((SELECT SUM(amount_cents) FROM payments
                               WHERE customer_id = c.id AND voided_at IS NULL), 0) AS net_debt_cents,
                    (SELECT MIN(s.biz_date) FROM sales s
                      WHERE s.customer_id = c.id AND s.settle_type = 'credit'
                        AND s.voided_at IS NULL AND s.return_of_sale_id IS NULL
                        AND s.total_amount_cents > COALESCE(
                              (SELECT SUM(amount_cents) FROM payment_allocations WHERE sale_id = s.id), 0)
                    ) AS earliest_unpaid_date
               FROM customers c
              WHERE c.is_active = 1",
        )?;
        let rows = stmt.query_map([], |r| {
            let earliest: Option<String> = r.get(3)?;
            Ok(DebtRow {
                customer_id: r.get(0)?,
                name: r.get(1)?,
                net_debt_cents: r.get(2)?,
                earliest_unpaid_date: earliest,
                aging_days: None,
            })
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };

    let with_aging: Vec<DebtRow> = rows
        .into_iter()
        .map(|mut r| {
            r.aging_days = r
                .earliest_unpaid_date
                .as_deref()
                .and_then(|d| days_since(d, &day));
            r
        })
        .collect();

    let mut owing: Vec<DebtRow> = with_aging
        .iter()
        .filter(|r| r.net_debt_cents > 0)
        .cloned()
        .collect();
    // 账龄倒序：最早那笔越久远越靠前
    owing.sort_by_key(|r| -r.aging_days.unwrap_or(0));

    let prepaid = with_aging
        .into_iter()
        .filter(|r| r.net_debt_cents < 0)
        .collect();

    Ok(Debts { owing, prepaid })
}

/// 字段名故意保持库里的列名（`base_unit` 而不是 `baseUnit`）——
/// 前端的 Product 接口吃的就是这套名字，改成驼峰会让常用商品格子整排空掉。
#[derive(Debug, serde::Serialize)]
pub struct FrequentProduct {
    pub id: i64,
    pub name: String,
    pub base_unit: String,
    pub pack_unit: Option<String>,
    pub pack_ratio: i64,
    pub price_base_cents: Option<i64>,
    pub price_pack_cents: Option<i64>,
    #[serde(rename = "soldQtyMilli")]
    pub sold_qty_milli: i64,
}

/// 常用商品：按近 30 天销量取前 N，可用 sort_weight 手动置顶。
/// 新店还没有销量时，退回按建档顺序 —— 不能给老板一个空格子。
pub fn frequent_products(conn: &Connection, limit: i64) -> Result<Vec<FrequentProduct>> {
    let day = today(conn)?;
    let mut stmt = conn.prepare(
        "SELECT p.id, p.name, p.base_unit, p.pack_unit, p.pack_ratio,
                p.price_base_cents, p.price_pack_cents,
                COALESCE(SUM(si.qty_base_milli), 0) AS sold_qty_milli
           FROM products p
           LEFT JOIN sale_items si ON si.product_id = p.id
           LEFT JOIN sales s ON s.id = si.sale_id
                AND s.voided_at IS NULL
                AND s.biz_date >= date(?1, '-30 day')
          WHERE p.is_active = 1
          GROUP BY p.id
          ORDER BY p.sort_weight DESC, sold_qty_milli DESC, p.id
          LIMIT ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![day, limit], |r| {
        Ok(FrequentProduct {
            id: r.get(0)?,
            name: r.get(1)?,
            base_unit: r.get(2)?,
            pack_unit: r.get(3)?,
            pack_ratio: r.get(4)?,
            price_base_cents: r.get(5)?,
            price_pack_cents: r.get(6)?,
            sold_qty_milli: r.get(7)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    pub kind: &'static str,
    pub count: i64,
    pub detail: &'static str,
}

pub struct RecentSale {
    pub id: i64,
    pub time: String,
    pub summary: String,
    pub total_cents: i64,
    pub settle_type: String,
    pub customer_name: Option<String>,
}

pub struct DashboardData {
    pub date: String,
    pub today_revenue_cents: i64,
    pub today_profit_cents: i64,
    pub month_profit_cents: i64,
    pub inventory_value_cents: i64,
    pub debt_total_cents: i64,
    pub debt_count: usize,
    pub alerts: Vec<Alert>,
    pub recent_sales: Vec<RecentSale>,
}

fn sum_cents(conn: &Connection, sql: &str, arg: &str) -> Result<i64> {
    let v: Option<i64> = conn.query_row(sql, [arg], |r| r.get(0))?;
    Ok(v.unwrap_or(0))
}

fn count_rows(conn: &Connection, sql: &str) -> Result<i64> {
    Ok(conn.query_row(sql, [], |r| r.get(0))?)
}

pub fn dashboard(conn: &Connection) -> Result<DashboardData> {
    let day = today(conn)?;
    let month = month_of(&day).to_string();

    let today_revenue_cents = sum_cents(
        conn,
        "SELECT SUM(total_amount_cents) FROM sales WHERE biz_date = ?1 AND voided_at IS NULL",
        &day,
    )?;
    let today_profit_cents = sum_cents(
        conn,
        "SELECT SUM(gross_profit_cents) FROM sales WHERE biz_date = ?1 AND voided_at IS NULL",
        &day,
    )?;
    let month_profit_cents = sum_cents(
        conn,
        "SELECT SUM(gross_profit_cents) FROM sales WHERE substr(biz_date, 1, 7) = ?1 AND voided_at IS NULL",
        &month,
    )?;

    // 库存金额只算正库存 —— 负库存是「可能漏记进货」，把它的负值算进资产没有意义
    let inventory_value_cents = {
        let mut stmt = conn.prepare(
            "SELECT qty_base_milli, avg_cost_base_e4 FROM inventory WHERE qty_base_milli > 0",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?;
        let mut acc = 0i64;
        for row in rows {
            let (q, c) = row?;
            acc += div_round(q as i128 * c as i128, 100_000)?;
        }
        acc
    };

    let debts = list_debts(conn, Some(&day))?;

    let negative_stock = count_rows(
        conn,
        "SELECT count(*) FROM inventory WHERE qty_base_milli < 0",
    )?;
    let missing_price = count_rows(
        conn,
        "SELECT count(*) FROM products WHERE is_active = 1
           AND price_base_cents IS NULL AND price_pack_cents IS NULL",
    )?;
    let stale: i64 = conn.query_row(
        "SELECT count(*) FROM inventory i
          WHERE i.qty_base_milli > 0
            AND NOT EXISTS (
              SELECT 1 FROM sale_items si JOIN sales s ON s.id = si.sale_id
               WHERE si.product_id = i.product_id AND s.voided_at IS NULL
                 AND s.biz_date >= date(?1, '-90 day'))",
        [&day],
        |r| r.get(0),
    )?;

    let mut alerts = Vec::new();
    if negative_stock > 0 {
        alerts.push(Alert {
            kind: "negative_stock",
            count: negative_stock,
            detail: "可能漏记进货。不拦你记账，只是提醒",
        });
    }
    if missing_price > 0 {
        alerts.push(Alert {
            kind: "missing_price",
            count: missing_price,
            detail: "没填价格不影响卖货，只是毛利算不出来",
        });
    }
    if stale > 0 {
        alerts.push(Alert {
            kind: "stale",
            count: stale,
            detail: "超 90 天未动，压着钱",
        });
    }

    let recent_sales: Vec<RecentSale> = {
        let mut stmt = conn.prepare(
            "SELECT s.id, s.created_at, s.total_amount_cents, s.settle_type, c.name,
                    (SELECT p.name FROM sale_items si JOIN products p ON p.id = si.product_id
                      WHERE si.sale_id = s.id ORDER BY si.id LIMIT 1) AS first_product,
                    (SELECT count(*) FROM sale_items WHERE sale_id = s.id) AS line_count
               FROM sales s
               LEFT JOIN customers c ON c.id = s.customer_id
              WHERE s.biz_date = ?1 AND s.voided_at IS NULL
              ORDER BY s.id DESC
              LIMIT 8",
        )?;
        let rows = stmt.query_map([&day], |r| {
            let created_at: String = r.get(1)?;
            let first_product: Option<String> = r.get(5)?;
            let line_count: i64 = r.get(6)?;
            let first = first_product.unwrap_or_else(|| "—".to_string());
            Ok(RecentSale {
                id: r.get(0)?,
                time: created_at.chars().skip(11).take(5).collect(),
                summary: if line_count > 1 {
                    format!("{first} 等 {line_count} 样")
                } else {
                    first
                },
                total_cents: r.get(2)?,
                settle_type: r.get(3)?,
                customer_name: r.get(4)?,
            })
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };

    Ok(DashboardData {
        date: day,
        today_revenue_cents,
        today_profit_cents,
        month_profit_cents,
        inventory_value_cents,
        debt_total_cents: debts.owing.iter().map(|d| d.net_debt_cents).sum(),
        debt_count: debts.owing.len(),
        alerts,
        recent_sales,
    })
}
