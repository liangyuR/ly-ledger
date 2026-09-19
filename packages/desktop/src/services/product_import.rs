//! 商品批量导入 —— 手工清单。
//!
//! 三条硬要求（docs/04）：
//!   1. 单行看不懂不能让整批失败。失败行标出来，允许改完再导
//!   2. 同名商品跳过，不重复建。可以反复导，导错了再导一遍就行
//!   3. 价格不在这里填。导完去商品页批量填，两件事不要混在一屏

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::Result;
use crate::services::pinyin::to_pinyin;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedRow {
    /// 原文，让老板能对上是哪一行
    pub raw: String,
    pub ok: bool,
    /// 解析失败的原因，人话
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_unit: Option<String>,
    pub pack_unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pack_ratio: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinyin_full: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinyin_abbr: Option<String>,
    /// 库里已经有同名商品
    pub exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub existing_id: Option<i64>,
}

impl ParsedRow {
    fn bad(raw: &str, reason: &str) -> Self {
        ParsedRow {
            raw: raw.to_string(),
            ok: false,
            reason: Some(reason.to_string()),
            name: None,
            base_unit: None,
            pack_unit: None,
            pack_ratio: None,
            pinyin_full: None,
            pinyin_abbr: None,
            exists: false,
            existing_id: None,
        }
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseSummary {
    pub create: usize,
    pub skip: usize,
    pub invalid: usize,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseResult {
    pub rows: Vec<ParsedRow>,
    pub summary: ParseSummary,
}

/// 分隔符：半角/全角连字符、破折号都认。
/// 老板从微信里粘过来的清单什么破折号都有，认死一个半角 `-` 会让一半的行报错。
const SEPARATORS: [char; 4] = ['-', '–', '—', '－'];

/// 「单包」「单瓶」→「包」「瓶」
fn strip_single(u: &str) -> String {
    u.trim().strip_prefix('单').unwrap_or(u.trim()).trim().to_string()
}

/// 「10包」→ (10, "包")
fn parse_ratio(text: &str) -> Option<(i64, String)> {
    let t = text.trim();
    let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return None;
    }
    let unit = t[digits.len()..].trim().to_string();
    let ratio: i64 = digits.parse().ok()?;
    if ratio < 1 || unit.is_empty() {
        return None;
    }
    Some((ratio, unit))
}

fn parse_line(raw: &str) -> ParsedRow {
    let line = raw.trim();
    if line.is_empty() {
        return ParsedRow::bad(raw, "空行");
    }

    let parts: Vec<String> = line
        .split(|c| SEPARATORS.contains(&c))
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
        .collect();

    if parts.len() < 2 {
        return ParsedRow::bad(
            raw,
            "看不懂，缺少单位。写成「中华(硬) - 单包」或「中华(硬) - 条 - 10包」",
        );
    }
    if parts.len() > 3 {
        return ParsedRow::bad(raw, "分段太多，最多「名称 - 大单位 - 换算」三段");
    }

    let name = parts[0].trim().to_string();
    if name.is_empty() {
        return ParsedRow::bad(raw, "商品名为空");
    }

    let py = to_pinyin(&name);

    // 两段：名称 - 单位
    if parts.len() == 2 {
        let unit = strip_single(&parts[1]);
        if unit.is_empty() {
            return ParsedRow::bad(raw, "单位为空");
        }
        return ParsedRow {
            raw: raw.to_string(),
            ok: true,
            reason: None,
            name: Some(name),
            base_unit: Some(unit),
            pack_unit: None,
            pack_ratio: Some(1),
            pinyin_full: Some(py.full),
            pinyin_abbr: Some(py.abbr),
            exists: false,
            existing_id: None,
        };
    }

    // 三段：名称 - 大单位 - N小单位
    let pack_unit = strip_single(&parts[1]);
    if pack_unit.is_empty() {
        return ParsedRow::bad(raw, "包装单位为空");
    }
    let Some((ratio, base_unit)) = parse_ratio(&parts[2]) else {
        return ParsedRow::bad(
            raw,
            &format!("换算看不懂：「{}」。应写成「10包」这样", parts[2]),
        );
    };

    ParsedRow {
        raw: raw.to_string(),
        ok: true,
        reason: None,
        name: Some(name),
        base_unit: Some(base_unit),
        pack_unit: Some(pack_unit),
        pack_ratio: Some(ratio),
        pinyin_full: Some(py.full),
        pinyin_abbr: Some(py.abbr),
        exists: false,
        existing_id: None,
    }
}

/// 解析清单，不落库。用于导入前预览。
pub fn parse_product_list(conn: &Connection, text: &str) -> Result<ParseResult> {
    // 同一批里重复的名字也算已存在，否则会撞唯一约束
    let mut seen: HashSet<String> = HashSet::new();
    let mut rows = Vec::new();

    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let mut row = parse_line(line);
        if let (true, Some(name)) = (row.ok, row.name.clone()) {
            let existing: Option<i64> = conn
                .query_row("SELECT id FROM products WHERE name = ?1", [&name], |r| {
                    r.get(0)
                })
                .optional()?;
            if let Some(id) = existing {
                row.exists = true;
                row.existing_id = Some(id);
            } else if !seen.insert(name) {
                row.exists = true;
            }
        }
        rows.push(row);
    }

    let summary = ParseSummary {
        create: rows.iter().filter(|r| r.ok && !r.exists).count(),
        skip: rows.iter().filter(|r| r.ok && r.exists).count(),
        invalid: rows.iter().filter(|r| !r.ok).count(),
    };

    Ok(ParseResult { rows, summary })
}

pub struct ImportResult {
    pub created: usize,
    pub skipped: usize,
    pub invalid: usize,
    /// 建出来的 id。出参里不暴露（跟 Node 版一致），留着是给调用方做后续动作的余地
    #[allow(dead_code)]
    pub product_ids: Vec<i64>,
}

/// 按解析结果落库。**幂等**：同名跳过，可以反复导。
///
/// 价格一律留空 —— 各店不同，导完在商品页批量填。
/// 调用方负责开事务。
pub fn import_product_list(conn: &Connection, text: &str, category: &str) -> Result<ImportResult> {
    let parsed = parse_product_list(conn, text)?;

    let mut product_ids = Vec::new();
    for row in &parsed.rows {
        if !row.ok || row.exists {
            continue;
        }
        conn.execute(
            "INSERT INTO products (name, pinyin_full, pinyin_abbr, category, base_unit, pack_unit, pack_ratio)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                row.name,
                row.pinyin_full.as_deref().unwrap_or(""),
                row.pinyin_abbr.as_deref().unwrap_or(""),
                category,
                row.base_unit,
                row.pack_unit,
                row.pack_ratio.unwrap_or(1),
            ],
        )?;
        product_ids.push(conn.last_insert_rowid());
    }

