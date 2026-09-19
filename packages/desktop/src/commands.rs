//! invoke 命令 —— 前端能调到的全部东西。
//!
//! 这一层的职责只有两件：**开事务**和**格式化出参**。业务逻辑一律在
//! services 里，这里不写 if。
//!
//! 出参形状跟 Node 版的 HTTP 响应**逐字一致**（少了一个恒真的 `ok`），
//! 所以前端页面一行没改。金额一律以**字符串**出去：库里是整数分，
//! 出参时格式化成 "1100.00"。前端不做金额运算，只做展示 ——
//! 一旦在 JS 里用 number 算钱，0.1+0.2 那类问题就会回来。

use rusqlite::Connection;
use serde_json::{json, Value};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, Result};
use crate::money::{
    cents_to_yuan, e4_to_yuan, milli_to_qty, permille_to_percent, yuan_to_cents, Decimalish,
};
use crate::services::{
    backup, excel, onboarding, payments, product_import, profit_reports, purchases,
    rebuild_allocations, reports, reversals, sale_detail, sales, seed_import,
};
use crate::sql_json::rows_to_json;
use crate::state::AppState;
use crate::{bail, ensure};

// ═══════════════════════ 商品 ═══════════════════════

/// 三路匹配：名称包含、全拼前缀、首字母前缀。
///
/// 两个拼音字段都要 —— 只做首字母会逼老板记缩写，只做全拼则打字太多。
#[tauri::command]
pub fn products_list(state: State<'_, AppState>, q: Option<String>) -> Result<Value> {
    state.with(|conn| {
        let q = q.as_deref().unwrap_or("").trim().to_string();
        let items = if q.is_empty() {
            let mut stmt = conn.prepare(
                "SELECT * FROM products WHERE is_active = 1 ORDER BY sort_weight DESC, id LIMIT 50",
            )?;
            rows_to_json(&mut stmt, [])?
        } else {
            let mut stmt = conn.prepare(
                "SELECT * FROM products
                  WHERE is_active = 1
                    AND (name LIKE ?1 OR pinyin_full LIKE ?2 OR pinyin_abbr LIKE ?2)
                  ORDER BY sort_weight DESC, id
                  LIMIT 50",
            )?;
            rows_to_json(&mut stmt, rusqlite::params![format!("%{q}%"), format!("{q}%")])?
        };
        Ok(json!({ "items": items }))
    })
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProduct {
    pub name: String,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub brand: Option<String>,
    #[serde(default)]
    pub spec: Option<String>,
    pub base_unit: String,
    #[serde(default)]
    pub pack_unit: Option<String>,
    #[serde(default)]
    pub pack_ratio: Option<i64>,
    #[serde(default)]
    pub pinyin_full: Option<String>,
    #[serde(default)]
    pub pinyin_abbr: Option<String>,
    #[serde(default)]
    pub price_base_yuan: Option<Decimalish>,
    #[serde(default)]
    pub price_pack_yuan: Option<Decimalish>,
}

#[tauri::command]
pub fn product_create(state: State<'_, AppState>, input: NewProduct) -> Result<Value> {
    state.tx(|conn| {
        let name = input.name.trim();
        ensure!(!name.is_empty(), "商品名不能为空");
        ensure!(!input.base_unit.trim().is_empty(), "基础单位不能为空");

        // 同名即同商品 —— 整条卖和单包卖是一个商品的两种卖法，不是两条记录。
        // 建成两条会让库存裂成两份，且错得极隐蔽（docs/02）
        let dup: Option<i64> = conn
            .query_row("SELECT id FROM products WHERE name = ?1", [name], |r| r.get(0))
            .ok();
        if dup.is_some() {
            bail!("商品「{name}」已存在");
        }

        let py = crate::services::pinyin::to_pinyin(name);

        conn.execute(
            "INSERT INTO products (name, pinyin_full, pinyin_abbr, category, brand, spec,
                                   base_unit, pack_unit, pack_ratio, price_base_cents, price_pack_cents)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            rusqlite::params![
                name,
                // 拼音自动生成，老板不用管。多音字可以事后手工改
                input.pinyin_full.as_deref().unwrap_or(&py.full),
                input.pinyin_abbr.as_deref().unwrap_or(&py.abbr),
                input.category.as_deref().unwrap_or("other"),
                input.brand.as_deref().unwrap_or(""),
                input.spec.as_deref().unwrap_or(""),
                input.base_unit.trim(),
                input.pack_unit,
                input.pack_ratio.unwrap_or(1),
                input.price_base_yuan.as_ref().map(yuan_to_cents).transpose()?,
                input.price_pack_yuan.as_ref().map(yuan_to_cents).transpose()?,
            ],
        )?;

        Ok(json!({ "productId": conn.last_insert_rowid() }))
    })
}

