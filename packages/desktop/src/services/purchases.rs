//! 进货入库 —— 一个事务内建单、建明细、更新加权成本、写流水。

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;

use crate::error::Result;
use crate::money::{div_round, qty_to_milli, yuan_to_cents, yuan_to_e4, Decimalish};
use crate::services::inventory::{line_cost_cents, record_movement, MovementInput, MovementType};
use crate::validate::{check_biz_date, check_items_not_empty};
use crate::{bail, ensure};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiveItem {
    pub product_id: i64,
    pub unit: Unit,
    pub qty: Decimalish,
    /// 按**录入单位**的进价。整条进价会在这里换算成每包
    pub unit_cost_yuan: Decimalish,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Unit {
    Base,
    Pack,
}

impl Unit {
    pub fn as_str(self) -> &'static str {
        match self {
            Unit::Base => "base",
            Unit::Pack => "pack",
        }
    }

    pub fn parse(s: &str) -> Result<Unit> {
        match s {
            "base" => Ok(Unit::Base),
            "pack" => Ok(Unit::Pack),
            other => Err(crate::error::AppError::new(format!("未知的单位：{other}"))),
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiveInput {
    pub biz_date: String,
    #[serde(default)]
    pub supplier_id: Option<i64>,
    #[serde(default)]
    pub paid_yuan: Option<Decimalish>,
    #[serde(default)]
    pub note: Option<String>,
    pub items: Vec<ReceiveItem>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewCost {
    pub product_id: i64,
    pub avg_cost_e4: i64,
}

pub struct ReceiveResult {
    pub purchase_id: i64,
    pub total_cents: i64,
    /// 每个商品入库后的新加权成本，给界面显示「成本变了」
    pub new_costs: Vec<NewCost>,
    pub warnings: Vec<String>,
}

struct Line {
    product_id: i64,
    unit: Unit,
    qty_milli: i64,
    qty_base_milli: i64,
    unit_cost_base_e4: i64,
    amount_cents: i64,
}

/// 调用方负责开事务（见 `AppState::tx`）。
pub fn receive(conn: &Connection, input: &ReceiveInput) -> Result<ReceiveResult> {
    check_biz_date(&input.biz_date)?;
    check_items_not_empty(input.items.len())?;

    let mut lines = Vec::with_capacity(input.items.len());

    for item in &input.items {
        let pack_ratio: Option<i64> = conn
            .query_row(
                "SELECT pack_ratio FROM products WHERE id = ?1",
                [item.product_id],
                |r| r.get(0),
            )
            .optional()?;
        let Some(pack_ratio) = pack_ratio else {
            bail!("商品不存在：{}", item.product_id);
        };

        let qty_milli = qty_to_milli(&item.qty)?;
        ensure!(qty_milli > 0, "数量必须为正");

        let qty_base_milli = match item.unit {
            Unit::Pack => qty_milli * pack_ratio,
            Unit::Base => qty_milli,
        };
        let unit_cost_entered_e4 = yuan_to_e4(&item.unit_cost_yuan)?;

        // 整条 550 → 每包 55.0000；整箱 333 → 每瓶 55.5000。
        // 这一步就是四位小数存在的理由，两位会累积误差。
        let unit_cost_base_e4 = match item.unit {
            Unit::Pack => div_round(unit_cost_entered_e4 as i128, pack_ratio as i128)?,
            Unit::Base => unit_cost_entered_e4,
        };

        lines.push(Line {
            product_id: item.product_id,
            unit: item.unit,
            qty_milli,
            qty_base_milli,
            unit_cost_base_e4,
            amount_cents: line_cost_cents(qty_base_milli, unit_cost_base_e4)?,
        });
    }

    let total_cents: i64 = lines.iter().map(|l| l.amount_cents).sum();

    let paid_cents = match &input.paid_yuan {
        Some(v) => yuan_to_cents(v)?,
        None => 0,
    };

    conn.execute(
        "INSERT INTO purchases (biz_date, supplier_id, total_amount_cents, paid_amount_cents, note)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            input.biz_date,
            input.supplier_id,
            total_cents,
            paid_cents,
            input.note.as_deref().unwrap_or(""),
        ],
    )?;
    let purchase_id = conn.last_insert_rowid();

    let mut new_costs = Vec::with_capacity(lines.len());
    let mut warnings = Vec::new();

    for l in &lines {
        conn.execute(
            "INSERT INTO purchase_items
               (purchase_id, product_id, unit, qty_milli, qty_base_milli, unit_cost_base_e4, amount_cents)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                purchase_id,
                l.product_id,
                l.unit.as_str(),
                l.qty_milli,
                l.qty_base_milli,
                l.unit_cost_base_e4,
                l.amount_cents,
            ],
        )?;

        let after = record_movement(
            conn,
            MovementInput {
                biz_date: &input.biz_date,
                product_id: l.product_id,
                kind: MovementType::Purchase,
                qty_base_milli: l.qty_base_milli,
                unit_cost_e4: l.unit_cost_base_e4,
                ref_type: "purchase",
                ref_id: purchase_id,
                reverse_of: None,
            },
        )?;

        new_costs.push(NewCost {
            product_id: l.product_id,
            avg_cost_e4: after.avg_cost_e4(),
        });
        warnings.extend(after.warnings.into_iter().map(|w| w.message));
    }

    Ok(ReceiveResult {
        purchase_id,
        total_cents,
        new_costs,
        warnings,
    })
}

// ─────────────────────────── 最近入库 ───────────────────────────

/// 进货页右边那张「最近入库」表的一行。
///
/// 撤销的前提是**先找得到那一单**。录错一批货，老板记得的是
/// 「刚才那单」「昨天进的中华」，不是单号 —— 所以这里带上日期、时分和
/// 一句话摘要，让他靠眼睛认单。
#[derive(Debug, serde::Serialize)]
pub struct PurchaseListRow {
    pub id: i64,
    pub biz_date: String,
    /// created_at 的 HH:MM。同一天进两回货时靠它分辨
    pub time: String,
    pub summary: String,
    #[serde(skip)]
    pub total_cents: i64,
    /// 撤过的单留在表里，标一下。凭空消失会让老板以为自己撤错了别的单
    pub voided: bool,
}

/// 一句话说清这张进货单进了什么。
fn summarize(conn: &Connection, purchase_id: i64) -> Result<String> {
    let rows: Vec<(String, String, Option<String>, String, i64)> = {
        let mut stmt = conn.prepare(
            "SELECT p.name, p.base_unit, p.pack_unit, pi.unit, pi.qty_milli
               FROM purchase_items pi JOIN products p ON p.id = pi.product_id
              WHERE pi.purchase_id = ?1 ORDER BY pi.id",
        )?;
        let it = stmt.query_map([purchase_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?;
        it.collect::<rusqlite::Result<_>>()?
    };

    let Some((name, base_unit, pack_unit, unit, qty_milli)) = rows.first() else {
        return Ok("没有明细".to_string());
    };

    // 按**录入单位**说话：他录的是「3 条」，摘要就该写 3 条，不是 30 包
    let label = if unit == "pack" {
        pack_unit.as_deref().unwrap_or(base_unit)
    } else {
        base_unit.as_str()
    };
    let first = format!("{name} {} {label}", crate::money::milli_to_qty(*qty_milli));

    Ok(if rows.len() > 1 {
        format!("{first} 等 {} 样", rows.len())
    } else {
        first
    })
}

/// 最近入库的几单，新的在前。撤过的也列出来，标成已撤销。
pub fn recent(conn: &Connection, limit: i64) -> Result<Vec<PurchaseListRow>> {
    let raw: Vec<(i64, String, String, i64, bool)> = {
        let mut stmt = conn.prepare(
            "SELECT id, biz_date, created_at, total_amount_cents, voided_at IS NOT NULL
               FROM purchases ORDER BY id DESC LIMIT ?1",
        )?;
        let it = stmt.query_map([limit], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?;
        it.collect::<rusqlite::Result<_>>()?
    };

    let mut out = Vec::with_capacity(raw.len());
    for (id, biz_date, created_at, total_cents, voided) in raw {
        out.push(PurchaseListRow {
            id,
            biz_date,
            time: created_at.chars().skip(11).take(5).collect(),
            summary: summarize(conn, id)?,
            total_cents,
            voided,
        });
    }
    Ok(out)
}

// ─────────────────────────── 单张进货单 ───────────────────────────

/// 明细里的一行，给「这张进货单」那个框用。
pub struct PurchaseLine {
    pub product_id: i64,
    pub name: String,
    /// 按**录入单位**的数量和单位名：他录的是 3 条，这里就是 3 条
    pub qty_milli: i64,
    pub unit_label: String,
    pub unit_cost_base_e4: i64,
    pub base_unit: String,
    pub amount_cents: i64,
}

pub struct PurchaseDetail {
    pub id: i64,
    pub biz_date: String,
    pub created_at: String,
    pub total_cents: i64,
    pub paid_cents: i64,
    pub note: String,
    pub voided: bool,
    pub items: Vec<PurchaseLine>,
}

pub fn detail(conn: &Connection, id: i64) -> Result<PurchaseDetail> {
    let head = conn
        .query_row(
            "SELECT biz_date, created_at, total_amount_cents, paid_amount_cents, note,
                    voided_at IS NOT NULL
               FROM purchases WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, bool>(5)?,
                ))
            },
        )
        .optional()?;

    let Some((biz_date, created_at, total_cents, paid_cents, note, voided)) = head else {
        bail!("进货单不存在：{id}");
    };

    let items = {
        let mut stmt = conn.prepare(
            "SELECT pi.product_id, p.name, pi.qty_milli, pi.unit, p.base_unit, p.pack_unit,
                    pi.unit_cost_base_e4, pi.amount_cents
               FROM purchase_items pi JOIN products p ON p.id = pi.product_id
              WHERE pi.purchase_id = ?1 ORDER BY pi.id",
        )?;
        let rows = stmt.query_map([id], |r| {
            let unit: String = r.get(3)?;
            let base_unit: String = r.get(4)?;
            let pack_unit: Option<String> = r.get(5)?;
            // 按录入单位说话 —— 他录的是「3 条」，写「30 包」他对不上自己按的数
            let unit_label = if unit == "pack" {
                pack_unit.unwrap_or_else(|| base_unit.clone())
            } else {
                base_unit.clone()
            };
            Ok(PurchaseLine {
                product_id: r.get(0)?,
                name: r.get(1)?,
                qty_milli: r.get(2)?,
                unit_label,
                unit_cost_base_e4: r.get(6)?,
                base_unit,
                amount_cents: r.get(7)?,
            })
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };

    Ok(PurchaseDetail {
        id,
        biz_date,
        created_at,
        total_cents,
        paid_cents,
        note,
        voided,
        items,
    })
}

// ─────────────────────────── 某个商品的进货记录 ───────────────────────────

/// 这个商品是哪几次进的。
///
/// 老板找一批货是按**商品**找的，不是按单号：「这 4 条中华，2 条 6 月进的、
/// 2 条 7 月进的」。按单据翻要在几十张单里认哪张含中华，按商品翻一眼就看完。
pub struct ProductIntake {
    pub purchase_id: i64,
    pub biz_date: String,
    pub time: String,
    /// 按**录入单位**：他录的是 3 条，这里就是 3 和「条」
    pub qty_milli: i64,
    pub unit_label: String,
    pub unit_cost_base_e4: i64,
    pub base_unit: String,
    pub amount_cents: i64,
    pub voided: bool,
    /// 这张单里除了它还有别的商品 —— 撤销会把那些一起撤掉，得先说一声
    pub other_items: i64,
}

/// 按业务日期倒序。撤过的也列出来，标一下 ——
/// 凭空消失会让老板以为自己撤错了别的。
pub fn intake_of(conn: &Connection, product_id: i64, limit: i64) -> Result<Vec<ProductIntake>> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.biz_date, p.created_at, pi.qty_milli, pi.unit,
                pr.base_unit, pr.pack_unit, pi.unit_cost_base_e4, pi.amount_cents,
                p.voided_at IS NOT NULL,
                (SELECT COUNT(*) FROM purchase_items x
                  WHERE x.purchase_id = p.id AND x.product_id <> pi.product_id)
           FROM purchase_items pi
           JOIN purchases p  ON p.id = pi.purchase_id
           JOIN products  pr ON pr.id = pi.product_id
          WHERE pi.product_id = ?1
          ORDER BY p.biz_date DESC, p.id DESC
          LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![product_id, limit], |r| {
        let unit: String = r.get(4)?;
        let base_unit: String = r.get(5)?;
        let pack_unit: Option<String> = r.get(6)?;
        let unit_label = if unit == "pack" {
            pack_unit.unwrap_or_else(|| base_unit.clone())
        } else {
            base_unit.clone()
        };
        Ok(ProductIntake {
            purchase_id: r.get(0)?,
            biz_date: r.get(1)?,
            time: r.get::<_, String>(2)?.chars().skip(11).take(5).collect(),
            qty_milli: r.get(3)?,
            unit_label,
            unit_cost_base_e4: r.get(7)?,
            base_unit,
            amount_cents: r.get(8)?,
            voided: r.get(9)?,
            other_items: r.get(10)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}