    Ok(ImportResult {
        created: product_ids.len(),
        skipped: parsed.summary.skip,
        invalid: parsed.summary.invalid,
        product_ids,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;

    #[test]
    fn 两段名称加单位() {
        let conn = open_memory().unwrap();
        let r = parse_product_list(&conn, "中华(硬) - 单包").unwrap();
        let row = &r.rows[0];
        assert!(row.ok);
        assert_eq!(row.name.as_deref(), Some("中华(硬)"));
        assert_eq!(row.base_unit.as_deref(), Some("包"), "「单包」的「单」要去掉");
        assert_eq!(row.pack_unit, None);
        assert_eq!(row.pack_ratio, Some(1));
    }

    #[test]
    fn 三段名称加大单位加换算() {
        let conn = open_memory().unwrap();
        let r = parse_product_list(&conn, "中华(硬) - 条 - 10包").unwrap();
        let row = &r.rows[0];
        assert!(row.ok);
        assert_eq!(row.base_unit.as_deref(), Some("包"));
        assert_eq!(row.pack_unit.as_deref(), Some("条"));
        assert_eq!(row.pack_ratio, Some(10));
    }

    #[test]
    fn 全角连字符和破折号都认() {
        let conn = open_memory().unwrap();
        for sep in ['-', '－', '–', '—'] {
            let r = parse_product_list(&conn, &format!("泸小二 {sep} 瓶")).unwrap();
            assert!(r.rows[0].ok, "分隔符 {sep} 应该能认");
        }
    }

    // 这条是整个导入功能能不能被用起来的关键
    #[test]
    fn 一行看不懂不影响其他行() {
        let conn = open_memory().unwrap();
        let text = "中华(硬) - 条 - 10包\n青岛啤酒 一箱24\n泸小二 - 瓶";
        let r = parse_product_list(&conn, text).unwrap();
        assert_eq!(r.summary.create, 2);
        assert_eq!(r.summary.invalid, 1);
        assert!(!r.rows[1].ok);
        assert!(r.rows[1].reason.as_deref().unwrap().contains("看不懂"));
        assert_eq!(
            r.rows[1].raw, "青岛啤酒 一箱24",
            "原文要留着，老板才知道改哪行"
        );
    }

    #[test]
    fn 换算写不对会给出人话提示() {
        let conn = open_memory().unwrap();
        let r = parse_product_list(&conn, "茅台 - 箱 - 六瓶").unwrap();
        assert!(!r.rows[0].ok);
        assert!(r.rows[0].reason.as_deref().unwrap().contains("换算看不懂"));
    }

    #[test]
    fn 同名商品标记为已存在不重复建() {
        let conn = open_memory().unwrap();
        conn.execute(
            "INSERT INTO products (name, category, base_unit) VALUES ('中华(硬)', 'cigarette', '包')",
            [],
        )
        .unwrap();

        let r = parse_product_list(&conn, "中华(硬) - 条 - 10包").unwrap();
        assert!(r.rows[0].ok);
        assert!(r.rows[0].exists);
        assert_eq!(r.summary.skip, 1);
        assert_eq!(r.summary.create, 0);
    }

    #[test]
    fn 同一批里重复的名字也只建一次() {
        let conn = open_memory().unwrap();
        let r = parse_product_list(&conn, "泸小二 - 瓶\n泸小二 - 瓶").unwrap();
        assert_eq!(r.summary.create, 1);
        assert_eq!(r.summary.skip, 1);
    }

    #[test]
    fn 同一个商品的两种卖法不会建成两个商品() {
        // 这两行说的是同一个商品的两种卖法，不是两个商品 ——
        // 建成两条会让库存裂成两份（docs/02）
        let conn = open_memory().unwrap();
        let r = parse_product_list(&conn, "中华(硬) - 条 - 10包\n中华(硬) - 单包").unwrap();
        assert_eq!(r.summary.create, 1);
        assert_eq!(r.summary.skip, 1);
    }

    #[test]
    fn 落库并自动生成拼音价格留空() {
        let conn = open_memory().unwrap();
        let r = import_product_list(&conn, "中华(硬) - 条 - 10包", "cigarette").unwrap();
        assert_eq!(r.created, 1);

        let (full, abbr, base, pack, ratio, price): (String, String, String, String, i64, Option<i64>) = conn
            .query_row(
                "SELECT pinyin_full, pinyin_abbr, base_unit, pack_unit, pack_ratio, price_base_cents
                   FROM products WHERE name = '中华(硬)'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .unwrap();

        assert_eq!(full, "zhonghuaying");
        assert_eq!(abbr, "zhy");
        assert_eq!(base, "包");
        assert_eq!(pack, "条");
        assert_eq!(ratio, 10);
        assert_eq!(price, None, "价格一律留空，各店不同");
    }

    #[test]
    fn 反复导入是幂等的() {
        let conn = open_memory().unwrap();
        let first = import_product_list(&conn, "泸小二 - 瓶", "liquor").unwrap();
        let again = import_product_list(&conn, "泸小二 - 瓶", "liquor").unwrap();
        assert_eq!(first.created, 1);
        assert_eq!(again.created, 0);
        assert_eq!(again.skipped, 1);
    }
}
