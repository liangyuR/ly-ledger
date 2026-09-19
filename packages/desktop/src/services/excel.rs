//! Excel 导出。
//!
//! 每个入口都是一个按钮直接出一份 .xlsx，**不弹导出配置** ——
//! 老板要的是一份能直接发给会计、或者年底跟单位客户对账的表，
//! 不是一个导出向导（docs/04）。
//!
//! 金额在表里写成**数字**而不是字符串，否则会计打开后没法求和。
//! 库里是整数分，这里除以 100 交给 Excel —— 这是唯一允许出现浮点的地方，
//! 因为它已经离开系统了。

use rusqlite::Connection;
use rust_xlsxwriter::{Format, Workbook};

use crate::error::Result;
use crate::money::{milli_to_qty, permille_to_percent};
use crate::services::profit_reports::{product_ranking, stale_products};
use crate::services::reports::{list_debts, today};

const MONEY: &str = "#,##0.00";
const MONEY_E4: &str = "#,##0.0000";

/// 表格里的一个格子。
pub enum Cell {
    Text(String),
    /// 分 → 元，按金额格式写成数字
    Money(i64),
    /// 万分之一元 → 元，四位小数
    MoneyE4(i64),
    Int(i64),
    /// 数字列遇到空值要留空，写成空字符串会被当成文本，整列格式就废了
    Blank,
}

fn text(v: Option<String>) -> Cell {
    Cell::Text(v.unwrap_or_default())
}

pub struct Export {
    pub filename: String,
    pub bytes: Vec<u8>,
}

/// 表头 + 列宽 + 若干行 → xlsx 字节。
fn write_sheet(headers: &[(&str, f64)], rows: &[Vec<Cell>]) -> Result<Vec<u8>> {
    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();

    let bold = Format::new().set_bold();
    let money = Format::new().set_num_format(MONEY);
    let money_e4 = Format::new().set_num_format(MONEY_E4);

    for (i, (title, width)) in headers.iter().enumerate() {
        let col = i as u16;
        sheet.write_string_with_format(0, col, *title, &bold)?;
        sheet.set_column_width(col, *width)?;
    }

    for (r, row) in rows.iter().enumerate() {
        let row_idx = r as u32 + 1;
        for (c, cell) in row.iter().enumerate() {
            let col = c as u16;
            match cell {
                Cell::Text(s) => {
                    sheet.write_string(row_idx, col, s)?;
                }
                Cell::Money(cents) => {
                    sheet.write_number_with_format(row_idx, col, *cents as f64 / 100.0, &money)?;
                }
                Cell::MoneyE4(e4) => {
                    sheet.write_number_with_format(row_idx, col, *e4 as f64 / 10_000.0, &money_e4)?;
                }
                Cell::Int(v) => {
                    sheet.write_number(row_idx, col, *v as f64)?;
                }
                Cell::Blank => {}
            }
        }
    }

    // 表头冻在第一行：几百行明细翻到底还看得见列名
    sheet.set_freeze_panes(1, 0)?;

    Ok(workbook.save_to_buffer()?)
}

