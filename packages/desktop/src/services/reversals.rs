//! 作废 · 改单 · 退货。
//!
//! 界面上老板看到的是「修改」，系统内部执行的是**作废原单 + 建新单**。
//! 已提交单据的金额、数量、商品一律不允许原地 UPDATE —— 成本快照冻结、
//! 库存流水只追加、挂账单可能已被核销，直接改会让三张表同时失真，
//! 而且事后查不出原因（红线 6，docs/05）。
//!
//! 这些函数**都不自己开事务**，由调用方（`AppState::tx`）包住 ——
//! 改单是「作废 + 重建」两步，它们必须同生共死。

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;

use crate::error::Result;
use crate::money::{div_round, qty_to_milli, Decimalish};
use crate::services::inventory::{record_movement, MovementInput, MovementType, ReverseOf};
use crate::services::purchases::{receive, ReceiveInput, ReceiveResult, Unit};
use crate::services::rebuild_allocations::rebuild_allocations;
use crate::services::sales::{checkout, CheckoutInput, CheckoutOptions, CheckoutResult};
use crate::validate::check_biz_date;
use crate::{bail, ensure};

/// 作废原因。`Revised` 是改单顺带作废的，`Mistake` 是纯粹录错了。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VoidReason {
    Revised,
    Mistake,
}

impl VoidReason {
    fn as_str(self) -> &'static str {
        match self {
            VoidReason::Revised => "revised",
            VoidReason::Mistake => "mistake",
        }
    }
}

struct SaleRow {
    biz_date: String,
    customer_id: Option<i64>,
    settle_type: String,
    rev: i64,
    voided_at: Option<String>,
    return_of_sale_id: Option<i64>,
}

struct SaleItemRow {
    product_id: i64,
    unit: Unit,
    qty_milli: i64,
    qty_base_milli: i64,
    unit_price_cents: i64,
    amount_cents: i64,
    unit_cost_base_e4: i64,
    cost_amount_cents: i64,
}

fn load_sale(conn: &Connection, sale_id: i64) -> Result<SaleRow> {
    let row = conn
        .query_row(
            "SELECT biz_date, customer_id, settle_type, rev, voided_at, return_of_sale_id
               FROM sales WHERE id = ?1",
            [sale_id],
            |r| {
                Ok(SaleRow {
                    biz_date: r.get(0)?,
                    customer_id: r.get(1)?,
                    settle_type: r.get(2)?,
                    rev: r.get(3)?,
                    voided_at: r.get(4)?,
                    return_of_sale_id: r.get(5)?,
                })
            },
        )
        .optional()?;

    match row {
        Some(r) => Ok(r),
        None => Err(crate::error::AppError::new(format!("单据不存在：{sale_id}"))),
    }
}

fn load_items(conn: &Connection, sale_id: i64) -> Result<Vec<SaleItemRow>> {
    let mut stmt = conn.prepare(
        "SELECT product_id, unit, qty_milli, qty_base_milli, unit_price_cents,
                amount_cents, unit_cost_base_e4, cost_amount_cents
           FROM sale_items WHERE sale_id = ?1 ORDER BY id",
    )?;
    let rows = stmt.query_map([sale_id], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, i64>(3)?,
            r.get::<_, i64>(4)?,
            r.get::<_, i64>(5)?,
            r.get::<_, i64>(6)?,
            r.get::<_, i64>(7)?,
        ))
    })?;

    let mut out = Vec::new();
    for row in rows {
        let (product_id, unit, qty_milli, qty_base_milli, unit_price_cents, amount_cents, unit_cost_base_e4, cost_amount_cents) = row?;
        out.push(SaleItemRow {
            product_id,
            unit: Unit::parse(&unit)?,
            qty_milli,
            qty_base_milli,
            unit_price_cents,
            amount_cents,
            unit_cost_base_e4,
            cost_amount_cents,
        });
    }
    Ok(out)
}

// ─────────────────────────── 作废销售单 ───────────────────────────

pub struct VoidResult {
    pub sale_id: i64,
    pub restored_qty_milli: i64,
}

