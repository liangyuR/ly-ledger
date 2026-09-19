//! 商品名 / 客户名 → 拼音，用于搜索。
//!
//! 全拼和首字母两个都要：只做首字母会逼老板记缩写，只做全拼则打字太多。
//! 这样 `mt` 和 `maotai` 都能命中「茅台飞天」。
//!
//! 多音字会有错（「长城」「重庆」这类），所以两个字段都允许手工修正 —— 见 docs/02。

use pinyin::ToPinyin;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pinyin {
    pub full: String,
    pub abbr: String,
}

/// 只留字母数字。商品名里的括号、空格、中点不该进拼音索引。
///
/// 非汉字原样保留再过滤 —— 「555」「M6」这类牌子名全靠这一条，
/// 丢掉数字它们就搜不到了。
fn keep_alnum(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

pub fn to_pinyin(name: &str) -> Pinyin {
    let text = name.trim();
    if text.is_empty() {
        return Pinyin {
            full: String::new(),
            abbr: String::new(),
        };
    }

    let mut full = String::new();
    let mut abbr = String::new();

    for (ch, py) in text.chars().zip(text.to_pinyin()) {
        match py {
            Some(py) => {
                full.push_str(py.plain());
                abbr.push_str(py.first_letter());
            }
            // 非汉字：原样带上，交给 keep_alnum 过滤
            None => {
                full.push(ch);
                abbr.push(ch);
            }
        }
    }

    Pinyin {
        full: keep_alnum(&full),
        abbr: keep_alnum(&abbr),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 全拼与首字母都能命中() {
        let p = to_pinyin("茅台飞天");
        assert_eq!(p.full, "maotaifeitian");
        assert_eq!(p.abbr, "mtft");
    }

    #[test]
    fn 括号空格中点不进索引() {
        let p = to_pinyin("中华(硬)");
        assert_eq!(p.full, "zhonghuaying");
        assert_eq!(p.abbr, "zhy");
    }

    #[test]
    fn 数字牌子名保住数字() {
        // 「555」「M6」这类：丢了数字就永远搜不到
        assert_eq!(to_pinyin("555").full, "555");
        assert_eq!(to_pinyin("利群(M6)").abbr, "lqm6");
    }

    #[test]
    fn 空名字不炸() {
        let p = to_pinyin("   ");
        assert_eq!(p.full, "");
        assert_eq!(p.abbr, "");
    }
}