/// 改商品。商品页支持双击格子直接改 —— 批量填价格是启用期最高频的操作，
/// 不该逐个进详情页（docs/04）。
///
/// 只改**传了的字段**。`price_base_yuan: null` 是「清空价格」，
/// 不传则是「别动这一列」—— 两者不是一回事，合并会让清价格这件事没法做。
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProductPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default)]
    pub brand: Option<String>,
    #[serde(default)]
    pub spec: Option<String>,
    #[serde(default)]
    pub base_unit: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub pack_unit: Option<Option<String>>,
    #[serde(default)]
    pub pack_ratio: Option<i64>,
    #[serde(default, deserialize_with = "double_option")]
    pub price_base_yuan: Option<Option<Decimalish>>,
    #[serde(default, deserialize_with = "double_option")]
    pub price_pack_yuan: Option<Option<Decimalish>>,
    #[serde(default)]
    pub sort_weight: Option<i64>,
    #[serde(default)]
    pub is_active: Option<bool>,
}

/// 区分「没传这个字段」和「传了 null」。
fn double_option<'de, D, T>(de: D) -> std::result::Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    serde::Deserialize::deserialize(de).map(Some)
}

/// 空字符串等同于清空 —— 老板把价格格子里的字删光就是这个意思。
fn price_of(v: &Option<Decimalish>) -> Result<Option<i64>> {
    match v {
        None => Ok(None),
        Some(d) if d.text().trim().is_empty() => Ok(None),
        Some(d) => Ok(Some(yuan_to_cents(d)?)),
    }
}

#[tauri::command]
pub fn product_update(state: State<'_, AppState>, id: i64, patch: ProductPatch) -> Result<Value> {
    state.tx(|conn| {
        let exists: Option<i64> = conn
            .query_row("SELECT id FROM products WHERE id = ?1", [id], |r| r.get(0))
            .ok();
        if exists.is_none() {
            bail!("商品不存在：{id}");
        }

        let mut sets: Vec<String> = Vec::new();
        let mut args: Vec<rusqlite::types::Value> = Vec::new();
        let mut put = |col: &str, val: rusqlite::types::Value| {
            sets.push(format!("{col} = ?{}", sets.len() + 1));
            args.push(val);
        };

        if let Some(name) = &patch.name {
            let name = name.trim();
            ensure!(!name.is_empty(), "商品名不能为空");
            let dup: Option<i64> = conn
                .query_row(
                    "SELECT id FROM products WHERE name = ?1 AND id <> ?2",
                    rusqlite::params![name, id],
                    |r| r.get(0),
                )
                .ok();
            if dup.is_some() {
                bail!("已经有叫「{name}」的商品了");
            }
            let py = crate::services::pinyin::to_pinyin(name);
            put("name", name.to_string().into());
            put("pinyin_full", py.full.into());
            put("pinyin_abbr", py.abbr.into());
        }
        if let Some(v) = &patch.brand {
            put("brand", v.clone().into());
        }
        if let Some(v) = &patch.spec {
            put("spec", v.clone().into());
        }
        if let Some(v) = &patch.base_unit {
            put("base_unit", v.clone().into());
        }
        if let Some(v) = &patch.pack_unit {
            put("pack_unit", v.clone().into());
        }
        if let Some(v) = patch.pack_ratio {
            put("pack_ratio", v.into());
        }
        if let Some(v) = &patch.price_base_yuan {
            put("price_base_cents", price_of(v)?.into());
        }
        if let Some(v) = &patch.price_pack_yuan {
            put("price_pack_cents", price_of(v)?.into());
        }
        if let Some(v) = patch.sort_weight {
            put("sort_weight", v.into());
        }
        if let Some(v) = patch.is_active {
            put("is_active", i64::from(v).into());
        }

        if sets.is_empty() {
            return Ok(json!({ "productId": id, "changed": 0 }));
        }

        let changed = sets.len();
        let sql = format!(
            "UPDATE products SET {}, updated_at = datetime('now') WHERE id = ?{}",
            sets.join(", "),
            changed + 1
        );
        args.push(id.into());
        conn.execute(&sql, rusqlite::params_from_iter(args))?;

        Ok(json!({ "productId": id, "changed": changed }))
    })
}

