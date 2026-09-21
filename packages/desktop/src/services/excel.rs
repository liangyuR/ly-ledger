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
use crate::services::income_expense;
use crate::services::profit_reports::{product_ranking, stale_products};
use crate::services::reports::{customer_statements, today};

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

/// 工作簿里的一页：页签名 + 表头 + 列宽 + 若干行。
struct SheetSpec<'a> {
    name: &'a str,
    headers: &'a [(&'a str, f64)],
    rows: &'a [Vec<Cell>],
}

/// 单页表。页签名留 Excel 默认的，老板打开只看得见一页，名字没有意义。
fn write_sheet(headers: &[(&str, f64)], rows: &[Vec<Cell>]) -> Result<Vec<u8>> {
    write_book(&[SheetSpec {
        name: "Sheet1",
        headers,
        rows,
    }])
}

/// 多页表 → xlsx 字节。页签有名字，因为要翻页就得知道翻到哪儿。
fn write_book(specs: &[SheetSpec]) -> Result<Vec<u8>> {
    let mut workbook = Workbook::new();

    let bold = Format::new().set_bold();
    let money = Format::new().set_num_format(MONEY);
    let money_e4 = Format::new().set_num_format(MONEY_E4);

    for spec in specs {
        let SheetSpec { name, headers, rows } = spec;
        let sheet = workbook.add_worksheet();
        sheet.set_name(*name)?;

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
    }

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

/// 欠款表：两页 —— 一页汇总谁欠多少，一页把每一笔挂账和还款摊开。
///
/// 只给一个余额是不够的。挂 1200 还 500 剩 700，表上只写 700，
/// 年底跟单位客户核对时那 1200 和 500 得从哪儿翻出来；
/// 而且**结清的客户也要留在表里** —— 余额为零不等于这一年没发生过事，
/// 对账表上少一个人，对面就会问「我那笔呢」。
pub fn export_debts(conn: &Connection) -> Result<Export> {
    let statements = customer_statements(conn, None)?;

    let mut summary = Vec::new();
    let mut detail = Vec::new();

    for st in &statements {
        let status = if st.balance_cents > 0 {
            "欠款"
        } else if st.balance_cents < 0 {
            "预收"
        } else {
            "已结清"
        };

        summary.push(vec![
            Cell::Text(st.name.clone()),
            Cell::Text(st.phone.clone()),
            Cell::Text(status.to_string()),
            Cell::Money(st.charged_cents),
            Cell::Money(st.returned_cents),
            Cell::Money(st.paid_cents),
            Cell::Money(st.balance_cents.abs()),
            match st.aging_days {
                Some(v) => Cell::Int(v),
                None => Cell::Blank,
            },
            text(st.earliest_unpaid_date.clone()),
            Cell::Text(st.note.clone()),
        ]);

        for e in &st.entries {
            detail.push(vec![
                Cell::Text(st.name.clone()),
                Cell::Text(e.biz_date.clone()),
                Cell::Text(e.kind.to_string()),
                Cell::Text(e.ref_label.clone()),
                // 发生额带符号：挂账为正、还款为负，一列就能求和对上结余
                Cell::Money(e.amount_cents),
                Cell::Money(e.balance_cents),
                Cell::Text(e.note.clone()),
            ]);
        }
    }

    let bytes = write_book(&[
        SheetSpec {
            name: "欠款汇总",
            headers: &[
                ("客户", 16.0),
                ("电话", 15.0),
                ("状态", 10.0),
                ("挂账合计", 16.0),
                ("退货冲抵", 16.0),
                ("已还合计", 16.0),
                ("余额", 16.0),
                ("账龄（天）", 12.0),
                ("最早未结清", 14.0),
                ("备注", 20.0),
            ],
            rows: &summary,
        },
        SheetSpec {
            name: "往来明细",
            headers: &[
                ("客户", 16.0),
                ("日期", 13.0),
                ("类型", 10.0),
                ("单号", 14.0),
                ("发生额", 16.0),
                ("结余", 16.0),
                ("备注", 20.0),
            ],
            rows: &detail,
        },
    ])?;

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
              WHERE p.is_active = 1 AND p.is_service = 0
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

/// 跨月导出：一页按月汇总，一页全部明细。
///
/// 一次导一个月的表发给会计够用，但「今年上半年一共做了多少」要自己把六份表
/// 摞起来加 —— 那正是最容易加错的地方。汇总页把每个月一行摆出来，
/// 明细页保持跟单月导出**一模一样的列**，会计拿到哪一份都认得。
pub fn export_sales_range(conn: &Connection, from_month: &str, to_month: &str) -> Result<Export> {
    crate::validate::check_month(from_month)?;
    crate::validate::check_month(to_month)?;
    // 顺手把颠倒的区间摆正：老板从下拉里选月份，先点到哪个都有可能
    let (from, to) = if from_month <= to_month {
        (from_month, to_month)
    } else {
        (to_month, from_month)
    };

    let mut summary = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT substr(s.biz_date, 1, 7) AS m,
                    COUNT(DISTINCT s.id),
                    SUM(s.total_amount_cents),
                    SUM(s.cost_amount_cents),
                    SUM(s.gross_profit_cents)
               FROM sales s
              WHERE s.voided_at IS NULL
                AND substr(s.biz_date, 1, 7) BETWEEN ?1 AND ?2
              GROUP BY m ORDER BY m",
        )?;
        let mapped = stmt.query_map([from, to], |r| {
            Ok(vec![
                Cell::Text(r.get::<_, String>(0)?),
                Cell::Int(r.get(1)?),
                Cell::Money(r.get(2)?),
                Cell::Money(r.get(3)?),
                Cell::Money(r.get(4)?),
            ])
        })?;
        for row in mapped {
            summary.push(row?);
        }
    }

    // 合计行。会计打开第一眼找的就是它，让他自己拉公式不如直接给
    let total = |col: usize| -> i64 {
        summary
            .iter()
            .map(|r| match r[col] {
                Cell::Money(v) => v,
                Cell::Int(v) => v,
                _ => 0,
            })
            .sum()
    };
    if !summary.is_empty() {
        summary.push(vec![
            Cell::Text("合计".to_string()),
            Cell::Int(total(1)),
            Cell::Money(total(2)),
            Cell::Money(total(3)),
            Cell::Money(total(4)),
        ]);
    }

    let mut detail = Vec::new();
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
              WHERE s.voided_at IS NULL
                AND substr(s.biz_date, 1, 7) BETWEEN ?1 AND ?2
              ORDER BY s.biz_date, s.id, si.id",
        )?;
        let mapped = stmt.query_map([from, to], |r| {
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
            detail.push(row?);
        }
    }

    let bytes = write_book(&[
        SheetSpec {
            name: "按月汇总",
            headers: &[
                ("月份", 12.0),
                ("单数", 10.0),
                ("营业额", 16.0),
                ("成本", 16.0),
                ("毛利", 16.0),
            ],
            rows: &summary,
        },
        SheetSpec {
            name: "全部明细",
            headers: &[
                ("单号", 10.0),
                ("日期", 12.0),
                ("结算", 8.0),
                ("客户", 12.0),
                ("商品", 22.0),
                ("数量", 10.0),
                ("单位", 8.0),
                ("单价", 14.0),
                ("金额", 14.0),
                ("成本", 14.0),
                ("毛利", 14.0),
                ("整单抹零", 14.0),
                ("备注", 20.0),
            ],
            rows: &detail,
        },
    ])?;

    Ok(Export {
        filename: format!("销售明细-{from}至{to}.xlsx"),
        bytes,
    })
}

