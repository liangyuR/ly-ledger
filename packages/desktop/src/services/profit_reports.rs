//! 利润报表。
//!
//! 所有口径一律 `voided_at IS NULL`、一律按 `biz_date` 统计。
//! 每个数字都是**毛利**：售价 − 成本，不含房租水电人工 —— 界面上必须写明，
//! 否则老板会拿它当净利，然后认为软件算错了（红线 5）。

use std::collections::HashMap;

use rusqlite::{params, Connection};

use crate::error::Result;
use crate::money::div_round;
use crate::services::reports::today;

pub struct MonthPoint {
    pub month: String,
    pub revenue_cents: i64,
    pub profit_cents: i64,
    /// 本月是否还没走完 —— 图上画成空心柱，不能跟完整月份比高低
    pub partial: bool,
}

/// 近 N 个月的毛利趋势。
/// 最近几个月的毛利趋势，**以 `anchor` 那个月为最后一根柱子**。
///
/// 不写死「到本月为止」：报表页能翻到 7 月去看，趋势图也得跟着翻过去，
/// 不然翻了月份却还盯着 9 月那根柱子，两边对不上。
pub fn monthly_trend(conn: &Connection, months: i64, anchor: Option<&str>) -> Result<Vec<MonthPoint>> {
    let day = today(conn)?;
    let this_month = day[..7].to_string();
    // 柱子排到哪个月为止。只有真正的「本月」才画成空心（它还没走完）
    let last_month = anchor.unwrap_or(&this_month).to_string();

    let rows: HashMap<String, (i64, i64)> = {
        let mut stmt = conn.prepare(
            "SELECT substr(biz_date, 1, 7) AS month,
                    SUM(total_amount_cents),
                    SUM(gross_profit_cents)
               FROM sales
              WHERE voided_at IS NULL
                AND biz_date >= date(?1 || '-01', 'start of month', ?2)
                AND substr(biz_date, 1, 7) <= ?1
              GROUP BY month
              ORDER BY month",
        )?;
        let rows = stmt.query_map(params![last_month, format!("-{} month", months - 1)], |r| {
            Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?)))
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };

    // 没有销售的月份也要出现，否则趋势图会出现「跳月」，看起来像少了一截
    let y: i32 = last_month[..4].parse().unwrap_or(1970);
    let m: i32 = last_month[5..7].parse().unwrap_or(1);

    let mut out = Vec::with_capacity(months as usize);
    for i in (0..months).rev() {
        // 从「今年今月」往回退 i 个月，按 0 基月份算再折回来
        let total = y * 12 + (m - 1) - i as i32;
        let key = format!("{}-{:02}", total / 12, total % 12 + 1);
        let hit = rows.get(&key).copied().unwrap_or((0, 0));
        out.push(MonthPoint {
            partial: key == this_month,
            month: key,
            revenue_cents: hit.0,
            profit_cents: hit.1,
        });
    }
    Ok(out)
}

pub struct DayPoint {
    pub date: String,
    pub revenue_cents: i64,
    pub profit_cents: i64,
}

