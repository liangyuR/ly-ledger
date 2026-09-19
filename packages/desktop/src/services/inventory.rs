//! 库存流水与结存快照。
//!
//! `stock_movements` 是唯一真相来源，只 INSERT、永不 UPDATE / DELETE；
//! `inventory` 只是它的物化快照，任何时候都能从流水重算出来（docs/02）。

use rusqlite::{params, Connection, OptionalExtension};

use crate::bail;
use crate::error::Result;
use crate::money::div_round;
use crate::services::cost::{apply_purchase, apply_sale, reverse_purchase, CostResult, Stock};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MovementType {
    Purchase,
    Sale,
    Return,
    Void,
}

impl MovementType {
    fn as_str(self) -> &'static str {
        match self {
            MovementType::Purchase => "purchase",
            MovementType::Sale => "sale",
            MovementType::Return => "return",
            MovementType::Void => "void",
        }
    }
}

/// 作废流水撤的是哪一种流水。
///
/// 方向正好相反 —— 作废一笔**销售**是把货加回来（+qty，用原单成本快照），
/// 作废一笔**进货**是把货扣掉并反算均价（−qty）。搞混了库存会朝反方向走两倍。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReverseOf {
    Sale,
    Purchase,
}

pub struct MovementInput<'a> {
    pub biz_date: &'a str,
    pub product_id: i64,
    pub kind: MovementType,
    /// 基础单位数量，正数。方向由 kind 决定
    pub qty_base_milli: i64,
    /// 本次变动的单位成本
    pub unit_cost_e4: i64,
    pub ref_type: &'a str,
    pub ref_id: i64,
    /// kind 为 Void 时必填
    pub reverse_of: Option<ReverseOf>,
}

/// 结存快照。没有行就是零库存零成本 —— 不预建行，商品建出来时不一定有货。
pub fn read_stock(conn: &Connection, product_id: i64) -> Result<Stock> {
    let row = conn
        .query_row(
            "SELECT qty_base_milli, avg_cost_base_e4 FROM inventory WHERE product_id = ?1",
            [product_id],
            |r| Ok(Stock {
                qty_milli: r.get(0)?,
                avg_cost_e4: r.get(1)?,
            }),
        )
        .optional()?;

    Ok(row.unwrap_or(Stock::EMPTY))
}

fn write_stock(conn: &Connection, product_id: i64, next: Stock) -> Result<()> {
    conn.execute(
        "INSERT INTO inventory (product_id, qty_base_milli, avg_cost_base_e4, updated_at)
         VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT (product_id) DO UPDATE SET
           qty_base_milli   = excluded.qty_base_milli,
           avg_cost_base_e4 = excluded.avg_cost_base_e4,
           updated_at       = excluded.updated_at",
        params![product_id, next.qty_milli, next.avg_cost_e4],
    )?;
    Ok(())
}

/// 写一条库存流水并同步结存快照。
pub fn record_movement(conn: &Connection, input: MovementInput<'_>) -> Result<CostResult> {
    let prev = read_stock(conn, input.product_id)?;

    let (next, signed_qty) = match input.kind {
        MovementType::Purchase => (
            apply_purchase(prev, input.qty_base_milli, input.unit_cost_e4)?,
            input.qty_base_milli,
        ),

        // 库存允许变负，不拦（红线 1）
        MovementType::Sale => (apply_sale(prev, input.qty_base_milli)?, -input.qty_base_milli),

        // 退货入库的成本取**原单快照**，不是当前均价 ——
        // 否则中间进过一次货、均价变了，退一笔货就会凭空产生毛利（docs/05）
        MovementType::Return => (
            apply_purchase(prev, input.qty_base_milli, input.unit_cost_e4)?,
            input.qty_base_milli,
        ),

        MovementType::Void => match input.reverse_of {
            None => bail!("作废流水必须说明撤的是销售还是进货"),
            // 撤销销售 = 货回来了。按**原单成本快照**入库，均价因此保持不变：
            // 卖出时按 avg 扣、撤回时按同一个 avg 加，加权公式自然抵消。
            Some(ReverseOf::Sale) => (
                apply_purchase(prev, input.qty_base_milli, input.unit_cost_e4)?,
                input.qty_base_milli,
            ),
            Some(ReverseOf::Purchase) => (
                reverse_purchase(prev, input.qty_base_milli, input.unit_cost_e4)?,
                -input.qty_base_milli,
            ),
        },
    };

    write_stock(conn, input.product_id, next.stock)?;

    conn.execute(
        "INSERT INTO stock_movements
           (biz_date, product_id, type, qty_base_milli, unit_cost_base_e4,
            ref_type, ref_id, balance_after_milli)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            input.biz_date,
            input.product_id,
            input.kind.as_str(),
            signed_qty,
            input.unit_cost_e4,
            input.ref_type,
            input.ref_id,
            next.stock.qty_milli,
        ],
    )?;

    Ok(next)
}

/// 数量 × 单价 → 金额（分）。qty 是 milli，price 是分。
pub fn line_amount_cents(qty_milli: i64, unit_price_cents: i64) -> Result<i64> {
    div_round(qty_milli as i128 * unit_price_cents as i128, 1000)
}

/// 基础单位数量 × 单位成本 → 成本金额（分）。qty 是 milli，cost 是 e4。
pub fn line_cost_cents(qty_base_milli: i64, unit_cost_e4: i64) -> Result<i64> {
    div_round(qty_base_milli as i128 * unit_cost_e4 as i128, 100_000)
}

/// 从库存流水全量重算某商品的结存。
///
/// 用途是对账：结存快照若与流水重算结果不一致，说明有人绕过 record_movement
/// 直接改了 inventory —— 那是账对不上又查不出原因的开始。
#[allow(dead_code)]
pub fn recompute_qty_from_movements(conn: &Connection, product_id: i64) -> Result<i64> {
    let total: i64 = conn.query_row(
        "SELECT COALESCE(SUM(qty_base_milli), 0) FROM stock_movements WHERE product_id = ?1",
        [product_id],
        |r| r.get(0),
    )?;
    Ok(total)
}
