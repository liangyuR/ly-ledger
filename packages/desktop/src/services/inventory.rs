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

/// 库存总览：进货页左边那张表。
///
/// 字段名故意保持库里的列名（`base_unit` 而不是 `baseUnit`）——
/// 前端的 Product 接口吃的就是这套名字，点一行就能直接进补货那一步。
#[derive(Debug, serde::Serialize)]
pub struct StockLine {
    pub id: i64,
    pub name: String,
    pub base_unit: String,
    pub pack_unit: Option<String>,
    pub pack_ratio: i64,
    pub price_base_cents: Option<i64>,
    pub price_pack_cents: Option<i64>,
    #[serde(skip)]
    pub qty_milli: i64,
    #[serde(skip)]
    pub avg_cost_e4: i64,
    /// 近 90 天补过几次货
    #[serde(rename = "restockCount")]
    pub restock_count: i64,
    /// 最近一次进货的业务日期。列表按它的月份分组，没进过货的排最后
    #[serde(rename = "lastIntake")]
    pub last_intake: Option<String>,
}

/// 按**最近进货的月份**分组，新的月份在上面；同一个月里仍按补货频次排。
///
/// 分组的理由是老板找货是按批次找的：「6 月进的那批茶还剩多少」。
/// 月份之内还按补货频次 —— 这张表是站在货架前用的，每周都要补的那几样
/// 该在同月里排前面，卖得多但进得少的东西排前面没用。
///
/// 没有结存行就是零库存零成本，不是「查不到」；一次货都没进过的商品
/// 没有月份可归，排在最后 —— 空列表比排错更糟。
///
/// **不截断。** 底下那句「共 N 样」数的就是这张表，截断了数字就跟着骗人。
pub fn stock_overview(conn: &Connection) -> Result<Vec<StockLine>> {
    let day = crate::services::reports::today(conn)?;
    let mut stmt = conn.prepare(
        "SELECT p.id, p.name, p.base_unit, p.pack_unit, p.pack_ratio,
                p.price_base_cents, p.price_pack_cents,
                COALESCE(i.qty_base_milli, 0)   AS qty_milli,
                COALESCE(i.avg_cost_base_e4, 0) AS avg_cost_e4,
                -- 数 pu 不数 pi：作废的单和 90 天以前的单在这个 JOIN 上匹配不到，
                -- 数 pi 会把它们一起算进来，排序就成了「历史上进得多」
                COUNT(pu.id) AS restock_count,
                -- 最近一次进的是哪天。不受 90 天窗口限制 ——
                -- 去年进的货今天还在货架上，它照样得有个月份可归
                (SELECT MAX(pu2.biz_date)
                   FROM purchase_items pi2
                   JOIN purchases pu2 ON pu2.id = pi2.purchase_id AND pu2.voided_at IS NULL
                  WHERE pi2.product_id = p.id) AS last_intake
           FROM products p
           LEFT JOIN inventory i      ON i.product_id  = p.id
           LEFT JOIN purchase_items pi ON pi.product_id = p.id
           LEFT JOIN purchases pu      ON pu.id = pi.purchase_id
                AND pu.voided_at IS NULL
                AND pu.biz_date >= date(?1, '-90 day')
          -- 服务型收费（桌子费）不进这张表：它没有库存，列出来就是一行永远为 0
          WHERE p.is_active = 1 AND p.is_service = 0
          GROUP BY p.id
          -- SQLite 没有 NULLS LAST，用一个布尔列顶上：没进过货的排到最后
          ORDER BY last_intake IS NULL, last_intake DESC,
                   restock_count DESC, p.sort_weight DESC, p.id",
    )?;
    let rows = stmt.query_map(params![day], |r| {
        Ok(StockLine {
            id: r.get(0)?,
            name: r.get(1)?,
            base_unit: r.get(2)?,
            pack_unit: r.get(3)?,
            pack_ratio: r.get(4)?,
            price_base_cents: r.get(5)?,
            price_pack_cents: r.get(6)?,
            qty_milli: r.get(7)?,
            avg_cost_e4: r.get(8)?,
            restock_count: r.get(9)?,
            last_intake: r.get(10)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}
