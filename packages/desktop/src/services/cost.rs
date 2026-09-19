//! 移动加权平均成本 —— 纯函数，不碰数据库。
//!
//! 这是全系统**错了最难发现**的一段：算错不报错，只让毛利慢慢偏掉，
//! 老板要到月底才觉得数字不对，那时已无从追查。所以它必须是纯函数，
//! 并且有测试钉死每个分支（docs/03 测试策略）。
//!
//! 单位：数量 milli（千分之一），单价 e4（万分之一元）。

use crate::ensure;
use crate::error::Result;
use crate::money::div_round;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Stock {
    pub qty_milli: i64,
    pub avg_cost_e4: i64,
}

impl Stock {
    pub const EMPTY: Stock = Stock {
        qty_milli: 0,
        avg_cost_e4: 0,
    };
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct CostWarning {
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct CostResult {
    pub stock: Stock,
    pub warnings: Vec<CostWarning>,
}

impl CostResult {
    fn plain(qty_milli: i64, avg_cost_e4: i64) -> Self {
        CostResult {
            stock: Stock {
                qty_milli,
                avg_cost_e4,
            },
            warnings: Vec::new(),
        }
    }

    /// 只在测试里读。业务代码拿的是 `stock`，不拆开看
    #[allow(dead_code)]
    pub fn qty_milli(&self) -> i64 {
        self.stock.qty_milli
    }

    pub fn avg_cost_e4(&self) -> i64 {
        self.stock.avg_cost_e4
    }
}

/// 进货后的新结存与新均价。
///
/// **必须显式处理 old_qty <= 0 的分支。** 因为允许负库存（红线 1），
/// 标准加权公式在负库存上会算出负成本或除零。
pub fn apply_purchase(prev: Stock, in_qty_milli: i64, in_cost_e4: i64) -> Result<CostResult> {
    ensure!(in_qty_milli > 0, "进货数量必须为正，收到 {in_qty_milli}");
    ensure!(in_cost_e4 >= 0, "进价不能为负，收到 {in_cost_e4}");

    let new_qty = prev.qty_milli + in_qty_milli;

    // 进完仍为负或归零 —— 旧成本没有参考意义，直接用本次进价
    if new_qty <= 0 {
        return Ok(CostResult::plain(new_qty, in_cost_e4));
    }

    // 进货前是负库存或零库存 —— 旧均价无效，不能套加权公式
    if prev.qty_milli <= 0 {
        return Ok(CostResult::plain(new_qty, in_cost_e4));
    }

    let total = prev.qty_milli as i128 * prev.avg_cost_e4 as i128
        + in_qty_milli as i128 * in_cost_e4 as i128;
    Ok(CostResult::plain(
        new_qty,
        div_round(total, new_qty as i128)?,
    ))
}

/// 销售后的新结存。**均价不变。**
///
/// 库存变负后继续销售，仍沿用最后已知的均价估算毛利。这是有偏差的，
/// 但比拒绝记账好 —— 下次进货时成本会自动校正回来（红线 1）。
pub fn apply_sale(prev: Stock, out_qty_milli: i64) -> Result<CostResult> {
    ensure!(out_qty_milli > 0, "出库数量必须为正，收到 {out_qty_milli}");
    Ok(CostResult::plain(
        prev.qty_milli - out_qty_milli,
        prev.avg_cost_e4,
    ))
}

/// 作废一张进货单时的反向调整。
///
/// 只调整当前库存和均价，**不回溯修改任何历史成本快照** ——
/// 那会违反红线 3，让上个月已经看过的利润数字发生变化（docs/05）。
pub fn reverse_purchase(prev: Stock, void_qty_milli: i64, void_cost_e4: i64) -> Result<CostResult> {
    ensure!(void_qty_milli > 0, "作废数量必须为正，收到 {void_qty_milli}");

    let new_qty = prev.qty_milli - void_qty_milli;

    if new_qty <= 0 {
        // 无从推算，保持原均价
        return Ok(CostResult::plain(new_qty, prev.avg_cost_e4));
    }

    let total = prev.qty_milli as i128 * prev.avg_cost_e4 as i128
        - void_qty_milli as i128 * void_cost_e4 as i128;
    let avg = div_round(total, new_qty as i128)?;

    // 真实可能发生：作废的是一笔高价进货，而此后又进了大量低价货把均价拉低，
    // 反算就会得到负数。必须 clamp 并告警 —— 否则后续毛利全错且无人察觉。
    if avg < 0 {
        return Ok(CostResult {
            stock: Stock {
                qty_milli: new_qty,
                avg_cost_e4: 0,
            },
            warnings: vec![CostWarning {
                code: "negative_avg_clamped",
                message: format!(
                    "作废进货后反算出负成本（{avg}），已归零。\
                     此后该商品的毛利会偏高，直到下次进货把均价拉回合理区间。"
                ),
            }],
        });
    }

    Ok(CostResult::plain(new_qty, avg))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::money::{qty_to_milli, yuan_to_e4, Decimalish};

    fn q(s: &str) -> i64 {
        qty_to_milli(&Decimalish::from(s)).unwrap()
    }
    fn e4(s: &str) -> i64 {
        yuan_to_e4(&Decimalish::from(s)).unwrap()
    }
    fn stock(qty: &str, cost: &str) -> Stock {
        Stock {
            qty_milli: q(qty),
            avg_cost_e4: e4(cost),
        }
    }

    // ── 移动加权平均成本 ─────────────────────────────────────
    #[test]
    fn 正常进货加权() {
        // (10×50 + 10×60) / 20 = 55
        let r = apply_purchase(stock("10", "50"), q("10"), e4("60")).unwrap();
        assert_eq!(r.qty_milli(), q("20"));
        assert_eq!(r.avg_cost_e4(), e4("55"));
    }

    #[test]
    fn 零库存进货新均价等于进价而不是除零() {
        let r = apply_purchase(stock("0", "99"), q("10"), e4("60")).unwrap();
        assert_eq!(r.avg_cost_e4(), e4("60"));
    }

    #[test]
    fn 负库存进货不套加权公式() {
        // 若套公式：(-5×50 + 10×60) / 5 = 70，凭空多出 10 块成本
        let r = apply_purchase(stock("-5", "50"), q("10"), e4("60")).unwrap();
        assert_eq!(r.qty_milli(), q("5"));
        assert_eq!(r.avg_cost_e4(), e4("60"));
    }

    #[test]
    fn 进完仍为负新均价等于进价() {
        let r = apply_purchase(stock("-20", "50"), q("10"), e4("60")).unwrap();
        assert_eq!(r.qty_milli(), q("-10"));
        assert_eq!(r.avg_cost_e4(), e4("60"));
    }

    #[test]
    fn 整条价550拆10包等于55无精度丢失() {
        let per_pack = e4("550") / 10;
        assert_eq!(per_pack, e4("55"));
        let r = apply_purchase(stock("0", "0"), q("10"), per_pack).unwrap();
        assert_eq!(r.avg_cost_e4(), e4("55.0000"));
    }

    #[test]
    fn 整箱333拆6瓶等于555四位小数的必要性() {
        let per_bottle = e4("333") / 6;
        assert_eq!(per_bottle, e4("55.5"));
        // 两位小数会变成 55.50，这里精确到 55.5000
        assert_eq!(per_bottle, 555000);
    }

    #[test]
    fn 销售时均价不变结存可以变负() {
        let r = apply_sale(stock("2", "55"), q("5")).unwrap();
        assert_eq!(r.qty_milli(), q("-3"));
        assert_eq!(r.avg_cost_e4(), e4("55"), "负库存下仍沿用最后已知均价");
    }

    #[test]
    fn 加权结果除不尽时四舍五入到e4() {
        // (1×10 + 2×20) / 3 = 16.666666...
        let r = apply_purchase(stock("1", "10"), q("2"), e4("20")).unwrap();
        assert_eq!(r.avg_cost_e4(), 166667); // 16.6667
    }

    #[test]
    fn 中间量超过安全整数范围也不出错() {
        // 10 万件 × 单价 9999 元：中间量 ≈ 10^8 × 10^8 = 10^16，i64 乘法会溢出
        let big = apply_purchase(
            Stock {
                qty_milli: q("100000"),
                avg_cost_e4: e4("9999"),
            },
            q("100000"),
            e4("9999"),
        )
        .unwrap();
        assert_eq!(big.avg_cost_e4(), e4("9999"));
    }

    // ── 作废进货的反向调整 ───────────────────────────────────
    #[test]
    fn 撤回刚进的那批均价回到原值() {
        let after = apply_purchase(stock("10", "50"), q("10"), e4("60")).unwrap();
        let back = reverse_purchase(after.stock, q("10"), e4("60")).unwrap();
        assert_eq!(back.qty_milli(), q("10"));
        assert_eq!(back.avg_cost_e4(), e4("50"));
    }

    #[test]
    fn 作废后结存归零或转负保持原均价() {
        let r = reverse_purchase(stock("10", "55"), q("10"), e4("55")).unwrap();
        assert_eq!(r.qty_milli(), 0);
        assert_eq!(r.avg_cost_e4(), e4("55"));
    }

    #[test]
    fn 反算出负成本时归零并告警() {
        // 均价被后续低价货拉到 5，此时去撤一笔 100 块的高价进货：
        // (100×5 − 10×100) / 90 = −5.55...，真的会算出负成本
        let r = reverse_purchase(stock("100", "5"), q("10"), e4("100")).unwrap();
        assert_eq!(r.avg_cost_e4(), 0, "绝不写入负成本");
        assert_eq!(r.warnings.len(), 1);
        assert_eq!(r.warnings[0].code, "negative_avg_clamped");
    }

    // ── 入参防线 ─────────────────────────────────────────────
    #[test]
    fn 进货数量为零或负数直接拒绝() {
        assert!(apply_purchase(stock("1", "1"), 0, 100).is_err());
        assert!(apply_purchase(stock("1", "1"), -1000, 100).is_err());
    }

    #[test]
    fn 进价为负直接拒绝() {
        assert!(apply_purchase(stock("1", "1"), 1000, -1).is_err());
    }

    #[test]
    fn 出库数量为零或负数直接拒绝() {
        assert!(apply_sale(stock("1", "1"), 0).is_err());
    }
}