/// 常用商品：近 30 天销量前 12，数字键直选用。
#[tauri::command]
pub fn products_frequent(state: State<'_, AppState>) -> Result<Value> {
    state.with(|conn| {
        let items: Vec<Value> = reports::frequent_products(conn, 12)?
            .into_iter()
            .map(|p| {
                let price_base = p.price_base_cents.map(cents_to_yuan);
                let price_pack = p.price_pack_cents.map(cents_to_yuan);
                let mut v = serde_json::to_value(p)?;
                let obj = v.as_object_mut().expect("商品是个对象");
                obj.insert("priceBase".into(), json!(price_base));
                obj.insert("pricePack".into(), json!(price_pack));
                Ok(v)
            })
            .collect::<Result<_>>()?;
        Ok(json!({ "items": items }))
    })
}

#[tauri::command]
pub fn product_stock(state: State<'_, AppState>, product_id: i64) -> Result<Value> {
    state.with(|conn| {
        let stock = crate::services::inventory::read_stock(conn, product_id)?;
        Ok(json!({
            "qty": milli_to_qty(stock.qty_milli),
            "avgCost": e4_to_yuan(stock.avg_cost_e4),
            // 负库存只提醒，不拦路（红线 1）
            "negative": stock.qty_milli < 0,
        }))
    })
}

// ═══════════════════════ 商品批量导入 ═══════════════════════
// 把商品弄进来的三条路：预置目录勾选、手工清单、卖货时就地建。
// 三条并行，缺一不可 —— 商品库不全不能阻塞记账（docs/01）

#[tauri::command]
pub fn seed_brands(state: State<'_, AppState>) -> Result<Value> {
    state.with(|conn| Ok(json!({ "brands": seed_import::list_seed_brands(conn)? })))
}

#[tauri::command]
pub fn seed_import_brands(state: State<'_, AppState>, brands: Vec<String>) -> Result<Value> {
    state.tx(|conn| {
        ensure!(
            !brands.is_empty(),
            "至少勾一个牌子。全量导入会让搜索跳出一堆你根本不卖的牌子"
        );
        let r = seed_import::import_seed_brands(conn, &brands)?;
        Ok(json!({ "created": r.created, "skipped": r.skipped }))
    })
}

/// 解析预览，不落库。看不懂的行标出来，允许就地改完再导。
#[tauri::command]
pub fn products_parse_import(state: State<'_, AppState>, text: Option<String>) -> Result<Value> {
    state.with(|conn| {
        let r = product_import::parse_product_list(conn, text.as_deref().unwrap_or(""))?;
        Ok(json!({ "rows": r.rows, "summary": r.summary }))
    })
}

#[tauri::command]
pub fn products_import(
    state: State<'_, AppState>,
    text: Option<String>,
    category: Option<String>,
) -> Result<Value> {
    state.tx(|conn| {
        let r = product_import::import_product_list(
            conn,
            text.as_deref().unwrap_or(""),
            category.as_deref().unwrap_or("other"),
        )?;
        Ok(json!({ "created": r.created, "skipped": r.skipped, "invalid": r.invalid }))
    })
}

// ═══════════════════════ 客户与供应商 ═══════════════════════

#[tauri::command]
pub fn customers_list(state: State<'_, AppState>, q: Option<String>) -> Result<Value> {
    state.with(|conn| {
        let q = q.as_deref().unwrap_or("").trim().to_string();
        let items = if q.is_empty() {
            let mut stmt =
                conn.prepare("SELECT * FROM customers WHERE is_active = 1 ORDER BY id LIMIT 30")?;
            rows_to_json(&mut stmt, [])?
        } else {
            let mut stmt = conn.prepare(
                "SELECT * FROM customers
                  WHERE is_active = 1 AND (name LIKE ?1 OR pinyin_full LIKE ?2 OR pinyin_abbr LIKE ?2)
                  ORDER BY id LIMIT 30",
            )?;
            rows_to_json(&mut stmt, rusqlite::params![format!("%{q}%"), format!("{q}%")])?
        };
        Ok(json!({ "items": items }))
    })
}