pub fn daily_trend(conn: &Connection, days: i64) -> Result<Vec<DayPoint>> {
    let day = today(conn)?;
    let mut stmt = conn.prepare(
        "SELECT biz_date,
                SUM(total_amount_cents),
                SUM(gross_profit_cents)
           FROM sales
          WHERE voided_at IS NULL AND biz_date >= date(?1, ?2)
          GROUP BY biz_date
          ORDER BY biz_date",
    )?;
    let rows = stmt.query_map(params![day, format!("-{days} day")], |r| {
        Ok(DayPoint {
            date: r.get(0)?,
            revenue_cents: r.get(1)?,
            profit_cents: r.get(2)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub struct ProductProfit {
    pub product_id: i64,
    pub name: String,
    pub qty_base_milli: i64,
    pub revenue_cents: i64,
    pub profit_cents: i64,
    /// 毛利率，千分比。成本为零时为 None，不硬算
    pub margin_permille: Option<i64>,
    /// 这个商品本月有成本为 0 的销售行 —— 卖的是没进过货的存货，
    /// 软件不知道进价，毛利等于全额售价，数字是虚高的。
    /// 界面必须标出来：不标的话老板会拿着假毛利做进货决策。
    pub cost_unknown: bool,
}

/// 单品毛利排行。按毛利额排 —— 卖得多不等于赚得多。
pub fn product_ranking(
    conn: &Connection,
    month: Option<&str>,
    limit: i64,
) -> Result<Vec<ProductProfit>> {
    let m = match month {
        Some(m) => m.to_string(),
        None => today(conn)?[..7].to_string(),
    };

    let mut stmt = conn.prepare(
        "SELECT si.product_id, p.name,
                SUM(si.qty_base_milli),
                SUM(si.amount_cents),
                SUM(si.amount_cents - si.cost_amount_cents) AS profit_cents,
                MAX(CASE WHEN si.unit_cost_base_e4 = 0 THEN 1 ELSE 0 END)
           FROM sale_items si
           JOIN sales s ON s.id = si.sale_id
           JOIN products p ON p.id = si.product_id
          WHERE s.voided_at IS NULL AND substr(s.biz_date, 1, 7) = ?1
          GROUP BY si.product_id
          ORDER BY profit_cents DESC
          LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![m, limit], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, i64>(5)?,
        ))
    })?;

    let mut out = Vec::new();
    for row in rows {
        let (product_id, name, qty_base_milli, revenue_cents, profit_cents, cost_unknown_flag) = row?;
        out.push(ProductProfit {
            product_id,
            name,
            qty_base_milli,
            revenue_cents,
            profit_cents,
            margin_permille: if revenue_cents == 0 {
                None
            } else {
                Some(div_round(profit_cents as i128 * 1000, revenue_cents as i128)?)
            },
            cost_unknown: cost_unknown_flag == 1,
        });
    }
    Ok(out)
}

pub struct CostUnknownAlert {
    /// 有多少个商品卖的是不知道进价的货
    pub product_count: usize,
    /// 这些行的销售额 —— 毛利虚高的正是这个数
    pub revenue_cents: i64,
    /// 前几个名字，界面上直接点名
    pub names: Vec<String>,
}

/// 本月有多少毛利是假的。
///
/// 从没进过货的商品，成本快照是 0，卖 550 就记赚 550。这不是 bug ——
/// 加权平均成本在没有进货记录时本来就是 0，且下次进货就会自动校正。
/// 但**报表上必须说出来**，否则老板会拿着虚高的毛利做决策。
///
/// 启用向导跳过「期初库存」那一步，就会进入这个状态，所以这是向导的配套。
pub fn cost_unknown_alert(conn: &Connection, month: Option<&str>) -> Result<CostUnknownAlert> {
    let m = match month {
        Some(m) => m.to_string(),
        None => today(conn)?[..7].to_string(),
    };

    let rows: Vec<(String, i64)> = {
        let mut stmt = conn.prepare(
            "SELECT p.name, SUM(si.amount_cents) AS revenue_cents
               FROM sale_items si
               JOIN sales s ON s.id = si.sale_id
               JOIN products p ON p.id = si.product_id
              WHERE s.voided_at IS NULL
                AND substr(s.biz_date, 1, 7) = ?1
                AND si.unit_cost_base_e4 = 0
                AND si.amount_cents > 0
              GROUP BY si.product_id
              ORDER BY revenue_cents DESC",
        )?;
        let rows = stmt.query_map([m], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };

    Ok(CostUnknownAlert {
        product_count: rows.len(),
        revenue_cents: rows.iter().map(|(_, v)| v).sum(),
        names: rows.iter().take(5).map(|(n, _)| n.clone()).collect(),
    })
}

pub struct StaleProduct {
    pub product_id: i64,
    pub name: String,
    pub qty_base_milli: i64,
    pub base_unit: String,
    pub value_cents: i64,
    pub last_sold_date: Option<String>,
    pub idle_days: Option<i64>,
}

/// 滞销预警：有库存、且超过 N 天没卖动的商品。
/// 报的是**压了多少钱**，不只是「多少个商品」—— 后者老板没法据此决策。
pub fn stale_products(conn: &Connection, days: i64) -> Result<Vec<StaleProduct>> {
    let day = today(conn)?;

    let raw: Vec<(i64, String, i64, String, i64, Option<String>)> = {
        let mut stmt = conn.prepare(
            "SELECT i.product_id, p.name, i.qty_base_milli, p.base_unit, i.avg_cost_base_e4,
                    (SELECT MAX(s.biz_date) FROM sale_items si JOIN sales s ON s.id = si.sale_id
                      WHERE si.product_id = i.product_id AND s.voided_at IS NULL)
               FROM inventory i
               JOIN products p ON p.id = i.product_id
              WHERE i.qty_base_milli > 0",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };

    let mut out = Vec::new();
    for (product_id, name, qty_base_milli, base_unit, cost_e4, last_sold_date) in raw {
        let idle_days = last_sold_date
            .as_deref()
            .and_then(|d| crate::services::reports::days_since(d, &day));

        // 从没卖过的也算滞销 —— 而且是最该注意的那种
        if !(idle_days.is_none() || idle_days.unwrap_or(0) >= days) {
            continue;
        }

        out.push(StaleProduct {
            product_id,
            name,
            qty_base_milli,
            base_unit,
            value_cents: div_round(qty_base_milli as i128 * cost_e4 as i128, 100_000)?,
            last_sold_date,
            idle_days,
        });
    }

    out.sort_by_key(|r| -r.value_cents);
    Ok(out)
}

pub struct InventorySummary {
    pub total_value_cents: i64,
    pub sku_count: usize,
    pub negative_count: usize,
}

pub fn inventory_summary(conn: &Connection) -> Result<InventorySummary> {
    let rows: Vec<(i64, i64)> = {
        let mut stmt = conn.prepare("SELECT qty_base_milli, avg_cost_base_e4 FROM inventory")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };

    // 只算正库存：负库存是「可能漏记进货」，把它的负值算进资产没有意义
    let mut total = 0i64;
    for (q, c) in rows.iter().filter(|(q, _)| *q > 0) {
        total += div_round(*q as i128 * *c as i128, 100_000)?;
    }

    Ok(InventorySummary {
        total_value_cents: total,
        sku_count: rows.iter().filter(|(q, _)| *q > 0).count(),
        negative_count: rows.iter().filter(|(q, _)| *q < 0).count(),
    })
}
