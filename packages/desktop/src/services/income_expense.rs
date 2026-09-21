//! 收支明细：某个月「实际收进来多少钱」和「花出去多少钱」放在一起看。
//!
//! 卖货或桌子费挂账，当场并不是钱到手，是记在了客户账上 —— 真正到手要
//! 等收款那天。这里把「现金收入」（settle_type = 'cash'，含桌子费）和
//! 「挂账收回」（payments，不管收的是哪个月挂的账）分开算，两个加起来
//! 才是这个月真进账的钱；本月新开的挂账单独列出来，提醒老板那是应收
//! 账款，不是收入 —— 跟卖货页「挂账不算营业额」是同一条口径。
//!
//! 现金收入再按 `products.is_service` 拆成「卖货」和「桌子费」——
//! 口径跟桌子费页自己的统计（service_fees.rs）同一条：按 sale_item
//! 逐行算，不按整单算，一张单里货和桌子费混开也不会算串。

use rusqlite::{params, Connection};

use crate::error::Result;
use crate::services::expenses::{self, MonthExpenses};

/// 一笔现金收入，货或桌子费各占一行 —— 一张单混开也不会把类目算串。
pub struct IncomeRow {
    pub id: i64,
    pub biz_date: String,
    /// "卖货" | "桌子费"
    pub category: &'static str,
    pub name: String,
    pub amount_cents: i64,
}

/// 一笔新开的挂账（卖货或桌子费记在客户账上的那一单）。
pub struct NewCreditRow {
    pub sale_id: i64,
    pub biz_date: String,
    pub customer_name: String,
    /// 跟看板「今日流水」同一个写法：首个商品名，多样再加「等 N 样」
    pub summary: String,
    pub amount_cents: i64,
}

/// 一笔收回的挂账（还款 / 当场付）。
pub struct CollectedRow {
    pub id: i64,
    pub biz_date: String,
    pub customer_name: String,
    pub amount_cents: i64,
    pub method: String,
    pub note: String,
}

pub struct CategoryTotal {
    pub category: &'static str,
    pub amount_cents: i64,
    pub count: i64,
}

pub struct IncomeExpenseSummary {
    pub month: String,
    /// 现金收入：卖货 + 桌子费里 settle_type = 'cash' 的部分，含退货冲抵
    pub cash_sales_cents: i64,
    /// 挂账收回：这个月实际收到的还款，不管挂的是哪个月的账
    pub credit_collected_cents: i64,
    /// 本月新开的挂账，还没收到钱 —— 不算进收入
    pub new_credit_cents: i64,
    pub income_by_category: Vec<CategoryTotal>,
    pub income_items: Vec<IncomeRow>,
    pub new_credit_items: Vec<NewCreditRow>,
    pub expenses: MonthExpenses,
    pub collected_items: Vec<CollectedRow>,
}