/// 收支明细：汇总页 + 收入/支出/挂账/挂账收回四页明细，跟屏幕上那页一模一样的口径 ——
/// 不另写一遍统计逻辑，直接借 `income_expense::month`，屏幕上看见啥，表里就是啥。
pub fn export_income_expense(conn: &Connection, month: Option<&str>) -> Result<Export> {
    let m = match month {
        Some(m) => m.to_string(),
        None => today(conn)?[..7].to_string(),
    };
    let d = income_expense::month(conn, &m)?;
    let total_income_cents = d.cash_sales_cents + d.credit_collected_cents;

    let summary = vec![
        vec![Cell::Text("现金收入".to_string()), Cell::Money(d.cash_sales_cents)],
        vec![Cell::Text("挂账收回".to_string()), Cell::Money(d.credit_collected_cents)],
        vec![Cell::Text("合计收入".to_string()), Cell::Money(total_income_cents)],
        vec![Cell::Text("本月新挂账（未计入收入）".to_string()), Cell::Money(d.new_credit_cents)],
        vec![Cell::Text("开支".to_string()), Cell::Money(d.expenses.total_cents)],
        vec![
            Cell::Text("净结余".to_string()),
            Cell::Money(total_income_cents - d.expenses.total_cents),
        ],
    ];

    let income_rows: Vec<Vec<Cell>> = d
        .income_items
        .iter()
        .map(|i| {
            vec![
                Cell::Text(i.biz_date.clone()),
                Cell::Text(i.category.to_string()),
                Cell::Text(i.name.clone()),
                Cell::Money(i.amount_cents),
            ]
        })
        .collect();

    let expense_rows: Vec<Vec<Cell>> = d
        .expenses
        .items
        .iter()
        .map(|i| {
            vec![
                Cell::Text(i.biz_date.clone()),
                Cell::Text(i.category.clone()),
                Cell::Text(i.note.clone()),
                Cell::Money(i.amount_cents),
            ]
        })
        .collect();

    let new_credit_rows: Vec<Vec<Cell>> = d
        .new_credit_items
        .iter()
        .map(|r| {
            vec![
                Cell::Text(r.biz_date.clone()),
                Cell::Text(r.customer_name.clone()),
                Cell::Text(r.summary.clone()),
                Cell::Money(r.amount_cents),
            ]
        })
        .collect();

    let collected_rows: Vec<Vec<Cell>> = d
        .collected_items
        .iter()
        .map(|r| {
            vec![
                Cell::Text(r.biz_date.clone()),
                Cell::Text(r.customer_name.clone()),
                Cell::Text(match r.method.as_str() {
                    "cash" => "现金",
                    "wechat" => "微信",
                    "alipay" => "支付宝",
                    "transfer" => "转账",
                    _ => "—",
                }.to_string()),
                Cell::Money(r.amount_cents),
                Cell::Text(r.note.clone()),
            ]
        })
        .collect();

    let bytes = write_book(&[
        SheetSpec {
            name: "汇总",
            headers: &[("项目", 26.0), ("金额", 16.0)],
            rows: &summary,
        },
        SheetSpec {
            name: "收入明细",
            headers: &[("日期", 13.0), ("类目", 10.0), ("项目", 20.0), ("金额", 14.0)],
            rows: &income_rows,
        },
        SheetSpec {
            name: "支出明细",
            headers: &[("日期", 13.0), ("名目", 14.0), ("备注", 22.0), ("金额", 14.0)],
            rows: &expense_rows,
        },
        SheetSpec {
            name: "挂账明细",
            headers: &[("日期", 13.0), ("挂谁账上", 14.0), ("项目", 22.0), ("金额", 14.0)],
            rows: &new_credit_rows,
        },
        SheetSpec {
            name: "挂账收回明细",
            headers: &[("日期", 13.0), ("谁还的", 14.0), ("怎么结的", 10.0), ("金额", 14.0), ("备注", 20.0)],
            rows: &collected_rows,
        },
    ])?;

    Ok(Export {
        filename: format!("收支明细-{m}.xlsx"),
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;

    #[test]
    fn 跨月导出把区间颠倒过来也认() {
        // 从下拉里选月份，先点到哪个都有可能。报「起始月不能晚于结束月」
        // 只是把一个软件自己能解决的问题丢回给老板
        let conn = open_memory().unwrap();
        let a = export_sales_range(&conn, "2026-09", "2026-07").unwrap();
        assert_eq!(a.filename, "销售明细-2026-07至2026-09.xlsx");
        assert_eq!(&a.bytes[..2], b"PK");
    }

    #[test]
    fn 跨月导出只认月份不认日期() {
        // 传进来一个 2026-09-20 会让 BETWEEN 比错 —— 提前挡住
        let conn = open_memory().unwrap();
        assert!(export_sales_range(&conn, "2026-09-20", "2026-09").is_err());
        assert!(export_sales_range(&conn, "2026-09", "2026").is_err());
    }

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
