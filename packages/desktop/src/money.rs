//! 金额与数量的单位换算。
//!
//! 全系统只有两个地方允许在「人看的小数」和「库里的整数」之间转换：
//! 入参解析时，和出参格式化时。中间一律整数 —— 见 docs/02 单位约定。
//!
//!   分        _cents  1 元 = 100
//!   万分之一元 _e4     1 元 = 10000
//!   千分之一   _milli  1 包 = 1000
//!
//! 与 TS 版的一处刻意保留：**结果仍按 JS 安全整数范围校验**（2^53-1）。
//! Rust 这边 i64 装得下更大的数，但这些值要经 JSON 回到前端，越过 2^53
//! 就会在 JS 里悄悄失真。宁可在这里报错，也不要在界面上显示一个错的数。

use crate::bail;
use crate::error::{AppError, Result};

/// JS 的 Number.MAX_SAFE_INTEGER。
const MAX_SAFE: i64 = 9_007_199_254_740_991;

/// 入参里的「数」：前端可能传 "55.50"，也可能传 55.5。两种都收。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(untagged)]
pub enum Decimalish {
    Str(String),
    Num(serde_json::Number),
}

impl Decimalish {
    pub fn text(&self) -> String {
        match self {
            Decimalish::Str(s) => s.clone(),
            Decimalish::Num(n) => n.to_string(),
        }
    }
}

impl From<&str> for Decimalish {
    fn from(s: &str) -> Self {
        Decimalish::Str(s.to_string())
    }
}

/// 解析十进制字符串为放大 10^scale 倍的整数，不经过浮点。
fn parse_decimal(input: &Decimalish, scale: u32, label: &str) -> Result<i64> {
    let raw = input.text();
    let text = raw.trim();

    // 等价于 /^-?\d+(\.\d+)?$/，手写是为了不多拖一个正则依赖
    let body = text.strip_prefix('-').unwrap_or(text);
    let mut parts = body.splitn(2, '.');
    let int_part = parts.next().unwrap_or("");
    let frac_part = parts.next().unwrap_or("");
    let shaped = !int_part.is_empty()
        && int_part.bytes().all(|b| b.is_ascii_digit())
        && (!body.contains('.') || (!frac_part.is_empty() && frac_part.bytes().all(|b| b.is_ascii_digit())));

    if !shaped {
        bail!("{label} 不是合法数字：{text:?}");
    }

    let scale = scale as usize;
    if frac_part.len() > scale {
        bail!(
            "{label} 的小数位超出精度：{text}，最多 {scale} 位。\
             不做静默截断 —— 悄悄丢掉的那一位迟早变成对不上的账。"
        );
    }

    let mut digits = String::with_capacity(int_part.len() + scale);
    digits.push_str(int_part);
    digits.push_str(frac_part);
    for _ in frac_part.len()..scale {
        digits.push('0');
    }

    let value: i64 = digits
        .parse()
        .map_err(|_| AppError::new(format!("{label} 超出安全整数范围：{text}")))?;
    if value > MAX_SAFE {
        bail!("{label} 超出安全整数范围：{text}");
    }

    Ok(if text.starts_with('-') { -value } else { value })
}

/// 格式化放大 10^scale 倍的整数为十进制字符串。
fn format_decimal(value: i64, scale: usize, trim_trailing_zeros: bool) -> String {
    let negative = value < 0;
    let digits = format!("{:0>width$}", value.unsigned_abs(), width = scale + 1);
    let split = digits.len() - scale;
    let int_part = &digits[..split];
    let mut frac_part = &digits[split..];

    if trim_trailing_zeros {
        frac_part = frac_part.trim_end_matches('0');
    }

    let body = if frac_part.is_empty() {
        int_part.to_string()
    } else {
        format!("{int_part}.{frac_part}")
    };

    if negative {
        format!("-{body}")
    } else {
        body
    }
}

// ── 金额：元 ↔ 分 ────────────────────────────────────────────
pub fn yuan_to_cents(v: &Decimalish) -> Result<i64> {
    parse_decimal(v, 2, "金额")
}
pub fn cents_to_yuan(v: i64) -> String {
    format_decimal(v, 2, false)
}

// ── 单位成本：元 ↔ 万分之一元 ─────────────────────────────────
pub fn yuan_to_e4(v: &Decimalish) -> Result<i64> {
    parse_decimal(v, 4, "单位成本")
}
pub fn e4_to_yuan(v: i64) -> String {
    format_decimal(v, 4, false)
}

// ── 数量：个 ↔ 千分之一 ───────────────────────────────────────
pub fn qty_to_milli(v: &Decimalish) -> Result<i64> {
    parse_decimal(v, 3, "数量")
}
pub fn milli_to_qty(v: i64) -> String {
    format_decimal(v, 3, true)
}

/// 千分比 → 一位小数的百分比字符串。等价于 JS 的 `(x / 10).toFixed(1)`。
///
/// 负数要单独拎出来：Rust 的整数除法向零截断，-5 / 10 得 0，
/// 直接拼字符串会把 -0.5% 印成 0.5% —— 一个亏本的商品显示成赚钱的。
pub fn permille_to_percent(permille: i64) -> String {
    let sign = if permille < 0 { "-" } else { "" };
    let abs = permille.abs();
    format!("{sign}{}.{}", abs / 10, abs % 10)
}

