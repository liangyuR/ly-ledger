use std::collections::BTreeMap;

use rusqlite::Connection;
use serde::Serialize;

use crate::error::Result;
use crate::money::{cents_to_yuan, div_round};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaleRow {
    pub id: i64,
    pub time: String,
    pub summary: String,
    pub amount: String,
    pub settle_type: String,
    pub customer_name: Option<String>,
    pub is_return: bool,
    pub cost_unknown: bool,
}

#[derive(Default)]
struct Totals {
    cash_sales: i64,
    credit_sales: i64,
    cash_profit: i64,
    credit_profit: i64,
}

impl Totals {
    fn add(&mut self, credit: bool, amount: i64, profit: i64) {
        if credit {
            self.credit_sales += amount;
            self.credit_profit += profit;
        } else {
            self.cash_sales += amount;
            self.cash_profit += profit;
        }
    }

    fn formatted(&self) -> SummaryAmounts {
        SummaryAmounts {
            cash_sales: cents_to_yuan(self.cash_sales),
            credit_sales: cents_to_yuan(self.credit_sales),
            cash_profit: cents_to_yuan(self.cash_profit),
            credit_profit: cents_to_yuan(self.credit_profit),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryAmounts {
    pub cash_sales: String,
    pub credit_sales: String,
    pub cash_profit: String,
    pub credit_profit: String,
}

#[derive(Serialize)]
pub struct DaySummary {
    pub date: String,
    #[serde(flatten)]
    pub amounts: SummaryAmounts,
    pub items: Vec<SaleRow>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonthSummary {
    pub month: String,
    #[serde(flatten)]
    pub amounts: SummaryAmounts,
    pub cost_unknown_count: i64,
    pub days: Vec<DaySummary>,
}

pub fn month(conn: &Connection, month: &str) -> Result<MonthSummary> {
    crate::ensure!(month.is_ascii(), "月份应为 YYYY-MM，收到：{month}");
    crate::validate::check_month(month)?;
    let mut stmt = conn.prepare(
        "SELECT s.id, s.biz_date, s.created_at, s.settle_type, c.name,
                s.return_of_sale_id IS NOT NULL, s.original_amount_cents,
                s.discount_amount_cents, SUM(si.amount_cents), SUM(si.cost_amount_cents),
                COUNT(*),
                (SELECT p2.name FROM sale_items si2 JOIN products p2 ON p2.id = si2.product_id
                  WHERE si2.sale_id = s.id AND p2.is_service = 0 ORDER BY si2.id LIMIT 1),
                MAX(si.unit_cost_base_e4 = 0 AND si.amount_cents > 0)
           FROM sales s
           JOIN sale_items si ON si.sale_id = s.id
           JOIN products p ON p.id = si.product_id
           LEFT JOIN customers c ON c.id = s.customer_id
          WHERE s.voided_at IS NULL AND p.is_service = 0 AND substr(s.biz_date, 1, 7) = ?1
          GROUP BY s.id
          ORDER BY s.biz_date DESC, s.created_at DESC, s.id DESC",
    )?;
    let mut rows = stmt.query([month])?;
    let mut totals = Totals::default();
    let mut days: BTreeMap<String, (Totals, Vec<SaleRow>)> = BTreeMap::new();
    while let Some(row) = rows.next()? {
        let original: i64 = row.get(6)?;
        let discount: i64 = row.get(7)?;
        let goods: i64 = row.get(8)?;
        let cost: i64 = row.get(9)?;
        // 混合单按商品占比分摊整单抹零；纯商品单与单据折后金额完全一致。
        let allocated_discount = if original == 0 {
            0
        } else {
            div_round(discount as i128 * goods as i128, original as i128)?
        };
        let amount = goods - allocated_discount;
        let profit = amount - cost;
        let settle_type: String = row.get(3)?;
        let credit = settle_type == "credit";
        totals.add(credit, amount, profit);
        let day = days.entry(row.get(1)?).or_default();
        day.0.add(credit, amount, profit);
        let count: i64 = row.get(10)?;
        let name: String = row.get(11)?;
        day.1.push(SaleRow {
            id: row.get(0)?,
            time: row.get::<_, String>(2)?.chars().skip(11).take(5).collect(),
            summary: if count > 1 {
                format!("{name} 等 {count} 样")
            } else {
                name
            },
            amount: cents_to_yuan(amount),
            settle_type,
            customer_name: row.get(4)?,
            is_return: row.get(5)?,
            cost_unknown: row.get(12)?,
        });
    }
    let cost_unknown_count = conn.query_row(
        "SELECT COUNT(DISTINCT si.product_id)
           FROM sale_items si JOIN sales s ON s.id = si.sale_id
           JOIN products p ON p.id = si.product_id
          WHERE s.voided_at IS NULL AND p.is_service = 0
            AND substr(s.biz_date, 1, 7) = ?1
            AND si.unit_cost_base_e4 = 0 AND si.amount_cents > 0",
        [month],
        |row| row.get(0),
    )?;
    Ok(MonthSummary {
        month: month.to_string(),
        amounts: totals.formatted(),
        cost_unknown_count,
        days: days
            .into_iter()
            .rev()
            .map(|(date, (totals, items))| DaySummary {
                date,
                amounts: totals.formatted(),
                items,
            })
            .collect(),
    })
}