/// 本月明细：每一笔销售 + 成本快照 + 毛利。
pub fn export_sales(conn: &Connection, month: Option<&str>) -> Result<Export> {
    let m = match month {
        Some(m) => m.to_string(),
        None => today(conn)?[..7].to_string(),
    };

    let mut rows = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT s.id, s.biz_date, s.settle_type, c.name,
                    p.name, si.qty_milli, si.unit, si.unit_price_cents,
                    si.amount_cents, si.cost_amount_cents,
                    (si.amount_cents - si.cost_amount_cents),
                    s.discount_amount_cents, s.note
               FROM sales s
               JOIN sale_items si ON si.sale_id = s.id
               JOIN products p ON p.id = si.product_id
               LEFT JOIN customers c ON c.id = s.customer_id
              WHERE s.voided_at IS NULL AND substr(s.biz_date, 1, 7) = ?1
              ORDER BY s.biz_date, s.id, si.id",
        )?;
        let mapped = stmt.query_map([&m], |r| {
            let settle: String = r.get(2)?;
            let unit: String = r.get(6)?;
            Ok(vec![
                Cell::Text(format!("#{}", r.get::<_, i64>(0)?)),
                Cell::Text(r.get::<_, String>(1)?),
                Cell::Text(if settle == "cash" { "现金" } else { "挂账" }.to_string()),
                text(r.get(3)?),
                Cell::Text(r.get::<_, String>(4)?),
                Cell::Text(milli_to_qty(r.get::<_, i64>(5)?)),
                Cell::Text(if unit == "pack" { "整包" } else { "单件" }.to_string()),
                Cell::Money(r.get(7)?),
                Cell::Money(r.get(8)?),
                Cell::Money(r.get(9)?),
                Cell::Money(r.get(10)?),
                Cell::Money(r.get(11)?),
                Cell::Text(r.get::<_, String>(12)?),
            ])
        })?;
        for row in mapped {
            rows.push(row?);
        }
    }

    let bytes = write_sheet(
        &[
            ("单号", 10.0),
            ("业务日期", 13.0),
            ("结算", 8.0),
            ("客户", 12.0),
            ("商品", 20.0),
            ("数量", 9.0),
            ("单位", 8.0),
            ("单价", 16.0),
            ("小计", 16.0),
            ("成本", 16.0),
            ("毛利", 16.0),
            ("整单抹零", 16.0),
            ("备注", 20.0),
        ],
        &rows,
    )?;

    Ok(Export {
        filename: format!("销售明细-{m}.xlsx"),
        bytes,
    })
}

/// 欠款表：谁欠多少、账龄、最早一笔。
pub fn export_debts(conn: &Connection) -> Result<Export> {
    let d = list_debts(conn, None)?;

    let mut rows = Vec::new();
    for (kind, list) in [("欠款", &d.owing), ("预收", &d.prepaid)] {
        for r in list {
            rows.push(vec![
                Cell::Text(r.name.clone()),
                Cell::Text(kind.to_string()),
                Cell::Money(r.net_debt_cents.abs()),
                match r.aging_days {
                    Some(v) => Cell::Int(v),
                    None => Cell::Blank,
                },
                text(r.earliest_unpaid_date.clone()),
            ]);
        }
    }

    let bytes = write_sheet(
        &[
            ("客户", 16.0),
            ("类型", 8.0),
            ("金额", 16.0),
            ("账龄（天）", 12.0),
            ("最早未结清", 14.0),
        ],
        &rows,
    )?;

    Ok(Export {
        filename: format!("欠款表-{}.xlsx", today(conn)?),
        bytes,
    })
}

/// 全部商品与价格。
/// **这份同时就是导入模板** —— 导出、填好、再导回来，闭环不用另做一份。
pub fn export_products(conn: &Connection) -> Result<Export> {
    let mut rows = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT p.name, p.brand, p.spec, p.base_unit, p.pack_unit, p.pack_ratio,
                    p.price_pack_cents, p.price_base_cents,
                    COALESCE(i.qty_base_milli, 0), COALESCE(i.avg_cost_base_e4, 0), p.pinyin_abbr
               FROM products p LEFT JOIN inventory i ON i.product_id = p.id
              WHERE p.is_active = 1
              ORDER BY p.brand, p.name",
        )?;
        let mapped = stmt.query_map([], |r| {
            let price_pack: Option<i64> = r.get(6)?;
            let price_base: Option<i64> = r.get(7)?;
            Ok(vec![
                Cell::Text(r.get::<_, String>(0)?),
                Cell::Text(r.get::<_, String>(1)?),
                Cell::Text(r.get::<_, String>(2)?),
                Cell::Text(r.get::<_, String>(3)?),
                text(r.get(4)?),
                Cell::Int(r.get(5)?),
                price_pack.map(Cell::Money).unwrap_or(Cell::Blank),
                price_base.map(Cell::Money).unwrap_or(Cell::Blank),
                Cell::Text(milli_to_qty(r.get::<_, i64>(8)?)),
                Cell::MoneyE4(r.get(9)?),
                Cell::Text(r.get::<_, String>(10)?),
            ])
        })?;
        for row in mapped {
            rows.push(row?);
        }
    }

    let bytes = write_sheet(
        &[
            ("商品名", 22.0),
            ("品牌", 12.0),
            ("规格", 14.0),
            ("基础单位", 10.0),
            ("包装单位", 10.0),
            ("换算", 8.0),
            ("整包售价", 16.0),
            ("单件售价", 16.0),
            ("当前库存", 11.0),
            ("加权成本", 16.0),
            ("拼音", 12.0),
        ],
        &rows,
    )?;

    Ok(Export {
        filename: format!("商品与价格-{}.xlsx", today(conn)?),
        bytes,
    })
}

