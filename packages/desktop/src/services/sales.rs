//! 结账 —— 一个事务内完成全部副作用。
//!
//! 若前端拆成「建单 → 建明细 → 扣库存 → 写流水」四个请求，中间任何一步失败
//! 数据就脏了且无法自愈。所以必须在服务端事务里包住（docs/03）。

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;

use crate::error::Result;
use crate::money::{qty_to_milli, yuan_to_cents, Decimalish};
use crate::services::inventory::{
    line_amount_cents, line_cost_cents, read_stock, record_movement, MovementInput, MovementType,
};
use crate::services::purchases::Unit;
use crate::services::rebuild_allocations::rebuild_allocations;
use crate::validate::{check_biz_date, check_items_not_empty};
use crate::{bail, ensure};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SettleType {
    Cash,
    Credit,
}

impl SettleType {
    fn as_str(self) -> &'static str {
        match self {
            SettleType::Cash => "cash",
            SettleType::Credit => "credit",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PayMethod {
    Cash,
    Wechat,
    Alipay,
    Transfer,
}

impl PayMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            PayMethod::Cash => "cash",
            PayMethod::Wechat => "wechat",
            PayMethod::Alipay => "alipay",
            PayMethod::Transfer => "transfer",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutItem {
    pub product_id: i64,
    pub unit: Unit,
    pub qty: Decimalish,
    pub unit_price_yuan: Decimalish,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialPay {
    pub amount_yuan: Decimalish,
    pub method: PayMethod,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckoutInput {
    pub biz_date: String,
    pub settle_type: SettleType,
    #[serde(default)]
    pub customer_id: Option<i64>,
    /// 抹零，让掉的钱。不是折后总额
    #[serde(default)]
    pub discount_yuan: Option<Decimalish>,
    #[serde(default)]
    pub note: Option<String>,
    pub items: Vec<CheckoutItem>,
    /// F7 部分付：卖货时先收一部分
    #[serde(default)]
    pub partial_pay: Option<PartialPay>,
}

#[derive(Default)]
pub struct CheckoutOptions {
    /// 成本快照覆盖：product_id → unit_cost_base_e4。
    ///
    /// 改单重建时用。未改动的行必须**沿用原单快照**，不能重读当前均价 ——
    /// 否则老板只是把数量 2 改成 3，中间若进过货，这单毛利就会莫名其妙变了，
    /// 他会认为软件在骗他（红线 3 的严格推论，docs/05）。
    pub cost_override_e4: Option<HashMap<i64, i64>>,
    /// 本单是哪张单修订而来
    pub revision_of_sale_id: Option<i64>,
    /// 修订版本号
    pub rev: Option<i64>,
}

pub struct CheckoutResult {
    pub sale_id: i64,
    pub total_cents: i64,
    pub gross_profit_cents: i64,
    pub payment_id: Option<i64>,
}

/// 售价回写：这次卖多少，下次就默认多少。
///
/// 不回写的话，没填过价的商品每卖一次都得重输一遍 —— 启用向导明说了
/// 「卖到时当场填一个，软件会记住」，不回写那句话就是假的。
///
/// **让利要走抹零，不要改单价。** 单价改了就是真改价，会被记住；
/// 抹零是这一单的事，不动商品。两者分开正是 discount_amount_cents 的用途。
fn write_back_price(conn: &Connection, product_id: i64, unit: Unit, price_cents: i64) -> Result<()> {
    // 列名不能参数化，但它只来自这里的两个字面量，不是外部输入
    let col = match unit {
        Unit::Pack => "price_pack_cents",
        Unit::Base => "price_base_cents",
    };
    conn.execute(
        &format!(
            "UPDATE products
                SET {col} = ?1, updated_at = datetime('now')
              WHERE id = ?2 AND ({col} IS NULL OR {col} <> ?1)"
        ),
        params![price_cents, product_id],
    )?;
    Ok(())
}

struct Line {
    product_id: i64,
    unit: Unit,
    qty_milli: i64,
    qty_base_milli: i64,
    unit_price_cents: i64,
    amount_cents: i64,
    unit_cost_e4: i64,
    cost_cents: i64,
    /// 服务型收费（桌子费这类）：没有库存也没有进价，成本恒为零、毛利就是全额
    is_service: bool,
}

/// 调用方负责开事务（见 `AppState::tx`）。
pub fn checkout(
    conn: &Connection,
    input: &CheckoutInput,
    opts: &CheckoutOptions,
) -> Result<CheckoutResult> {
    check_biz_date(&input.biz_date)?;
    check_items_not_empty(input.items.len())?;

    // 不变量 1：customer_id 非空 ⟺ settle_type = 'credit'
    // 库里有 CHECK 兜底，这里提前拦是为了给出人话错误
    let customer_id = match input.settle_type {
        SettleType::Credit => input.customer_id,
        SettleType::Cash => None,
    };
    if input.settle_type == SettleType::Credit && customer_id.is_none() {
        bail!("挂账必须指定客户");
    }
    if input.settle_type == SettleType::Cash && input.customer_id.is_some() {
        bail!("现金单不能挂客户 —— 要记客户就走挂账");
    }
    if input.partial_pay.is_some() && input.settle_type != SettleType::Credit {
        bail!("部分付属于挂账：剩余部分要记在客户账上");
    }

    let discount_cents = match &input.discount_yuan {
        Some(v) => yuan_to_cents(v)?,
        None => 0,
    };
    ensure!(discount_cents >= 0, "抹零不能是负数 —— 那是加价，不是抹零");

    let mut lines = Vec::with_capacity(input.items.len());

    for item in &input.items {
        let row: Option<(i64, bool)> = conn
            .query_row(
                "SELECT pack_ratio, is_service FROM products WHERE id = ?1",
                [item.product_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((pack_ratio, is_service)) = row else {
            bail!("商品不存在：{}", item.product_id);
        };

        let qty_milli = qty_to_milli(&item.qty)?;
        ensure!(qty_milli > 0, "数量必须为正");

        let qty_base_milli = match item.unit {
            Unit::Pack => qty_milli * pack_ratio,
            Unit::Base => qty_milli,
        };
        let unit_price_cents = yuan_to_cents(&item.unit_price_yuan)?;

        // 成本快照：读**当前**加权成本并就地冻结。
        // 历史单据的成本是既成事实，不是计算结果（红线 3）。
        // 改单重建时用原单快照覆盖，见 CheckoutOptions::cost_override_e4
        // 服务没有进价，成本就是零 —— 不是「成本未知」。
        // 走 read_stock 会读到一行空结存，数字上同样是零，但那是碰巧对
        let unit_cost_e4 = if is_service {
            0
        } else {
            match opts
                .cost_override_e4
                .as_ref()
                .and_then(|m| m.get(&item.product_id))
            {
                Some(&c) => c,
                None => read_stock(conn, item.product_id)?.avg_cost_e4,
            }
        };

        lines.push(Line {
            product_id: item.product_id,
            unit: item.unit,
            qty_milli,
            qty_base_milli,
            unit_price_cents,
            amount_cents: line_amount_cents(qty_milli, unit_price_cents)?,
            unit_cost_e4,
            cost_cents: line_cost_cents(qty_base_milli, unit_cost_e4)?,
            is_service,
        });
    }

    let original_cents: i64 = lines.iter().map(|l| l.amount_cents).sum();
    let total_cents = original_cents - discount_cents;
    let cost_cents: i64 = lines.iter().map(|l| l.cost_cents).sum();

    conn.execute(
        "INSERT INTO sales
           (biz_date, customer_id, settle_type, original_amount_cents, discount_amount_cents,
            total_amount_cents, cost_amount_cents, gross_profit_cents, note,
            revision_of_sale_id, rev)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            input.biz_date,
            customer_id,
            input.settle_type.as_str(),
            original_cents,
            discount_cents,
            total_cents,
            cost_cents,
            total_cents - cost_cents,
            input.note.as_deref().unwrap_or(""),
            opts.revision_of_sale_id,
            opts.rev.unwrap_or(1),
        ],
    )?;
    let sale_id = conn.last_insert_rowid();

    for l in &lines {
        conn.execute(
            "INSERT INTO sale_items
               (sale_id, product_id, unit, qty_milli, qty_base_milli,
                unit_price_cents, amount_cents, unit_cost_base_e4, cost_amount_cents)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                sale_id,
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

        // 服务不动库存：写了流水，桌子费就会有一个越卖越负的「结存」，
        // 库存页从此常驻一行「卖超了」，而那一行永远不可能补货补平
        if !l.is_service {
            record_movement(
                conn,
                MovementInput {
                    biz_date: &input.biz_date,
                    product_id: l.product_id,
                    kind: MovementType::Sale,
                    qty_base_milli: l.qty_base_milli,
                    unit_cost_e4: l.unit_cost_e4,
                    ref_type: "sale",
                    ref_id: sale_id,
                    reverse_of: None,
                },
            )?;

            // 售价也不回写：桌子费今天 200 明天 600，记住上一次等于记错
            write_back_price(conn, l.product_id, l.unit, l.unit_price_cents)?;
        }
    }

    let mut payment_id = None;

    // 部分付不是第三种结算方式，它就是一张挂账单 + 一笔同日收款。
    // 这样欠款、账龄、核销、预收全部沿用既有逻辑，一行特殊代码都不用写（docs/05）
    if let (Some(pp), Some(cid)) = (&input.partial_pay, customer_id) {
        conn.execute(
            "INSERT INTO payments (biz_date, customer_id, amount_cents, method, source)
             VALUES (?1, ?2, ?3, ?4, 'partial_pay')",
            params![
                input.biz_date,
                cid,
                yuan_to_cents(&pp.amount_yuan)?,
                pp.method.as_str(),
            ],
        )?;
        payment_id = Some(conn.last_insert_rowid());
    }

    if let Some(cid) = customer_id {
        rebuild_allocations(conn, cid)?;
    }

    Ok(CheckoutResult {
        sale_id,
        total_cents,
        gross_profit_cents: total_cents - cost_cents,
        payment_id,
    })
}