#[tauri::command]
pub fn customer_create(
    state: State<'_, AppState>,
    name: Option<String>,
    phone: Option<String>,
) -> Result<Value> {
    state.tx(|conn| {
        let name = name.as_deref().unwrap_or("").trim().to_string();
        ensure!(!name.is_empty(), "客户名不能为空");

        let dup: Option<i64> = conn
            .query_row("SELECT id FROM customers WHERE name = ?1", [&name], |r| r.get(0))
            .ok();
        if dup.is_some() {
            bail!("客户「{name}」已存在");
        }

        let py = crate::services::pinyin::to_pinyin(&name);
        conn.execute(
            "INSERT INTO customers (name, pinyin_full, pinyin_abbr, phone) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![name, py.full, py.abbr, phone.as_deref().unwrap_or("")],
        )?;

        Ok(json!({ "customerId": conn.last_insert_rowid() }))
    })
}

#[tauri::command]
pub fn suppliers_list(state: State<'_, AppState>) -> Result<Value> {
    state.with(|conn| {
        let mut stmt = conn.prepare("SELECT * FROM suppliers ORDER BY id")?;
        Ok(json!({ "items": rows_to_json(&mut stmt, [])? }))
    })
}

#[tauri::command]
pub fn supplier_create(
    state: State<'_, AppState>,
    name: Option<String>,
    phone: Option<String>,
) -> Result<Value> {
    state.tx(|conn| {
        let name = name.as_deref().unwrap_or("").trim().to_string();
        ensure!(!name.is_empty(), "供应商名不能为空");

        let dup: Option<i64> = conn
            .query_row("SELECT id FROM suppliers WHERE name = ?1", [&name], |r| r.get(0))
            .ok();
        if dup.is_some() {
            bail!("供应商「{name}」已存在");
        }

        conn.execute(
            "INSERT INTO suppliers (name, phone) VALUES (?1, ?2)",
            rusqlite::params![name, phone.as_deref().unwrap_or("")],
        )?;

        Ok(json!({ "supplierId": conn.last_insert_rowid() }))
    })
}

// ═══════════════════════ 三个正向事务 action ═══════════════════════

#[tauri::command]
pub fn sales_checkout(state: State<'_, AppState>, input: sales::CheckoutInput) -> Result<Value> {
    state.tx(|conn| {
        let r = sales::checkout(conn, &input, &sales::CheckoutOptions::default())?;
        Ok(json!({
            "saleId": r.sale_id,
            "total": cents_to_yuan(r.total_cents),
            "grossProfit": cents_to_yuan(r.gross_profit_cents),
            "paymentId": r.payment_id,
        }))
    })
}

#[tauri::command]
pub fn purchases_receive(
    state: State<'_, AppState>,
    input: purchases::ReceiveInput,
) -> Result<Value> {
    state.tx(|conn| {
        let r = purchases::receive(conn, &input)?;
        Ok(json!({
            "purchaseId": r.purchase_id,
            "total": cents_to_yuan(r.total_cents),
            // 录完立刻告诉老板成本变了 —— 这是进货页要显示的东西
            "newCosts": r.new_costs.iter().map(|c| json!({
                "productId": c.product_id,
                "avgCost": e4_to_yuan(c.avg_cost_e4),
            })).collect::<Vec<_>>(),
            "warnings": r.warnings,
        }))
    })
}

#[tauri::command]
pub fn payments_collect(state: State<'_, AppState>, input: payments::CollectInput) -> Result<Value> {
    state.tx(|conn| {
        let r = payments::collect(conn, &input)?;
        Ok(json!({
            "paymentId": r.payment_id,
            "prepaid": cents_to_yuan(r.prepaid_cents),
            "netDebt": cents_to_yuan(r.debt.net_debt_cents),
            "earliestUnpaidDate": r.debt.earliest_unpaid_date,
        }))
    })
}

// ═══════════════════════ 单据详情与流水 ═══════════════════════