/// 单品毛利排行。
pub fn export_ranking(conn: &Connection, month: Option<&str>) -> Result<Export> {
    let m = match month {
        Some(m) => m.to_string(),
        None => today(conn)?[..7].to_string(),
    };

    let rows: Vec<Vec<Cell>> = product_ranking(conn, Some(&m), 200)?
        .into_iter()
        .map(|r| {
            vec![
                Cell::Text(r.name),
                Cell::Text(milli_to_qty(r.qty_base_milli)),
                Cell::Money(r.revenue_cents),
                Cell::Money(r.profit_cents),
                match r.margin_permille {
                    Some(v) => Cell::Text(format!("{}%", permille_to_percent(v))),
                    None => Cell::Text(String::new()),
                },
            ]
        })
        .collect();

    let bytes = write_sheet(
        &[
            ("商品", 22.0),
            ("销量", 11.0),
            ("销售额", 16.0),
            ("毛利", 16.0),
            ("毛利率", 10.0),
        ],
        &rows,
    )?;

    Ok(Export {
        filename: format!("单品毛利排行-{m}.xlsx"),
        bytes,
    })
}

/// 滞销预警：压了多少钱。
pub fn export_stale(conn: &Connection, days: i64) -> Result<Export> {
    let rows: Vec<Vec<Cell>> = stale_products(conn, days)?
        .into_iter()
        .map(|r| {
            vec![
                Cell::Text(r.name),
                Cell::Text(format!(
                    "{} {}",
                    milli_to_qty(r.qty_base_milli),
                    r.base_unit
                )),
                Cell::Money(r.value_cents),
                Cell::Text(r.last_sold_date.unwrap_or_else(|| "从没卖过".to_string())),
                match r.idle_days {
                    Some(v) => Cell::Int(v),
                    None => Cell::Blank,
                },
            ]
        })
        .collect();

    let bytes = write_sheet(
        &[
            ("商品", 22.0),
            ("库存", 12.0),
            ("压了多少钱", 16.0),
            ("最后卖出", 14.0),
            ("闲置天数", 11.0),
        ],
        &rows,
    )?;

    Ok(Export {
        filename: format!("滞销预警-{}.xlsx", today(conn)?),
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;

    #[test]
    fn 空库也导得出一份只有表头的表() {
        // 空表也要能导 —— 报错只会让老板以为软件坏了
        let conn = open_memory().unwrap();
        let x = export_sales(&conn, Some("2026-09")).unwrap();
        assert!(x.filename.ends_with(".xlsx"));
        assert!(!x.bytes.is_empty());
        // xlsx 就是个 zip，魔数 PK
        assert_eq!(&x.bytes[..2], b"PK");
    }

    #[test]
    fn 文件名带上月份或日期() {
        let conn = open_memory().unwrap();
        assert_eq!(
            export_sales(&conn, Some("2026-08")).unwrap().filename,
            "销售明细-2026-08.xlsx"
        );
        assert!(export_debts(&conn).unwrap().filename.starts_with("欠款表-"));
        assert!(export_stale(&conn, 90).unwrap().filename.starts_with("滞销预警-"));
    }
}