/// 四舍五入的整数除法，零远离（-0.5 → -1，0.5 → 1）。
///
/// 中间量收 i128：加权成本的被除数是 数量(milli) × 单价(e4)，量级到 10^17，
/// i64 乘法在这里会溢出。溢出不报错，只让成本悄悄偏掉 —— 那是最难查的一类错。
pub fn div_round(numerator: i128, denominator: i128) -> Result<i64> {
    if denominator == 0 {
        bail!("除数为零");
    }

    let negative = (numerator < 0) != (denominator < 0);
    let a = numerator.unsigned_abs();
    let b = denominator.unsigned_abs();

    let quotient = a / b;
    let remainder = a % b;
    let rounded = if remainder * 2 >= b { quotient + 1 } else { quotient };

    let signed = if negative {
        -(rounded as i128)
    } else {
        rounded as i128
    };

    if signed > MAX_SAFE as i128 || signed < -(MAX_SAFE as i128) {
        bail!("计算结果超出安全整数范围：{rounded}");
    }
    Ok(signed as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> Decimalish {
        Decimalish::Str(s.to_string())
    }

    // ── 元 ↔ 分 ──────────────────────────────────────────────
    #[test]
    fn 常见写法都能解析() {
        assert_eq!(yuan_to_cents(&d("55")).unwrap(), 5500);
        assert_eq!(yuan_to_cents(&d("55.5")).unwrap(), 5550);
        assert_eq!(yuan_to_cents(&d("55.55")).unwrap(), 5555);
        assert_eq!(yuan_to_cents(&d("0.01")).unwrap(), 1);
        assert_eq!(yuan_to_cents(&d("-30")).unwrap(), -3000);
    }

    #[test]
    fn 不经过浮点所以没有小数累积误差() {
        // JS 里 Number('1.15') * 100 === 114.99999999999999
        assert_eq!(yuan_to_cents(&d("1.15")).unwrap(), 115);
        assert_eq!(yuan_to_cents(&d("8.35")).unwrap(), 835);
        assert_eq!(yuan_to_cents(&d("1234567.89")).unwrap(), 123456789);
    }

    #[test]
    fn 超出精度直接报错不静默截断() {
        let err = yuan_to_cents(&d("55.555")).unwrap_err().to_string();
        assert!(err.contains("小数位超出精度"), "{err}");
    }

    #[test]
    fn 非法输入直接报错() {
        assert!(yuan_to_cents(&d("abc")).is_err());
        assert!(yuan_to_cents(&d("")).is_err());
        assert!(yuan_to_cents(&d("1,000")).is_err());
        assert!(yuan_to_cents(&d("55.")).is_err());
        assert!(yuan_to_cents(&d(".5")).is_err());
    }

    #[test]
    fn 格式化保留两位() {
        assert_eq!(cents_to_yuan(5500), "55.00");
        assert_eq!(cents_to_yuan(1), "0.01");
        assert_eq!(cents_to_yuan(0), "0.00");
        assert_eq!(cents_to_yuan(-3000), "-30.00");
    }

    // ── 元 ↔ 万分之一元 ──────────────────────────────────────
    #[test]
    fn 四位小数() {
        assert_eq!(yuan_to_e4(&d("55")).unwrap(), 550000);
        assert_eq!(yuan_to_e4(&d("55.5")).unwrap(), 555000);
        assert_eq!(yuan_to_e4(&d("55.5555")).unwrap(), 555555);
        assert_eq!(e4_to_yuan(555000), "55.5000");
    }

    #[test]
    fn 五位小数报错() {
        assert!(yuan_to_e4(&d("55.55555")).is_err());
    }

    // ── 数量 ↔ 千分之一 ──────────────────────────────────────
    #[test]
    fn 整数数量与小数数量() {
        assert_eq!(qty_to_milli(&d("10")).unwrap(), 10000);
        assert_eq!(qty_to_milli(&d("0.5")).unwrap(), 500);
        assert_eq!(milli_to_qty(10000), "10");
        assert_eq!(milli_to_qty(10500), "10.5");
    }

    #[test]
    fn 数字形态的入参等价于字符串() {
        let n = Decimalish::Num(serde_json::Number::from_f64(55.5).unwrap());
        assert_eq!(yuan_to_cents(&n).unwrap(), 5550);
        let i = Decimalish::Num(serde_json::Number::from(10));
        assert_eq!(qty_to_milli(&i).unwrap(), 10000);
    }

    #[test]
    fn 千分比转百分比带符号() {
        assert_eq!(permille_to_percent(125), "12.5");
        assert_eq!(permille_to_percent(0), "0.0");
        assert_eq!(permille_to_percent(-125), "-12.5");
        // 向零截断会把这个印成 0.5 —— 亏本商品显示成赚钱的
        assert_eq!(permille_to_percent(-5), "-0.5");
    }

    // ── 四舍五入整数除法 ──────────────────────────────────────
    #[test]
    fn 常规进位与舍去() {
        assert_eq!(div_round(10, 3).unwrap(), 3);
        assert_eq!(div_round(11, 3).unwrap(), 4);
        assert_eq!(div_round(5, 2).unwrap(), 3, ".5 进位");
        assert_eq!(div_round(4, 2).unwrap(), 2);
    }

    #[test]
    fn 负数零远离() {
        assert_eq!(div_round(-5, 2).unwrap(), -3);
        assert_eq!(div_round(5, -2).unwrap(), -3);
        assert_eq!(div_round(-4, -2).unwrap(), 2);
    }

    #[test]
    fn 超过安全整数的中间量() {
        // 10^17 / 10^3 = 10^14，结果安全但中间量不安全
        assert_eq!(div_round(100_000_000_000_000_000, 1000).unwrap(), 100_000_000_000_000);
    }

    #[test]
    fn 结果超出安全范围时报错而不是静默失真() {
        let err = div_round(10i128.pow(20), 1).unwrap_err().to_string();
        assert!(err.contains("超出安全整数范围"), "{err}");
    }

    #[test]
    fn 除零报错() {
        let err = div_round(1, 0).unwrap_err().to_string();
        assert!(err.contains("除数为零"), "{err}");
    }
}