#[tauri::command]
pub fn sale_detail(state: State<'_, AppState>, id: i64) -> Result<Value> {
    state.with(|conn| {
        let d = sale_detail::sale_detail(conn, id)?;
        Ok(json!({
            "id": d.id,
            "bizDate": d.biz_date,
            "createdAt": d.created_at,
            "settleType": d.settle_type,
            "customerId": d.customer_id,
            "customerName": d.customer_name,
            "original": cents_to_yuan(d.original_cents),
            "discount": cents_to_yuan(d.discount_cents),
            "total": cents_to_yuan(d.total_cents),
            "cost": cents_to_yuan(d.cost_cents),
            "profit": cents_to_yuan(d.profit_cents),
            "returned": cents_to_yuan(d.returned_cents),
            "settled": cents_to_yuan(d.settled_cents),
            "note": d.note,
            "rev": d.rev,
            "voidedAt": d.voided_at,
            "voidReason": d.void_reason,
            "items": d.items.iter().map(|i| json!({
                "productId": i.product_id,
                "name": i.name,
                "qty": milli_to_qty(i.qty_milli),
                "unitLabel": i.unit_label,
                "unit": i.unit,
                "unitPrice": cents_to_yuan(i.unit_price_cents),
                "amount": cents_to_yuan(i.amount_cents),
                // 成交那一刻冻结的成本，不是当前均价
                "unitCost": e4_to_yuan(i.unit_cost_e4),
                "cost": cents_to_yuan(i.cost_cents),
                "profit": cents_to_yuan(i.profit_cents),
            })).collect::<Vec<_>>(),
            "events": d.events.iter().map(|e| json!({
                "kind": e.kind,
                "saleId": e.sale_id,
                "time": slice_chars(&e.at, 11, 5),
                "date": slice_chars(&e.at, 0, 10),
                "rev": e.rev,
                "summary": e.summary,
                "current": e.current,
            })).collect::<Vec<_>>(),
            "canRevise": d.can_revise,
            "canReturn": d.can_return,
            "blockedReason": d.blocked_reason,
        }))
    })
}

fn slice_chars(s: &str, skip: usize, take: usize) -> String {
    s.chars().skip(skip).take(take).collect()
}

#[tauri::command]
pub fn sales_by_date(state: State<'_, AppState>, date: Option<String>) -> Result<Value> {
    state.with(|conn| {
        let date = match &date {
            Some(d) => d.clone(),
            None => reports::today(conn)?,
        };
        let items: Vec<Value> = sale_detail::list_sales(conn, &date)?
            .into_iter()
            .map(|s| {
                json!({
                    "id": s.id,
                    "time": s.time,
                    "summary": s.summary,
                    "totalCents": s.total_cents,
                    "settleType": s.settle_type,
                    "customerName": s.customer_name,
                    "total": cents_to_yuan(s.total_cents),
                })
            })
            .collect();
        Ok(json!({ "date": date, "items": items }))
    })
}

// ═══════════════════════ 逆向：作废 / 改单 / 退货 ═══════════════════════
// 界面上老板看到的是「修改」和「退货」，不出现「作废」「红冲」这类会计词汇

#[tauri::command]
pub fn sale_void(state: State<'_, AppState>, id: i64) -> Result<Value> {
    state.tx(|conn| {
        let r = reversals::void_sale(conn, id, reversals::VoidReason::Mistake)?;
        Ok(json!({
            "saleId": r.sale_id,
            "restoredQty": milli_to_qty(r.restored_qty_milli),
        }))
    })
}

#[tauri::command]
pub fn sale_revise(
    state: State<'_, AppState>,
    id: i64,
    input: sales::CheckoutInput,
) -> Result<Value> {
    state.tx(|conn| {
        let r = reversals::revise_sale(conn, id, &input)?;
        Ok(json!({
            "saleId": r.created.sale_id,
            "rev": r.rev,
            "replacedSaleId": r.voided_sale_id,
            "total": cents_to_yuan(r.created.total_cents),
            "grossProfit": cents_to_yuan(r.created.gross_profit_cents),
        }))
    })
}

#[tauri::command]
pub fn sale_return(
    state: State<'_, AppState>,
    id: i64,
    input: reversals::ReturnInput,
) -> Result<Value> {
    state.tx(|conn| {
        let r = reversals::return_sale(conn, id, &input)?;
        Ok(json!({
            "returnSaleId": r.return_sale_id,
            "originalSaleId": r.original_sale_id,
            "refund": cents_to_yuan(r.refund_cents),
        }))
    })
}

#[tauri::command]
pub fn purchase_void(state: State<'_, AppState>, id: i64) -> Result<Value> {
    state.tx(|conn| {
        let r = reversals::void_purchase(conn, id, reversals::VoidReason::Mistake)?;
        Ok(json!({ "purchaseId": r.purchase_id, "warnings": r.warnings }))
    })
}

#[tauri::command]
pub fn purchase_revise(
    state: State<'_, AppState>,
    id: i64,
    input: purchases::ReceiveInput,
) -> Result<Value> {
    state.tx(|conn| {
        let r = reversals::revise_purchase(conn, id, &input)?;
        Ok(json!({
            "purchaseId": r.created.purchase_id,
            "replacedPurchaseId": r.voided_purchase_id,
            "total": cents_to_yuan(r.created.total_cents),
            "warnings": r.created.warnings,
        }))
    })
}