/// 作废一张销售单 —— 这笔生意**没发生过**（录错了）。
///
/// 与退货的区别：退货是生意发生了后来退的，算在退货当天、不动当时的营业额。
/// 把退货当作废处理，会让上个月的营业额凭空缩水（docs/05）。
pub fn void_sale(conn: &Connection, sale_id: i64, reason: VoidReason) -> Result<VoidResult> {
    let sale = load_sale(conn, sale_id)?;
    if sale.voided_at.is_some() {
        bail!("这张单已经作废过了：{sale_id}");
    }

    let mut restored = 0;

    for item in load_items(conn, sale_id)? {
        // 用**原单的成本快照**把货加回去，不是当前均价
        record_movement(
            conn,
            MovementInput {
                biz_date: &sale.biz_date,
                product_id: item.product_id,
                kind: MovementType::Void,
                qty_base_milli: item.qty_base_milli,
                unit_cost_e4: item.unit_cost_base_e4,
                ref_type: "sale",
                ref_id: sale_id,
                reverse_of: Some(ReverseOf::Sale),
            },
        )?;
        restored += item.qty_base_milli;
    }

    conn.execute(
        "UPDATE sales SET voided_at = datetime('now'), void_reason = ?1 WHERE id = ?2",
        params![reason.as_str(), sale_id],
    )?;

    // 作废挂账单会释放出已核销的款项，要让它流向下一张未结清的单
    if let Some(cid) = sale.customer_id {
        rebuild_allocations(conn, cid)?;
    }

    Ok(VoidResult {
        sale_id,
        restored_qty_milli: restored,
    })
}

// ─────────────────────────── 改单 ───────────────────────────

pub struct ReviseResult {
    pub created: CheckoutResult,
    pub voided_sale_id: i64,
    pub rev: i64,
}

/// 修改一张销售单 = 作废原单 + 建新单，两张单串成修订链。
///
/// **未改动的行沿用原单成本快照**，只有换了商品或新增的行才取当前均价。
/// 否则老板只是改个数量，中间若进过货，这单毛利就会变 —— 他会认为软件在骗他。
pub fn revise_sale(conn: &Connection, sale_id: i64, new_input: &CheckoutInput) -> Result<ReviseResult> {
    let original = load_sale(conn, sale_id)?;
    if original.voided_at.is_some() {
        bail!("这张单已经作废过了，不能再改：{sale_id}");
    }
    if original.return_of_sale_id.is_some() {
        bail!("退货单不能改，要撤就作废它");
    }

    // 原单每个商品的成本快照，按商品归集
    let mut cost_override_e4 = HashMap::new();
    for item in load_items(conn, sale_id)? {
        cost_override_e4.insert(item.product_id, item.unit_cost_base_e4);
    }

    void_sale(conn, sale_id, VoidReason::Revised)?;

    let rev = original.rev + 1;
    let created = checkout(
        conn,
        new_input,
        &CheckoutOptions {
            cost_override_e4: Some(cost_override_e4),
            revision_of_sale_id: Some(sale_id),
            rev: Some(rev),
        },
    )?;

    conn.execute(
        "UPDATE sales SET superseded_by_sale_id = ?1 WHERE id = ?2",
        params![created.sale_id, sale_id],
    )?;

    Ok(ReviseResult {
        created,
        voided_sale_id: sale_id,
        rev,
    })
}