/// `month` 形如 2026-09。
pub fn month(conn: &Connection, month: &str) -> Result<IncomeExpenseSummary> {
    let cash_sales_cents: i64 = conn.query_row(
        "SELECT COALESCE(SUM(total_amount_cents), 0) FROM sales
          WHERE voided_at IS NULL AND settle_type = 'cash' AND substr(biz_date, 1, 7) = ?1",
        params![month],
        |r| r.get(0),
    )?;

    // 逐单取本月新开的挂账 —— 光给一个合计数，老板问「都是谁挂的」答不上来
    let new_credit_items: Vec<NewCreditRow> = {
        let mut stmt = conn.prepare(
            "SELECT s.id, s.biz_date, COALESCE(c.name, '—'), s.total_amount_cents,
                    (SELECT p.name FROM sale_items si JOIN products p ON p.id = si.product_id
                      WHERE si.sale_id = s.id ORDER BY si.id LIMIT 1) AS first_product,
                    (SELECT count(*) FROM sale_items WHERE sale_id = s.id) AS line_count
               FROM sales s
               LEFT JOIN customers c ON c.id = s.customer_id
              WHERE s.voided_at IS NULL AND s.settle_type = 'credit'
                AND substr(s.biz_date, 1, 7) = ?1
              ORDER BY s.biz_date DESC, s.id DESC",
        )?;
        let rows = stmt.query_map(params![month], |r| {
            let first_product: Option<String> = r.get(4)?;
            let line_count: i64 = r.get(5)?;
            let first = first_product.unwrap_or_else(|| "—".to_string());
            Ok(NewCreditRow {
                sale_id: r.get(0)?,
                biz_date: r.get(1)?,
                customer_name: r.get(2)?,
                summary: if line_count > 1 { format!("{first} 等 {line_count} 样") } else { first },
                amount_cents: r.get(3)?,
            })
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let new_credit_cents = new_credit_items.iter().map(|r| r.amount_cents).sum();

    // 逐行取现金收入：卖货和桌子费都在 sales 表里，靠 sale_items 关联的
    // product.is_service 区分，不看整单 —— 一张单里货和桌子费混开时
    // 按整单归类会把其中一半算错类目
    let income_items: Vec<IncomeRow> = {
        let mut stmt = conn.prepare(
            "SELECT si.id, s.biz_date, p.is_service, p.name, si.amount_cents
               FROM sale_items si
               JOIN sales s    ON s.id = si.sale_id
               JOIN products p ON p.id = si.product_id
              WHERE s.voided_at IS NULL AND s.settle_type = 'cash'
                AND substr(s.biz_date, 1, 7) = ?1
              ORDER BY s.biz_date DESC, si.id DESC",
        )?;
        let rows = stmt.query_map(params![month], |r| {
            let is_service: i64 = r.get(2)?;
            Ok(IncomeRow {
                id: r.get(0)?,
                biz_date: r.get(1)?,
                category: if is_service == 1 { "桌子费" } else { "卖货" },
                name: r.get(3)?,
                amount_cents: r.get(4)?,
            })
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };

    // 按类目小计，货和桌子费各一行，多的排前面
    let income_by_category = {
        let (mut goods_cents, mut goods_n) = (0i64, 0i64);
        let (mut svc_cents, mut svc_n) = (0i64, 0i64);
        for i in &income_items {
            if i.category == "桌子费" {
                svc_cents += i.amount_cents;
                svc_n += 1;
            } else {
                goods_cents += i.amount_cents;
                goods_n += 1;
            }
        }
        let mut out = Vec::with_capacity(2);
        if goods_n > 0 {
            out.push(CategoryTotal { category: "卖货", amount_cents: goods_cents, count: goods_n });
        }
        if svc_n > 0 {
            out.push(CategoryTotal { category: "桌子费", amount_cents: svc_cents, count: svc_n });
        }
        out.sort_by(|a, b| b.amount_cents.cmp(&a.amount_cents));
        out
    };

    let collected_items: Vec<CollectedRow> = {
        let mut stmt = conn.prepare(
            "SELECT p.id, p.biz_date, c.name, p.amount_cents, p.method, p.note
               FROM payments p
               JOIN customers c ON c.id = p.customer_id
              WHERE p.voided_at IS NULL AND substr(p.biz_date, 1, 7) = ?1
              ORDER BY p.biz_date DESC, p.id DESC",
        )?;
        let rows = stmt.query_map(params![month], |r| {
            Ok(CollectedRow {
                id: r.get(0)?,
                biz_date: r.get(1)?,
                customer_name: r.get(2)?,
                amount_cents: r.get(3)?,
                method: r.get(4)?,
                note: r.get(5)?,
            })
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let credit_collected_cents = collected_items.iter().map(|r| r.amount_cents).sum();

    Ok(IncomeExpenseSummary {
        month: month.to_string(),
        cash_sales_cents,
        credit_collected_cents,
        new_credit_cents,
        income_by_category,
        income_items,
        new_credit_items,
        // 支出这块别再写一遍口径 —— 直接借开支页自己那份月度统计
        expenses: expenses::month(conn, month)?,
        collected_items,
    })
}