#[tauri::command]
pub fn payment_void(state: State<'_, AppState>, id: i64) -> Result<Value> {
    state.tx(|conn| {
        reversals::void_payment(conn, id, reversals::VoidReason::Mistake)?;
        Ok(json!({}))
    })
}

/// 逃生舱：核销是派生数据，万一失准，重算一次即自愈，不需要人工改数据。
/// 这是把 allocations 做成派生表的额外收益。
#[tauri::command]
pub fn customer_rebuild_allocations(state: State<'_, AppState>, id: i64) -> Result<Value> {
    state.tx(|conn| {
        let r = rebuild_allocations::rebuild_allocations(conn, id)?;
        Ok(json!({
            "allocations": r.allocations.len(),
            "prepaid": cents_to_yuan(r.prepaid_cents),
        }))
    })
}

// ═══════════════════════ 欠款 ═══════════════════════

#[tauri::command]
pub fn customer_debt(state: State<'_, AppState>, id: i64) -> Result<Value> {
    state.with(|conn| {
        let d = rebuild_allocations::read_debt(conn, id)?;
        Ok(json!({
            "customerId": d.customer_id,
            "name": d.name,
            "netDebt": cents_to_yuan(d.net_debt_cents),
            "isPrepaid": d.net_debt_cents < 0,
            "earliestUnpaidDate": d.earliest_unpaid_date,
        }))
    })
}

#[tauri::command]
pub fn customers_debts(state: State<'_, AppState>) -> Result<Value> {
    state.with(|conn| {
        let d = reports::list_debts(conn, None)?;
        let fmt = |r: &reports::DebtRow| {
            json!({
                "customerId": r.customer_id,
                "name": r.name,
                // 预收对外显示成正数，前端只管标签不同
                "amount": cents_to_yuan(r.net_debt_cents.abs()),
                "earliestUnpaidDate": r.earliest_unpaid_date,
                "agingDays": r.aging_days,
            })
        };
        Ok(json!({
            "today": reports::today(conn)?,
            "owing": d.owing.iter().map(fmt).collect::<Vec<_>>(),
            "prepaid": d.prepaid.iter().map(fmt).collect::<Vec<_>>(),
            "totalOwing": cents_to_yuan(d.owing.iter().map(|r| r.net_debt_cents).sum()),
        }))
    })
}

// ═══════════════════════ 看板与利润报表 ═══════════════════════
// 每个数字都是毛利：售价 − 成本，不含房租水电人工（红线 5）

#[tauri::command]
pub fn reports_dashboard(state: State<'_, AppState>) -> Result<Value> {
    state.with(|conn| {
        let d = reports::dashboard(conn)?;
        Ok(json!({
            "date": d.date,
            "todayRevenue": cents_to_yuan(d.today_revenue_cents),
            "todayProfit": cents_to_yuan(d.today_profit_cents),
            "monthProfit": cents_to_yuan(d.month_profit_cents),
            "inventoryValue": cents_to_yuan(d.inventory_value_cents),
            "debtTotal": cents_to_yuan(d.debt_total_cents),
            "debtCount": d.debt_count,
            "alerts": d.alerts,
            "recentSales": d.recent_sales.iter().map(|s| json!({
                "id": s.id,
                "time": s.time,
                "summary": s.summary,
                "totalCents": s.total_cents,
                "settleType": s.settle_type,
                "customerName": s.customer_name,
                "total": cents_to_yuan(s.total_cents),
            })).collect::<Vec<_>>(),
        }))
    })
}

