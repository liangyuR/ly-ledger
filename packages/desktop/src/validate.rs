//! 入参防线。
//!
//! Zod 换成了 serde —— serde 管形状（少一个字段、类型不对直接 deserialize 失败），
//! 这里管业务约束（日期格式、非空、正负）。
//!
//! 报错一律给人话，不给字段路径。

use crate::error::Result;
use crate::{bail, ensure};

/// YYYY-MM-DD。只认这一种写法，不做智能解析 ——
/// 「2026/9/5」和「9-5」猜得出来，但猜错一次就是一笔账记到了别的月份。
pub fn check_biz_date(s: &str) -> Result<()> {
    let ok = s.len() == 10
        && s.as_bytes()[4] == b'-'
        && s.as_bytes()[7] == b'-'
        && s.bytes()
            .enumerate()
            .all(|(i, b)| if i == 4 || i == 7 { b == b'-' } else { b.is_ascii_digit() });

    if !ok {
        bail!("业务日期格式应为 YYYY-MM-DD，收到：{s}");
    }

    // 形状对了还要是真日期 —— 2026-02-30 长得没问题
    if chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_err() {
        bail!("没有这一天：{s}");
    }
    Ok(())
}

pub fn check_items_not_empty(len: usize) -> Result<()> {
    ensure!(len > 0, "至少要有一个商品");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 合法日期() {
        assert!(check_biz_date("2026-09-19").is_ok());
        assert!(check_biz_date("2024-02-29").is_ok(), "2024 是闰年");
    }

    #[test]
    fn 不认其他写法() {
        assert!(check_biz_date("2026/09/19").is_err());
        assert!(check_biz_date("2026-9-5").is_err());
        assert!(check_biz_date("").is_err());
        assert!(check_biz_date("今天").is_err());
    }

    #[test]
    fn 形状对但日子不存在() {
        assert!(check_biz_date("2026-02-30").is_err());
        assert!(check_biz_date("2026-02-29").is_err(), "2026 不是闰年");
        assert!(check_biz_date("2026-13-01").is_err());
    }
}
