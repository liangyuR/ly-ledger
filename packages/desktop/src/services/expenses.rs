//! 杂项开支：房租、水电、伙食、运费这些。
//!
//! 跟商品和库存**完全不相干** —— 不进 stock_movements，不动加权成本，
//! 也不改任何一张单的毛利。报表上那个「毛利」是销售毛利（售价 − 进货成本），
//! 开支不减在里面；要看净利得自己拿毛利减开支，这两个数不该偷偷合并，
//! 合并了老板就再也分不清「这个月货卖亏了」和「这个月房租交了」。

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::Result;
use crate::money::{yuan_to_cents, Decimalish};
use crate::validate::check_biz_date;
use crate::{bail, ensure};

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewExpense {
    pub biz_date: String,
    pub category: String,
    pub amount_yuan: Decimalish,
    #[serde(default)]
    pub note: Option<String>,
}

pub struct ExpenseRow {
    pub id: i64,
    pub biz_date: String,
    pub category: String,
    pub amount_cents: i64,
    pub note: String,
}

/// 某个名目这个月花了多少。
pub struct CategoryTotal {
    pub category: String,
    pub amount_cents: i64,
    pub count: i64,
}

pub struct MonthExpenses {
    pub month: String,
    pub total_cents: i64,
    pub by_category: Vec<CategoryTotal>,
    pub items: Vec<ExpenseRow>,
}

pub fn add(conn: &Connection, input: &NewExpense) -> Result<i64> {
    check_biz_date(&input.biz_date)?;

    let category = input.category.trim();
    ensure!(!category.is_empty(), "写一下这笔钱花在哪儿");

    let amount_cents = yuan_to_cents(&input.amount_yuan)?;
    // 负开支就是收入，那是另一回事，不在这张表里表达
    ensure!(amount_cents > 0, "金额要大于零");

    conn.execute(
        "INSERT INTO expenses (biz_date, category, amount_cents, note)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            input.biz_date,
            category,
            amount_cents,
            input.note.as_deref().unwrap_or("").trim(),
        ],
    )?;
    Ok(conn.last_insert_rowid())
}

/// 作废一笔。不物理删除 —— 钱的记录跟销售、进货、收款同一套规矩：
/// 记错了留一条作废痕迹，比让它凭空消失安全。
pub fn void(conn: &Connection, id: i64) -> Result<()> {
    let voided: Option<Option<String>> = conn
        .query_row("SELECT voided_at FROM expenses WHERE id = ?1", [id], |r| r.get(0))
        .optional()?;

    match voided {
        None => bail!("没有这笔开支：{id}"),
        Some(Some(_)) => bail!("这笔已经作废过了"),
        Some(None) => {}
    }

    conn.execute(
        "UPDATE expenses SET voided_at = datetime('now') WHERE id = ?1",
        [id],
    )?;
    Ok(())
}

/// 改名目或备注。
///
/// 这两样不参与任何计算 —— 名目只是归类，备注只给人看。改错了当场改回来，
/// 不值得走「作废 + 重记」那一套（金额和日期错了才走那条路：
/// 那两样一改就动合计和归月，得留痕迹）。
pub fn update(conn: &Connection, id: i64, category: Option<&str>, note: Option<&str>) -> Result<()> {
    let voided: Option<Option<String>> = conn
        .query_row("SELECT voided_at FROM expenses WHERE id = ?1", [id], |r| r.get(0))
        .optional()?;

    match voided {
        None => bail!("没有这笔开支：{id}"),
        Some(Some(_)) => bail!("这笔已经作废了，改不动"),
        Some(None) => {}
    }

    if let Some(c) = category {
        let c = c.trim();
        ensure!(!c.is_empty(), "名目不能空着 —— 空了这笔钱就归不了类");
        conn.execute("UPDATE expenses SET category = ?1 WHERE id = ?2", params![c, id])?;
    }
    if let Some(n) = note {
        conn.execute("UPDATE expenses SET note = ?1 WHERE id = ?2", params![n.trim(), id])?;
    }
    Ok(())
}

/// 某个月的全部开支。`month` 形如 2026-09。
pub fn month(conn: &Connection, month: &str) -> Result<MonthExpenses> {
    let items: Vec<ExpenseRow> = {
        let mut stmt = conn.prepare(
            "SELECT id, biz_date, category, amount_cents, note
               FROM expenses
              WHERE voided_at IS NULL AND substr(biz_date, 1, 7) = ?1
              ORDER BY biz_date DESC, id DESC",
        )?;
        let rows = stmt.query_map([month], |r| {
            Ok(ExpenseRow {
                id: r.get(0)?,
                biz_date: r.get(1)?,
                category: r.get(2)?,
                amount_cents: r.get(3)?,
                note: r.get(4)?,
            })
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };

    // 按名目小计，花得多的在前 —— 老板想知道的是「钱主要去哪儿了」
    let by_category: Vec<CategoryTotal> = {
        let mut stmt = conn.prepare(
            "SELECT category, SUM(amount_cents) AS total, COUNT(*) AS n
               FROM expenses
              WHERE voided_at IS NULL AND substr(biz_date, 1, 7) = ?1
              GROUP BY category
              ORDER BY total DESC, category",
        )?;
        let rows = stmt.query_map([month], |r| {
            Ok(CategoryTotal {
                category: r.get(0)?,
                amount_cents: r.get(1)?,
                count: r.get(2)?,
            })
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };

    Ok(MonthExpenses {
        month: month.to_string(),
        total_cents: items.iter().map(|i| i.amount_cents).sum(),
        by_category,
        items,
    })
}