#[tauri::command]
pub fn reports_profit(state: State<'_, AppState>, month: Option<String>) -> Result<Value> {
    state.with(|conn| {
        let m = month.as_deref();
        let inv = profit_reports::inventory_summary(conn)?;
        let alert = profit_reports::cost_unknown_alert(conn, m)?;

        Ok(json!({
            "month": match m {
                Some(m) => m.to_string(),
                None => reports::today(conn)?[..7].to_string(),
            },
            "monthly": profit_reports::monthly_trend(conn, 6)?.iter().map(|m| json!({
                "month": m.month,
                "revenue": cents_to_yuan(m.revenue_cents),
                "profit": cents_to_yuan(m.profit_cents),
                "profitCents": m.profit_cents,
                "partial": m.partial,
            })).collect::<Vec<_>>(),
            "daily": profit_reports::daily_trend(conn, 30)?.iter().map(|d| json!({
                "date": d.date,
                "revenue": cents_to_yuan(d.revenue_cents),
                "profit": cents_to_yuan(d.profit_cents),
            })).collect::<Vec<_>>(),
            "ranking": profit_reports::product_ranking(conn, m, 20)?.iter().map(|r| json!({
                "productId": r.product_id,
                "name": r.name,
                "qty": milli_to_qty(r.qty_base_milli),
                "revenue": cents_to_yuan(r.revenue_cents),
                "profit": cents_to_yuan(r.profit_cents),
                "profitCents": r.profit_cents,
                "margin": r.margin_permille.map(permille_to_percent),
                "costUnknown": r.cost_unknown,
            })).collect::<Vec<_>>(),
            "stale": profit_reports::stale_products(conn, 90)?.iter().map(|s| json!({
                "productId": s.product_id,
                "name": s.name,
                "qty": format!("{} {}", milli_to_qty(s.qty_base_milli), s.base_unit),
                "value": cents_to_yuan(s.value_cents),
                "lastSoldDate": s.last_sold_date,
                "idleDays": s.idle_days,
            })).collect::<Vec<_>>(),
            "inventory": {
                "totalValue": cents_to_yuan(inv.total_value_cents),
                "skuCount": inv.sku_count,
                "negativeCount": inv.negative_count,
            },
            // 没进过货就卖掉的那部分，毛利等于全额售价，虚高。必须说出来
            "costUnknown": {
                "productCount": alert.product_count,
                "revenue": cents_to_yuan(alert.revenue_cents),
                "names": alert.names,
            },
        }))
    })
}

// ═══════════════════════ 启用向导 ═══════════════════════
// 完成标准是「卖出第一笔」，不是「把表填完」。进度一律现算，不落库 ——
// 老板绕开向导自己把事做了，清单还在催他，比不做向导更糟

#[tauri::command]
pub fn onboarding_state(state: State<'_, AppState>) -> Result<Value> {
    state.with(|conn| Ok(serde_json::to_value(onboarding::onboarding_state(conn)?)?))
}

#[tauri::command]
pub fn onboarding_dismiss(state: State<'_, AppState>, on: Option<bool>) -> Result<Value> {
    state.tx(|conn| {
        onboarding::dismiss_onboarding(conn, on.unwrap_or(true))?;
        Ok(serde_json::to_value(onboarding::onboarding_state(conn)?)?)
    })
}

#[tauri::command]
pub fn onboarding_skip_stock(state: State<'_, AppState>) -> Result<Value> {
    state.tx(|conn| {
        onboarding::skip_opening_stock(conn, true)?;
        Ok(serde_json::to_value(onboarding::onboarding_state(conn)?)?)
    })
}

/// 期初库存。
///
/// 本质就是一张进货单，note 写「期初库存」——**不是**特殊单据类型。
/// 走同一套加权成本、同一套改单作废，一行特殊逻辑都不用写（docs/05）。
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpeningStockInput {
    #[serde(default)]
    pub biz_date: Option<String>,
    #[serde(default)]
    pub items: Vec<purchases::ReceiveItem>,
}

#[tauri::command]
pub fn onboarding_opening_stock(
    state: State<'_, AppState>,
    input: OpeningStockInput,
) -> Result<Value> {
    state.tx(|conn| {
        let items: Vec<purchases::ReceiveItem> = input
            .items
            .into_iter()
            .filter(|i| {
                i.product_id > 0
                    && !i.qty.text().trim().is_empty()
                    && !i.unit_cost_yuan.text().trim().is_empty()
            })
            .collect();

        if items.is_empty() {
            bail!("一样都没填。要是现在不想录，点「跳过」就行");
        }

        let biz_date = match &input.biz_date {
            Some(d) => d.clone(),
            None => reports::today(conn)?,
        };

        let r = purchases::receive(
            conn,
            &purchases::ReceiveInput {
                biz_date,
                supplier_id: None,
                paid_yuan: None,
                note: Some("期初库存".to_string()),
                items,
            },
        )?;

        // 录了就不算跳过了
        onboarding::skip_opening_stock(conn, false)?;

        Ok(json!({
            "purchaseId": r.purchase_id,
            "total": cents_to_yuan(r.total_cents),
            "warnings": r.warnings,
        }))
    })
}

// ═══════════════════════ 备份 ═══════════════════════
// 备份状态常驻在顶栏，超过 3 天没成功备份就标红 ——
// 静默失败的备份等于没有备份（docs/03）