// ─────────────────────────── 退货 ───────────────────────────

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnItem {
    pub product_id: i64,
    /// 退多少（按原单的录入单位）
    pub qty: Decimalish,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReturnInput {
    /// 退货发生的日期，**不是原单日期**
    pub biz_date: String,
    #[serde(default)]
    pub note: Option<String>,
    /// 不填 = 整单退
    #[serde(default)]
    pub items: Option<Vec<ReturnItem>>,
}

pub struct ReturnResult {
    pub return_sale_id: i64,
    pub original_sale_id: i64,
    pub refund_cents: i64,
}

struct ReturnLine {
    product_id: i64,
    unit: Unit,
    qty_milli: i64,
    qty_base_milli: i64,
    unit_price_cents: i64,
    amount_cents: i64,
    unit_cost_e4: i64,
    cost_cents: i64,
}

/// 退货 —— 这笔生意发生了，后来退了。
///
/// 原单保留、照常进它那天的营业额；退货冲减**退货当天**。
/// 入库成本取原单快照，不是当前均价 —— 否则中间进过一次货、均价变了，
/// 退一笔货就会凭空产生毛利或亏损。
pub fn return_sale(
    conn: &Connection,
    original_sale_id: i64,
    input: &ReturnInput,
) -> Result<ReturnResult> {
    check_biz_date(&input.biz_date)?;

    let original = load_sale(conn, original_sale_id)?;
    if original.voided_at.is_some() {
        bail!("原单已作废，无货可退 —— 作废意味着这笔生意没发生过");
    }
    if original.return_of_sale_id.is_some() {
        bail!("退货单不能再退");
    }

    let original_items = load_items(conn, original_sale_id)?;

    // 已退过多少，防止退超
    let mut returned: HashMap<i64, i64> = HashMap::new();
    {
        let mut stmt = conn.prepare(
            "SELECT si.product_id, SUM(si.qty_base_milli)
               FROM sales s JOIN sale_items si ON si.sale_id = s.id
              WHERE s.return_of_sale_id = ?1 AND s.voided_at IS NULL
              GROUP BY si.product_id",
        )?;
        let rows = stmt.query_map([original_sale_id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
        })?;
        for row in rows {
            let (pid, q) = row?;
            returned.insert(pid, q.abs());
        }
    }

    // 不填 items = 整单退
    let wants: Vec<(i64, Option<i64>)> = match &input.items {
        Some(items) => {
            let mut out = Vec::with_capacity(items.len());
            for it in items {
                out.push((it.product_id, Some(qty_to_milli(&it.qty)?)));
            }
            out
        }
        None => original_items.iter().map(|i| (i.product_id, None)).collect(),
    };

    let mut lines = Vec::with_capacity(wants.len());

    for (product_id, want_qty_milli) in wants {
        let Some(src) = original_items.iter().find(|i| i.product_id == product_id) else {
            bail!("原单里没有这个商品：{product_id}");
        };

        // 按比例折算。**整数运算**：退 1/3 条这类情形下，
        // 先转浮点再乘会让金额差一分钱，而这一分钱会一直挂在客户账上对不平。
        let (num, den) = match want_qty_milli {
            Some(q) => {
                ensure!(q > 0, "退货数量必须为正");
                (q as i128, src.qty_milli as i128)
            }
            None => (1, 1),
        };

        let scale = |v: i64| -> Result<i64> { div_round(v as i128 * num, den) };

        let qty_base_milli = scale(src.qty_base_milli)?;
        let already = returned.get(&product_id).copied().unwrap_or(0);
        if already + qty_base_milli > src.qty_base_milli {
            bail!("退货数量超过原单：商品 {product_id}");
        }

        lines.push(ReturnLine {
            product_id: src.product_id,
            unit: src.unit,
            qty_milli: -scale(src.qty_milli)?,
            qty_base_milli: -qty_base_milli,
            unit_price_cents: src.unit_price_cents,
            amount_cents: -scale(src.amount_cents)?,
            unit_cost_e4: src.unit_cost_base_e4,
            cost_cents: -scale(src.cost_amount_cents)?,
        });
    }

    let original_cents: i64 = lines.iter().map(|l| l.amount_cents).sum();
    let cost_cents: i64 = lines.iter().map(|l| l.cost_cents).sum();

    conn.execute(
        "INSERT INTO sales
           (biz_date, customer_id, settle_type, original_amount_cents, discount_amount_cents,
            total_amount_cents, cost_amount_cents, gross_profit_cents, return_of_sale_id, note)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7, ?8, ?9)",
        params![
            input.biz_date,
            original.customer_id,
            original.settle_type,
            original_cents,
            original_cents,
            cost_cents,
            original_cents - cost_cents,
            original_sale_id,
            input.note.as_deref().unwrap_or(""),
        ],
    )?;
    let return_sale_id = conn.last_insert_rowid();

    for l in &lines {
        conn.execute(
            "INSERT INTO sale_items
               (sale_id, product_id, unit, qty_milli, qty_base_milli,
                unit_price_cents, amount_cents, unit_cost_base_e4, cost_amount_cents)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                return_sale_id,
                l.product_id,
                l.unit.as_str(),
                l.qty_milli,
                l.qty_base_milli,
                l.unit_price_cents,
                l.amount_cents,
                l.unit_cost_e4,
                l.cost_cents,
            ],
        )?;

        record_movement(
            conn,
            MovementInput {
                biz_date: &input.biz_date,
                product_id: l.product_id,
                kind: MovementType::Return,
                qty_base_milli: -l.qty_base_milli, // 货回来了，正数入库
                unit_cost_e4: l.unit_cost_e4,
                ref_type: "sale_return",
                ref_id: return_sale_id,
                reverse_of: None,
            },
        )?;
    }

    if let Some(cid) = original.customer_id {
        rebuild_allocations(conn, cid)?;
    }

    Ok(ReturnResult {
        return_sale_id,
        original_sale_id,
        refund_cents: -original_cents,
    })
}

