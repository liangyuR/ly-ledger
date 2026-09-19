//! 启用向导。
//!
//! 完成标准是**卖出第一笔**，不是「把表填完」（docs/04）。前三步都能跳过，
//! 第四步做不到就说明这软件在这家店里根本跑不起来 —— 那才是要暴露的问题。
//!
//! 进度一律现算，不落库。理由见 002_settings.sql：存进度就有了第二份真相，
//! 老板绕开向导自己把事做了，清单还在催他，比不做向导更糟。

use rusqlite::Connection;

use crate::error::Result;
use crate::services::settings::{get_flag, set_flag};

pub const DISMISSED: &str = "onboarding.dismissed";
pub const STOCK_SKIPPED: &str = "onboarding.openingStockSkipped";

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub key: &'static str,
    pub title: &'static str,
    /// 做完了没有
    pub done: bool,
    /// 老板主动跳过的（只有期初库存能跳）
    pub skipped: bool,
    /// 可跳过
    pub optional: bool,
    /// 现状的一句话，比如「43 个商品」
    pub detail: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnboardingState {
    /// 全部走完（或该跳的都跳了）—— 清单不再出现
    pub complete: bool,
    /// 老板主动关掉了清单
    pub dismissed: bool,
    /// 一次都没卖过 —— 决定进不进全屏向导
    pub fresh: bool,
    pub steps: Vec<Step>,
    pub done_count: usize,
}

fn count(conn: &Connection, sql: &str) -> Result<i64> {
    Ok(conn.query_row(sql, [], |r| r.get(0))?)
}

pub fn onboarding_state(conn: &Connection) -> Result<OnboardingState> {
    let products = count(conn, "SELECT COUNT(*) FROM products")?;
    let priced = count(
        conn,
        "SELECT COUNT(*) FROM products
          WHERE price_base_cents IS NOT NULL OR price_pack_cents IS NOT NULL",
    )?;
    let purchases = count(conn, "SELECT COUNT(*) FROM purchases WHERE voided_at IS NULL")?;
    let sales = count(
        conn,
        "SELECT COUNT(*) FROM sales WHERE voided_at IS NULL AND return_of_sale_id IS NULL",
    )?;

    let stock_skipped = get_flag(conn, STOCK_SKIPPED)?;

    let steps = vec![
        Step {
            key: "products",
            title: "把你卖的牌子勾进来",
            done: products > 0,
            skipped: false,
            optional: false,
            detail: if products > 0 {
                format!("已经有 {products} 个商品")
            } else {
                "一个商品都还没有".to_string()
            },
        },
        Step {
            key: "prices",
            title: "给常卖的几样填个售价",
            done: priced > 0,
            skipped: false,
            optional: false,
            detail: if priced > 0 {
                format!("{priced} 个填了价")
            } else {
                "还没填过价".to_string()
            },
        },
        Step {
            key: "stock",
            title: "录现在货架上的库存",
            done: purchases > 0,
            skipped: stock_skipped && purchases == 0,
            optional: true,
            detail: if purchases > 0 {
                "已经有进货记录".to_string()
            } else if stock_skipped {
                "跳过了 —— 下次进货时会自动校正".to_string()
            } else {
                "不录也能用，但头几周毛利会偏高".to_string()
            },
        },
        Step {
            key: "firstSale",
            title: "卖出第一笔",
            done: sales > 0,
            skipped: false,
            optional: false,
            detail: if sales > 0 {
                "卖过了，装好了".to_string()
            } else {
                "这一步做完才算装好".to_string()
            },
        },
    ];

    Ok(OnboardingState {
        complete: steps.iter().all(|s| s.done || s.skipped),
        dismissed: get_flag(conn, DISMISSED)?,
        fresh: sales == 0 && products == 0,
        done_count: steps.iter().filter(|s| s.done).count(),
        steps,
    })
}

/// 老板说「不用了，关掉」
pub fn dismiss_onboarding(conn: &Connection, on: bool) -> Result<()> {
    set_flag(conn, DISMISSED, on)
}

/// 期初库存那一步选了跳过
pub fn skip_opening_stock(conn: &Connection, on: bool) -> Result<()> {
    set_flag(conn, STOCK_SKIPPED, on)
}
