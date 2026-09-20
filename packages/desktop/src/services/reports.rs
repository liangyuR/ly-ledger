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
    /// 催账要打的那个号码。没填就是空串
    pub phone: String,
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
            "SELECT c.id, c.name, c.phone,
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
            let earliest: Option<String> = r.get(4)?;
            Ok(DebtRow {
                customer_id: r.get(0)?,
                name: r.get(1)?,
                phone: r.get(2)?,
                net_debt_cents: r.get(3)?,
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

// ───────────────────── 往来对账 ─────────────────────

/// 客户账上的一笔往来。金额带符号：欠得多为正，还掉为负。
#[derive(Debug, Clone)]
pub struct LedgerEntry {
    pub biz_date: String,
    /// 挂账 / 退货 / 还款 / 当场付
    pub kind: &'static str,
    pub ref_label: String,
    pub amount_cents: i64,
    /// 这一笔之后该客户的结余
    pub balance_cents: i64,
    pub note: String,
}

/// 一个客户的全部往来 + 期末结余。
#[derive(Debug, Clone)]
pub struct CustomerStatement {
    pub customer_id: i64,
    pub name: String,
    /// 催账要打的那个号码，和客户档案上那句备注。都可能是空串
    pub phone: String,
    pub note: String,
    /// 挂账合计，不含退货
    pub charged_cents: i64,
    /// 退货冲抵，记成正数
    pub returned_cents: i64,
    pub paid_cents: i64,
    /// = charged - returned - paid，与欠款列表的净额同一个数
    pub balance_cents: i64,
    pub earliest_unpaid_date: Option<String>,
    pub aging_days: Option<i64>,
    pub entries: Vec<LedgerEntry>,
}

/// 全部客户的往来对账，按「欠得最久的在前，结清的在后」排。
///
/// 欠款列表只答「现在谁欠我多少」，够催账用，不够对账用 ——
/// 挂 1200 还 500 剩 700，表上只剩一个 700，年底跟单位客户核对时
/// 那 1200 和 500 得从哪儿翻出来。**结清的客户也要留在表里**，
/// 余额为零不等于这一年没发生过事。
///
/// 不按 is_active 过滤：这是一份历史记录，停用一个客户不该让他欠过的钱
/// 从对账表上消失。
///
/// `only` 传客户 id 就只算那一个（挂账归还页点开一行时用）。导出和单看
/// 共用这一个函数，**不另写一份单客户版本** —— 两份就会各自漂，
/// 屏幕上和表里的数字对不上，而老板没有第三个地方可以查证谁对。
pub fn customer_statements(conn: &Connection, only: Option<i64>) -> Result<Vec<CustomerStatement>> {
    let day = today(conn)?;

    // 挂账单和收款单并成一条流水。ord 让同一天的挂账排在收款前面 ——
    // 钱不可能在挂账之前还掉，倒过来读会让人以为账记错了
    let mut stmt = conn.prepare(
        "SELECT e.customer_id, e.biz_date, e.kind, e.ref_id, e.amount_cents, e.note
           FROM (
             SELECT customer_id, biz_date,
                    CASE WHEN return_of_sale_id IS NULL THEN 'charge' ELSE 'return' END AS kind,
                    id AS ref_id, total_amount_cents AS amount_cents, note, 0 AS ord
               FROM sales
              WHERE settle_type = 'credit' AND voided_at IS NULL AND customer_id IS NOT NULL
             UNION ALL
             SELECT customer_id, biz_date,
                    CASE WHEN source = 'partial_pay' THEN 'partial' ELSE 'payment' END AS kind,
                    id AS ref_id, -amount_cents AS amount_cents, note, 1 AS ord
               FROM payments
              WHERE voided_at IS NULL
           ) e
          WHERE ?1 IS NULL OR e.customer_id = ?1
          ORDER BY e.customer_id, e.biz_date, e.ord, e.ref_id",
    )?;
    let rows = stmt.query_map([only], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, String>(5)?,
        ))
    })?;

    let mut by_customer: std::collections::HashMap<i64, Vec<LedgerEntry>> =
        std::collections::HashMap::new();
    for row in rows {
        let (cid, biz_date, kind, ref_id, amount_cents, note) = row?;
        let list = by_customer.entry(cid).or_default();
        let balance_cents = list.last().map_or(0, |e: &LedgerEntry| e.balance_cents) + amount_cents;
        let (kind, ref_label) = match kind.as_str() {
            "charge" => ("挂账", format!("销售单 #{ref_id}")),
            "return" => ("退货", format!("退货单 #{ref_id}")),
            "partial" => ("当场付", format!("收款 #{ref_id}")),
            _ => ("还款", format!("收款 #{ref_id}")),
        };
        list.push(LedgerEntry {
            biz_date,
            kind,
            ref_label,
            amount_cents,
            balance_cents,
            note,
        });
    }

    // 账龄口径跟欠款列表共用一份，两张表上的天数必须是同一个数
    let debts = list_debts(conn, Some(&day))?;
    let aging: std::collections::HashMap<i64, (Option<String>, Option<i64>)> = debts
        .owing
        .iter()
        .chain(debts.prepaid.iter())
        .map(|r| (r.customer_id, (r.earliest_unpaid_date.clone(), r.aging_days)))
        .collect();

    let mut out: Vec<CustomerStatement> = {
        let mut stmt = conn
            .prepare("SELECT id, name, phone, note FROM customers WHERE ?1 IS NULL OR id = ?1")?;
        let rows = stmt.query_map([only], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;
        let mut acc = Vec::new();
        for row in rows {
            let (customer_id, name, phone, note) = row?;
            let entries = by_customer.remove(&customer_id).unwrap_or_default();
            // 一笔往来都没有的客户不进对账表：建了档没做过生意，列出来只是噪音
            if entries.is_empty() {
                continue;
            }
            let charged_cents = entries
                .iter()
                .filter(|e| e.kind == "挂账")
                .map(|e| e.amount_cents)
                .sum();
            let returned_cents: i64 = entries
                .iter()
                .filter(|e| e.kind == "退货")
                .map(|e| e.amount_cents)
                .sum();
            let paid_cents: i64 = entries
                .iter()
                .filter(|e| e.kind == "还款" || e.kind == "当场付")
                .map(|e| e.amount_cents)
                .sum();
            let (earliest_unpaid_date, aging_days) =
                aging.get(&customer_id).cloned().unwrap_or((None, None));
            acc.push(CustomerStatement {
                customer_id,
                name,
                phone,
                note,
                charged_cents,
                returned_cents: -returned_cents,
                paid_cents: -paid_cents,
                balance_cents: entries.last().map_or(0, |e| e.balance_cents),
                earliest_unpaid_date,
                aging_days,
                entries,
            });
        }
        acc
    };

    // 欠钱的在前，拖得最久的最前；预收其次；结清的沉底
    out.sort_by_key(|s| {
        let bucket = if s.balance_cents > 0 {
            0
        } else if s.balance_cents < 0 {
            1
        } else {
            2
        };
        (bucket, -s.aging_days.unwrap_or(0), s.customer_id)
    });
    Ok(out)
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
                COALESCE(sold.qty_milli, 0) AS sold_qty_milli
           FROM products p
           -- 过滤和求和必须待在同一层。把条件挂在外层的 sales JOIN 上、
           -- 却对着 sale_items 求和，是这类查询最容易写错的一步：JOIN 没匹配上
           -- 也不会让 si 那一行消失，作废单和陈年老单照样被算进「近 30 天」，
           -- 而且算出来的数字看着完全正常，只有排序悄悄错掉
           LEFT JOIN (
             SELECT si.product_id, SUM(si.qty_base_milli) AS qty_milli
               FROM sale_items si
               JOIN sales s ON s.id = si.sale_id
              WHERE s.voided_at IS NULL
                AND s.biz_date >= date(?1, '-30 day')
              GROUP BY si.product_id
           ) sold ON sold.product_id = p.id
          -- 服务型收费有自己的页面，价格每次现填，不该混进卖货页的常用位
          WHERE p.is_active = 1 AND p.is_service = 0
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
        // 服务本来就没有固定售价，算进「缺价格」会让这条提醒永远消不掉
        "SELECT count(*) FROM products WHERE is_active = 1 AND is_service = 0
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