// ─────────────────────────── 进货单 ───────────────────────────

pub struct VoidPurchaseResult {
    pub purchase_id: i64,
    pub warnings: Vec<String>,
}

/// 作废进货单。
///
/// **只调整当前库存和均价，不回溯修改任何历史成本快照** —— 那会违反红线 3，
/// 让老板上个月已经看过的利润数字发生变化。代价是此后该商品的毛利会有偏差，
/// 直到下次进货把均价拉回合理区间（docs/05）。
pub fn void_purchase(
    conn: &Connection,
    purchase_id: i64,
    reason: VoidReason,
) -> Result<VoidPurchaseResult> {
    let row = conn
        .query_row(
            "SELECT biz_date, voided_at FROM purchases WHERE id = ?1",
            [purchase_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)),
        )
        .optional()?;

    let Some((biz_date, voided_at)) = row else {
        bail!("进货单不存在：{purchase_id}");
    };
    if voided_at.is_some() {
        bail!("这张进货单已经作废过了：{purchase_id}");
    }

    let items: Vec<(i64, i64, i64)> = {
        let mut stmt = conn.prepare(
            "SELECT product_id, qty_base_milli, unit_cost_base_e4
               FROM purchase_items WHERE purchase_id = ?1",
        )?;
        let rows = stmt.query_map([purchase_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };

    let mut warnings = Vec::new();

    for (product_id, qty_base_milli, unit_cost_base_e4) in items {
        let after = record_movement(
            conn,
            MovementInput {
                biz_date: &biz_date,
                product_id,
                kind: MovementType::Void,
                qty_base_milli,
                unit_cost_e4: unit_cost_base_e4,
                ref_type: "purchase",
                ref_id: purchase_id,
                reverse_of: Some(ReverseOf::Purchase),
            },
        )?;
        warnings.extend(after.warnings.into_iter().map(|w| w.message));
    }

    conn.execute(
        "UPDATE purchases SET voided_at = datetime('now'), void_reason = ?1 WHERE id = ?2",
        params![reason.as_str(), purchase_id],
    )?;

    Ok(VoidPurchaseResult {
        purchase_id,
        warnings,
    })
}

pub struct RevisePurchaseResult {
    pub created: ReceiveResult,
    pub voided_purchase_id: i64,
}

/// 修改进货单 = 作废 + 重录。
pub fn revise_purchase(
    conn: &Connection,
    purchase_id: i64,
    new_input: &ReceiveInput,
) -> Result<RevisePurchaseResult> {
    let voided = void_purchase(conn, purchase_id, VoidReason::Revised)?;
    let mut created = receive(conn, new_input)?;

    conn.execute(
        "UPDATE purchases
            SET revision_of_purchase_id = ?1,
                rev = (SELECT rev + 1 FROM purchases WHERE id = ?1)
          WHERE id = ?2",
        params![purchase_id, created.purchase_id],
    )?;
    conn.execute(
        "UPDATE purchases SET superseded_by_purchase_id = ?1 WHERE id = ?2",
        params![created.purchase_id, purchase_id],
    )?;

    let mut warnings = voided.warnings;
    warnings.append(&mut created.warnings);
    created.warnings = warnings;

    Ok(RevisePurchaseResult {
        created,
        voided_purchase_id: purchase_id,
    })
}

// ─────────────────────────── 收款 ───────────────────────────

/// 作废收款。三者里最简单：没有成本快照，也不动库存。
pub fn void_payment(conn: &Connection, payment_id: i64, reason: VoidReason) -> Result<()> {
    let row = conn
        .query_row(
            "SELECT customer_id, voided_at FROM payments WHERE id = ?1",
            [payment_id],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?)),
        )
        .optional()?;

    let Some((customer_id, voided_at)) = row else {
        bail!("收款记录不存在：{payment_id}");
    };
    if voided_at.is_some() {
        bail!("这笔收款已经作废过了：{payment_id}");
    }

    conn.execute(
        "UPDATE payments SET voided_at = datetime('now'), void_reason = ?1 WHERE id = ?2",
        params![reason.as_str(), payment_id],
    )?;
    rebuild_allocations(conn, customer_id)?;

    Ok(())
}