#[tauri::command]
pub fn backup_status(state: State<'_, AppState>) -> Result<Value> {
    let dir = state.root.backup_dir();
    let status = backup::backup_status(&dir)?;
    let files: Vec<_> = backup::list_backups(&dir)?.into_iter().take(10).collect();

    let mut v = serde_json::to_value(status)?;
    v.as_object_mut()
        .expect("备份状态是个对象")
        .insert("files".into(), serde_json::to_value(files)?);
    Ok(v)
}

#[tauri::command]
pub fn backup_now(state: State<'_, AppState>) -> Result<Value> {
    let dir = state.root.backup_dir();
    let r = state.with(|conn| Ok(backup::run_backup(conn, &dir)))?;
    if !r.ok {
        return Err(AppError::new(
            r.error.unwrap_or_else(|| "备份失败".to_string()),
        ));
    }
    Ok(json!({ "file": r.file, "sizeBytes": r.size_bytes }))
}

#[tauri::command]
pub fn backup_drives() -> Result<Value> {
    Ok(json!({ "drives": backup::removable_drives() }))
}

#[tauri::command]
pub fn backup_to_usb(state: State<'_, AppState>, drive: Option<String>) -> Result<Value> {
    let Some(drive) = drive.filter(|d| !d.trim().is_empty()) else {
        bail!("先选一个盘符");
    };
    let r = backup::copy_latest_to_usb(&state.root.backup_dir(), &drive)?;
    if !r.ok {
        return Err(AppError::new(
            r.error.unwrap_or_else(|| "复制失败".to_string()),
        ));
    }
    Ok(json!({ "target": r.target }))
}

// ═══════════════════════ Excel 导出 ═══════════════════════
//
// HTTP 时代这里是五个下载链接，浏览器存进「下载」文件夹了事。
// 现在改成系统的保存对话框：老板自己选存哪儿，文件名也看得见 ——
// 一份要发给会计的表，存完找不着才是真问题。
//
// 这几个命令声明成 async 是必须的：同步命令跑在主线程上，
// 在主线程里弹阻塞对话框会把界面锁死。

fn save_export(app: &AppHandle, export: excel::Export) -> Result<Value> {
    let picked = app
        .dialog()
        .file()
        .set_file_name(&export.filename)
        .add_filter("Excel 表格", &["xlsx"])
        .blocking_save_file();

    // 老板点了取消 —— 这不是错误，别弹红框
    let Some(path) = picked else {
        return Ok(json!({ "saved": false, "path": null }));
    };

    let path = path
        .into_path()
        .map_err(|e| AppError::new(format!("这个位置存不了：{e}")))?;
    std::fs::write(&path, &export.bytes)?;

    Ok(json!({ "saved": true, "path": path.to_string_lossy() }))
}

#[tauri::command]
pub async fn export_sales(
    app: AppHandle,
    state: State<'_, AppState>,
    month: Option<String>,
) -> Result<Value> {
    let export = state.with(|conn| excel::export_sales(conn, month.as_deref()))?;
    save_export(&app, export)
}

#[tauri::command]
pub async fn export_ranking(
    app: AppHandle,
    state: State<'_, AppState>,
    month: Option<String>,
) -> Result<Value> {
    let export = state.with(|conn| excel::export_ranking(conn, month.as_deref()))?;
    save_export(&app, export)
}

#[tauri::command]
pub async fn export_stale(app: AppHandle, state: State<'_, AppState>) -> Result<Value> {
    let export = state.with(|conn| excel::export_stale(conn, 90))?;
    save_export(&app, export)
}

#[tauri::command]
pub async fn export_debts(app: AppHandle, state: State<'_, AppState>) -> Result<Value> {
    let export = state.with(|conn| excel::export_debts(conn))?;
    save_export(&app, export)
}

#[tauri::command]
pub async fn export_products(app: AppHandle, state: State<'_, AppState>) -> Result<Value> {
    let export = state.with(|conn| excel::export_products(conn))?;
    save_export(&app, export)
}

// ═══════════════════════ 自检 ═══════════════════════

/// 顶栏用来确认「后台还活着」。HTTP 时代它是 `/health`。
#[tauri::command]
pub fn health(state: State<'_, AppState>) -> Result<Value> {
    state.with(|conn: &Connection| {
        let sqlite: String = conn.query_row("SELECT sqlite_version()", [], |r| r.get(0))?;
        let tables: i64 = conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'table'",
            [],
            |r| r.get(0),
        )?;
        Ok(json!({
            "ok": true,
            "sqlite": sqlite,
            "tables": tables,
            "dataDir": state.root.dir.to_string_lossy(),
            "dataDirNote": state.root.kind.label(),
        }))
    })
}
