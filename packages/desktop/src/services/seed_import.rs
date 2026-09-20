//! 预置商品目录 —— 按品牌勾选导入。
//!
//! 这是这类软件最容易死掉的地方：一个烟酒店几百个 SKU，要求老板上线前
//! 先把商品库建全，他大概率录到第 50 个就放弃了（docs/01）。
//!
//! **绝不可全量导入。** 500 个 SKU 一股脑塞进去，搜 `zh` 会跳出一堆他
//! 根本不卖的牌子，搜索体验直接被污染。勾 15 个品牌导 60 个 SKU 刚好够用。
//!
//! 目录**编进二进制**。Node 版在四个候选路径里挨个找它，找不到就报错 ——
//! 那是只会在店主电脑上发生的故障。编进去之后这一整类问题不存在了。

use std::collections::HashSet;
use std::sync::OnceLock;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;

use crate::error::Result;
use crate::services::pinyin::to_pinyin;

const SEED_JSON: &str = include_str!("../../../../seed/products.sample.json");

#[derive(Debug, Deserialize)]
struct SeedProduct {
    name: String,
    brand: String,
    category: String,
    #[serde(default)]
    spec: Option<String>,
    #[serde(default)]
    pinyin_full: Option<String>,
    #[serde(default)]
    pinyin_abbr: Option<String>,
    base_unit: String,
    #[serde(default)]
    pack_unit: Option<String>,
    #[serde(default)]
    pack_ratio: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct SeedBrand {
    category: String,
    brand: String,
}

#[derive(Debug, Deserialize)]
struct SeedFile {
    brands: Vec<SeedBrand>,
    products: Vec<SeedProduct>,
}

fn seed() -> &'static SeedFile {
    static CACHE: OnceLock<SeedFile> = OnceLock::new();
    CACHE.get_or_init(|| {
        // 目录是编译期就在包里的常量，解析不了说明是发版时改坏了，
        // 那属于「装出去之前必须炸」的错误，不该让它悄悄退化成空目录。
        serde_json::from_str(SEED_JSON).expect("预置商品目录格式不对")
    })
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrandOption {
    pub brand: String,
    pub category: String,
    /// 目录里这个牌子有多少个商品
    pub total: usize,
    /// 其中已经在库里的有多少
    pub already_imported: usize,
}

/// 列出可勾选的品牌，供首次启用时选「你店里卖哪些牌子」。
pub fn list_seed_brands(conn: &Connection) -> Result<Vec<BrandOption>> {
    let existing: HashSet<String> = {
        let mut stmt = conn.prepare("SELECT name FROM products")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };

    let s = seed();
    Ok(s.brands
        .iter()
        .map(|b| {
            let items: Vec<&SeedProduct> =
                s.products.iter().filter(|p| p.brand == b.brand).collect();
            BrandOption {
                brand: b.brand.clone(),
                category: b.category.clone(),
                total: items.len(),
                already_imported: items.iter().filter(|p| existing.contains(&p.name)).count(),
            }
        })
        .collect())
}

pub struct SeedImportResult {
    pub created: usize,
    pub skipped: usize,
    /// 建出来的 id。出参里不暴露（跟 Node 版一致），留着是给调用方做后续动作的余地
    #[allow(dead_code)]
    pub product_ids: Vec<i64>,
}

/// 按勾选的品牌导入商品**骨架**，价格一律留空。
///
/// 名称、规格、拼音、条/包换算都是公开知识，可以预置；
/// 进价售价各店不同、外部无从知道，必须老板自己填（docs/01）。
///
/// 幂等：同名跳过，可重复调用。调用方负责开事务。
pub fn import_seed_brands(conn: &Connection, brands: &[String]) -> Result<SeedImportResult> {
    let wanted: HashSet<&str> = brands.iter().map(|s| s.as_str()).collect();
    let picked: Vec<&SeedProduct> = seed()
        .products
        .iter()
        .filter(|p| wanted.contains(p.brand.as_str()))
        .collect();

    if picked.is_empty() {
        return Ok(SeedImportResult {
            created: 0,
            skipped: 0,
            product_ids: Vec::new(),
        });
    }

    let mut product_ids = Vec::new();
    let mut skipped = 0;

    for p in picked {
        let existing: Option<i64> = conn
            .query_row("SELECT id FROM products WHERE name = ?1", [&p.name], |r| {
                r.get(0)
            })
            .optional()?;
        if existing.is_some() {
            skipped += 1;
            continue;
        }

        // 目录里带了拼音就用它（人工校过多音字），没带才现算
        let (full, abbr) = match (&p.pinyin_full, &p.pinyin_abbr) {
            (Some(f), Some(a)) if !f.is_empty() && !a.is_empty() => (f.clone(), a.clone()),
            _ => {
                let py = to_pinyin(&p.name);
                (py.full, py.abbr)
            }
        };

        conn.execute(
            "INSERT INTO products (name, pinyin_full, pinyin_abbr, category, brand, spec,
                                   base_unit, pack_unit, pack_ratio)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                p.name,
                full,
                abbr,
                p.category,
                p.brand,
                p.spec.as_deref().unwrap_or(""),
                p.base_unit,
                p.pack_unit,
                p.pack_ratio.unwrap_or(1),
            ],
        )?;
        product_ids.push(conn.last_insert_rowid());
    }

    Ok(SeedImportResult {
        created: product_ids.len(),
        skipped,
        product_ids,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;

    #[test]
    fn 编进二进制的目录能解析出来() {
        let s = seed();
        assert!(!s.brands.is_empty(), "品牌列表不该是空的");
        assert!(!s.products.is_empty(), "商品列表不该是空的");
    }

    #[test]
    fn 目录里每个商品的品牌都在品牌表里() {
        // 对不上的话，那个商品在勾选界面上永远出不来，等于白写
        let s = seed();
        let brands: HashSet<&str> = s.brands.iter().map(|b| b.brand.as_str()).collect();
        for p in &s.products {
            assert!(brands.contains(p.brand.as_str()), "品牌表里没有：{}", p.brand);
        }
    }

    #[test]
    fn 预置商品一律不带价格() {
        // 价格各店不同，外部无从知道。带了价就是在骗老板（docs/01）
        let raw: serde_json::Value = serde_json::from_str(SEED_JSON).unwrap();
        let products = raw["products"].as_array().unwrap();
        for p in products {
            assert!(p.get("price_base_cents").is_none(), "预置目录不该带价格");
            assert!(p.get("price_pack_cents").is_none(), "预置目录不该带价格");
        }
    }

    #[test]
    fn 按品牌勾选只导这个牌子() {
        let conn = open_memory().unwrap();
        let brand = seed().brands[0].brand.clone();
        let expect = seed().products.iter().filter(|p| p.brand == brand).count();

        let r = import_seed_brands(&conn, &[brand.clone()]).unwrap();
        assert_eq!(r.created, expect);

        let total: i64 = conn
            .query_row("SELECT COUNT(*) FROM products WHERE is_service = 0", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total as usize, expect, "别的牌子一个都不该进来");
    }

    #[test]
    fn 重复勾同一个牌子不会建重复商品() {
        let conn = open_memory().unwrap();
        let brand = seed().brands[0].brand.clone();
        let first = import_seed_brands(&conn, &[brand.clone()]).unwrap();
        let again = import_seed_brands(&conn, &[brand]).unwrap();
        assert_eq!(again.created, 0);
        assert_eq!(again.skipped, first.created);
    }

    #[test]
    fn 品牌选项会报出已导入了几个() {
        let conn = open_memory().unwrap();
        let brand = seed().brands[0].brand.clone();
        import_seed_brands(&conn, &[brand.clone()]).unwrap();

        let opts = list_seed_brands(&conn).unwrap();
        let hit = opts.iter().find(|o| o.brand == brand).unwrap();
        assert_eq!(hit.already_imported, hit.total);
    }
}
