//! 商品表回导 —— 导出的那张 Excel 改完再导回来。
//!
//! 界面上写着「导出的商品表同时就是导入模板」（docs/04）。这个模块让那句话成立：
//! 导出、在 Excel 里加几行新商品、把价格填完、顺手改个品牌规格，再导回来。
//! 几十个商品逐个点格子填价没人填得完，而填了一半的价格表比没填更糟 ——
//! 毛利照样算，只是算出来是错的。
//!
//! **三件事这张表改不了，改了也不生效：**
//!
//! 1. **已经有账的商品的单位和换算**。库存流水存的是「基础单位数量」：
//!    把「1 条 = 10 包」改成 20，历史上每一笔的数量含义当场全变，且不报错。
//!    没有任何进货销售记录的商品可以随便改 —— 那时候改还来得及。
//! 2. **当前库存、加权成本**。它们是从流水算出来的结果，不是可以填的输入。
//!    要改库存得去进货页（docs/02）。
//! 3. **删行**。表里少一行不等于要停用那个商品 —— 多半只是他筛选后另存了一份。

use std::collections::HashMap;
use std::path::Path;

use calamine::{open_workbook_auto, Data, Reader};
use rusqlite::Connection;

use crate::bail;
use crate::error::Result;
use crate::money::{cents_to_yuan, yuan_to_cents, Decimalish};
use crate::services::pinyin::to_pinyin;

/// 认的列名，跟 `excel::export_products` 的表头逐字一致。
/// 其余列（当前库存、加权成本）读出来也不用
const COL_NAME: &str = "商品名";
const COL_BRAND: &str = "品牌";
const COL_SPEC: &str = "规格";
const COL_BASE_UNIT: &str = "基础单位";
const COL_PACK_UNIT: &str = "包装单位";
const COL_RATIO: &str = "换算";
const COL_PACK_PRICE: &str = "整包售价";
const COL_BASE_PRICE: &str = "单件售价";
const COL_PINYIN: &str = "拼音";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// 库里没有，这行会建出一个新商品
    Create,
    /// 有变动，会写进去
    Update,
    /// 跟库里一模一样，什么都不用做
    Same,
    /// 这一行读不懂或缺必填，跳过
    Bad,
}

impl Outcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Create => "create",
            Outcome::Update => "update",
            Outcome::Same => "same",
            Outcome::Bad => "bad",
        }
    }
}

/// 一行要写进去的东西。None = 这一格留空，别动库里的值
#[derive(Debug, Default, Clone)]
struct Fields {
    brand: Option<String>,
    spec: Option<String>,
    base_unit: Option<String>,
    pack_unit: Option<String>,
    ratio: Option<i64>,
    pack_price: Option<i64>,
    base_price: Option<i64>,
    pinyin: Option<String>,
}

#[derive(Debug)]
pub struct SheetRow {
    /// Excel 左边那个行号（从 1 数）—— 报「第 37 行」他才翻得到
    pub row_no: usize,
    pub name: String,
    pub outcome: Outcome,
    /// 读不懂时说为什么
    pub reason: Option<String>,
    /// 这一行会改什么，一条一句
    pub changes: Vec<String>,
    /// 有一部分没照做，得说清楚（比如单位锁着）
    pub notes: Vec<String>,
    product_id: Option<i64>,
    apply: Fields,
    /// 单位那几列这次允许写吗
    units_ok: bool,
}

#[derive(Debug)]
pub struct SheetPreview {
    pub rows: Vec<SheetRow>,
    pub create: usize,
    pub update: usize,
    pub same: usize,
    pub bad: usize,
}

// ─────────────────────────── 读格子 ───────────────────────────

/// 格子 → 文本。
///
/// 商品名不一定是文本格：店里真有个酒叫「1988.2」，Excel 存成数字。
/// 直接 to_string 会得到 "1988.2"，而整数 12 要得到 "12" 不是 "12.0" ——
/// 两种都得对得上库里的名字。
fn cell_text(c: &Data) -> String {
    match c {
        Data::String(s) => s.trim().to_string(),
        Data::Int(i) => i.to_string(),
        Data::Float(f) => {
            if f.fract() == 0.0 && f.abs() < 1e15 {
                format!("{}", *f as i64)
            } else {
                format!("{f}")
                    .trim_end_matches('0')
                    .trim_end_matches('.')
                    .to_string()
            }
        }
        Data::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

fn cell_opt_text(c: Option<&Data>) -> Option<String> {
    let t = c.map(cell_text).unwrap_or_default();
    if t.is_empty() {
        None
    } else {
        Some(t)
    }
}

/// 格子 → 分。空格子返回 None，**不是零** —— 空表示「这格他没填，别动库里的价」。
///
/// 这里是浮点唯一的入口。表里存的就是 f64（导出时也这么写进去的），
/// 乘 100 必须四舍五入：56.7 在 f64 里是 56.699999…，截断会变成 5669。
fn cell_cents(c: Option<&Data>) -> std::result::Result<Option<i64>, String> {
    let Some(c) = c else { return Ok(None) };
    let cents = match c {
        Data::Empty => return Ok(None),
        Data::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                return Ok(None);
            }
            // 有人会手打「55.50 元」或者带个 ¥
            let cleaned = t.trim_start_matches('¥').trim_end_matches('元').trim();
            yuan_to_cents(&Decimalish::from(cleaned)).map_err(|_| format!("价格看不懂：「{t}」"))?
        }
        Data::Int(i) => i.checked_mul(100).ok_or_else(|| "价格太大了".to_string())?,
        Data::Float(f) => {
            if !f.is_finite() {
                return Err("价格不是个数".to_string());
            }
            (f * 100.0).round() as i64
        }
        Data::Error(_) => return Err("这一格 Excel 自己就报错了".to_string()),
        _ => return Err("价格得是数字".to_string()),
    };

    if cents < 0 {
        return Err("价格不能是负数".to_string());
    }
    Ok(Some(cents))
}

/// 格子 → 换算倍数。
fn cell_ratio(c: Option<&Data>) -> std::result::Result<Option<i64>, String> {
    let t = cell_opt_text(c);
    let Some(t) = t else { return Ok(None) };
    let n: i64 = t
        .parse()
        .map_err(|_| format!("换算得是个整数：「{t}」。一条装 10 包就写 10"))?;
    if n < 1 {
        return Err(format!("换算不能小于 1：「{t}」"));
    }
    Ok(Some(n))
}

// ─────────────────────────── 定位表头 ───────────────────────────

struct Sheet {
    header_at: usize,
    col: HashMap<&'static str, usize>,
    rows: Vec<Vec<Data>>,
}

impl Sheet {
    fn cell<'a>(&self, r: &'a [Data], name: &'static str) -> Option<&'a Data> {
        self.col.get(name).and_then(|&i| r.get(i))
    }
}

/// 按**列名**定位，不按列序号 —— 在 Excel 里插一列、挪一列是常事，
/// 按序号读会把「规格」当成价格写进库里，而且不报错。
fn locate(rows: Vec<Vec<Data>>) -> Result<Sheet> {
    let header_at = rows
        .iter()
        .take(10)
        .position(|r| r.iter().any(|c| cell_text(c) == COL_NAME));

    let Some(header_at) = header_at else {
        bail!("这张表里找不到「{COL_NAME}」那一列。请在商品页点「导出 Excel」出一份，改完再导回来");
    };

    let header: Vec<String> = rows[header_at].iter().map(cell_text).collect();
    let mut col = HashMap::new();
    for want in [
        COL_NAME,
        COL_BRAND,
        COL_SPEC,
        COL_BASE_UNIT,
        COL_PACK_UNIT,
        COL_RATIO,
        COL_PACK_PRICE,
        COL_BASE_PRICE,
        COL_PINYIN,
    ] {
        if let Some(i) = header.iter().position(|h| h == want) {
            col.insert(want, i);
        }
    }

    Ok(Sheet {
        header_at,
        col,
        rows,
    })
}

// ─────────────────────────── 库里现有的 ───────────────────────────

#[derive(Debug, Clone)]
struct Known {
    id: i64,
    brand: String,
    spec: String,
    base_unit: String,
    pack_unit: Option<String>,
    ratio: i64,
    pack_price: Option<i64>,
    base_price: Option<i64>,
    pinyin_abbr: String,
    /// 有过进货或销售 —— 单位就此冻结
    has_history: bool,
}

fn current(conn: &Connection) -> Result<HashMap<String, Known>> {
    let mut stmt = conn.prepare(
        "SELECT p.name, p.id, p.brand, p.spec, p.base_unit, p.pack_unit, p.pack_ratio,
                p.price_pack_cents, p.price_base_cents, p.pinyin_abbr,
                EXISTS (SELECT 1 FROM sale_items     si WHERE si.product_id = p.id)
                  OR EXISTS (SELECT 1 FROM purchase_items pi WHERE pi.product_id = p.id)
                  OR EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.product_id = p.id)
           FROM products p
          WHERE p.is_active = 1 AND p.is_service = 0",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            Known {
                id: r.get(1)?,
                brand: r.get(2)?,
                spec: r.get(3)?,
                base_unit: r.get(4)?,
                pack_unit: r.get(5)?,
                ratio: r.get(6)?,
                pack_price: r.get(7)?,
                base_price: r.get(8)?,
                pinyin_abbr: r.get(9)?,
                has_history: r.get(10)?,
            },
        ))
    })?;

    let mut out = HashMap::new();
    for row in rows {
        let (name, k) = row?;
        out.insert(name, k);
    }
    Ok(out)
}

// ─────────────────────────── 逐行算 ───────────────────────────

fn bad(row_no: usize, name: String, reason: String) -> SheetRow {
    SheetRow {
        row_no,
        name,
        outcome: Outcome::Bad,
        reason: Some(reason),
        changes: Vec::new(),
        notes: Vec::new(),
        product_id: None,
        apply: Fields::default(),
        units_ok: false,
    }
}

fn money(v: Option<i64>) -> String {
    match v {
        Some(c) => format!("¥{}", cents_to_yuan(c)),
        None => "—".to_string(),
    }
}

/// 读一遍表，算出「导进去会发生什么」。不落库。
pub fn preview(conn: &Connection, path: &Path) -> Result<SheetPreview> {
    let mut book = open_workbook_auto(path)
        .map_err(|e| crate::error::AppError::new(format!("这个文件打不开：{e}")))?;

    let Some(sheet_name) = book.sheet_names().first().cloned() else {
        bail!("这个文件里一页表都没有");
    };
    let range = book
        .worksheet_range(&sheet_name)
        .map_err(|e| crate::error::AppError::new(format!("读不了第一页：{e}")))?;

    let sheet = locate(range.rows().map(<[Data]>::to_vec).collect())?;
    let known = current(conn)?;

    let mut rows = Vec::new();
    // 同一个名字出现两回：后一行会把前一行刚写的盖掉，而他不知道哪个生效了
    let mut seen: HashMap<String, usize> = HashMap::new();

    for (i, r) in sheet.rows.iter().enumerate().skip(sheet.header_at + 1) {
        let row_no = i + 1;
        let name = sheet
            .cell(r, COL_NAME)
            .map(cell_text)
            .unwrap_or_default();
        if name.is_empty() {
            continue; // 表尾常有一堆空行，不值得报错
        }

        if let Some(prev) = seen.insert(name.clone(), row_no) {
            rows.push(bad(
                row_no,
                name,
                format!("这个商品在第 {prev} 行已经出现过了"),
            ));
            continue;
        }

        let pack_price = match cell_cents(sheet.cell(r, COL_PACK_PRICE)) {
            Ok(v) => v,
            Err(e) => {
                rows.push(bad(row_no, name, format!("整包售价：{e}")));
                continue;
            }
        };
        let base_price = match cell_cents(sheet.cell(r, COL_BASE_PRICE)) {
            Ok(v) => v,
            Err(e) => {
                rows.push(bad(row_no, name, format!("单件售价：{e}")));
                continue;
            }
        };
        let ratio = match cell_ratio(sheet.cell(r, COL_RATIO)) {
            Ok(v) => v,
            Err(e) => {
                rows.push(bad(row_no, name, e));
                continue;
            }
        };

        let fields = Fields {
            brand: cell_opt_text(sheet.cell(r, COL_BRAND)),
            spec: cell_opt_text(sheet.cell(r, COL_SPEC)),
            base_unit: cell_opt_text(sheet.cell(r, COL_BASE_UNIT)),
            pack_unit: cell_opt_text(sheet.cell(r, COL_PACK_UNIT)),
            ratio,
            pack_price,
            base_price,
            pinyin: cell_opt_text(sheet.cell(r, COL_PINYIN)),
        };

        rows.push(match known.get(&name) {
            None => plan_create(row_no, name, fields),
            Some(k) => plan_update(row_no, name, fields, k),
        });
    }

    let count = |o: Outcome| rows.iter().filter(|r| r.outcome == o).count();
    Ok(SheetPreview {
        create: count(Outcome::Create),
        update: count(Outcome::Update),
        same: count(Outcome::Same),
        bad: count(Outcome::Bad),
        rows,
    })
}

/// 库里没有 → 建一个新商品。
fn plan_create(row_no: usize, name: String, mut f: Fields) -> SheetRow {
    let Some(base_unit) = f.base_unit.clone() else {
        return bad(
            row_no,
            name,
            format!("新商品得写「{COL_BASE_UNIT}」，卖的时候按什么计量"),
        );
    };

    // 建表时的 CHECK：没有包装单位，换算就只能是 1
    let ratio = f.ratio.unwrap_or(1);
    if f.pack_unit.is_none() && ratio != 1 {
        return bad(
            row_no,
            name,
            format!("写了换算 {ratio} 就得同时写「{COL_PACK_UNIT}」，比如「条」"),
        );
    }
    f.ratio = Some(ratio);

    let mut changes = vec![match &f.pack_unit {
        Some(pu) => format!("新建　1 {pu} = {ratio} {base_unit}"),
        None => format!("新建　按{base_unit}卖"),
    }];
    if f.pack_price.is_some() || f.base_price.is_some() {
        changes.push(format!(
            "整包 {}　单件 {}",
            money(f.pack_price),
            money(f.base_price)
        ));
    }

    SheetRow {
        row_no,
        name,
        outcome: Outcome::Create,
        reason: None,
        changes,
        notes: Vec::new(),
        product_id: None,
        apply: f,
        units_ok: true,
    }
}

/// 库里有 → 逐列比，只记真有变化的。
fn plan_update(row_no: usize, name: String, mut f: Fields, k: &Known) -> SheetRow {
    let mut changes = Vec::new();
    let mut notes = Vec::new();

    // 空格子 = 这格他没填，保持原样。当成空值写回去的话，
    // 导一次表就能把几十个价清光，而且界面还显示「导入成功」
    if f.pack_price.is_some() && f.pack_price != k.pack_price {
        changes.push(format!("整包 {} → {}", money(k.pack_price), money(f.pack_price)));
    } else {
        f.pack_price = None;
    }
    if f.base_price.is_some() && f.base_price != k.base_price {
        changes.push(format!("单件 {} → {}", money(k.base_price), money(f.base_price)));
    } else {
        f.base_price = None;
    }

    let text_change = |cur: &str, next: &Option<String>| -> Option<String> {
        match next {
            Some(v) if v != cur => Some(v.clone()),
            _ => None,
        }
    };
    if let Some(v) = text_change(&k.brand, &f.brand) {
        changes.push(format!("品牌 {} → {v}", if k.brand.is_empty() { "—" } else { &k.brand }));
        f.brand = Some(v);
    } else {
        f.brand = None;
    }
    if let Some(v) = text_change(&k.spec, &f.spec) {
        changes.push(format!("规格 {} → {v}", if k.spec.is_empty() { "—" } else { &k.spec }));
        f.spec = Some(v);
    } else {
        f.spec = None;
    }
    if let Some(v) = text_change(&k.pinyin_abbr, &f.pinyin) {
        changes.push(format!("拼音 {} → {v}", k.pinyin_abbr));
        f.pinyin = Some(v);
    } else {
        f.pinyin = None;
    }

    // 单位那三列
    let unit_differs = f.base_unit.as_deref().is_some_and(|v| v != k.base_unit)
        || f.pack_unit.is_some() && f.pack_unit != k.pack_unit
        || f.ratio.is_some_and(|v| v != k.ratio);

    let mut units_ok = false;
    if unit_differs {
        if k.has_history {
            // 库存流水存的是基础单位数量。把 1条=10包 改成 20，
            // 历史上每一笔的数量含义当场全变，而且一声不吭
            notes.push("单位和换算没改 —— 这个商品已经有进货或销售记录了，改了历史数量会全错".to_string());
            f.base_unit = None;
            f.pack_unit = None;
            f.ratio = None;
        } else {
            units_ok = true;
            let base = f.base_unit.clone().unwrap_or_else(|| k.base_unit.clone());
            let pack = f.pack_unit.clone().or_else(|| k.pack_unit.clone());
            let ratio = f.ratio.unwrap_or(k.ratio);
            if pack.is_none() && ratio != 1 {
                return bad(
                    row_no,
                    name,
                    format!("写了换算 {ratio} 就得同时写「{COL_PACK_UNIT}」"),
                );
            }
            changes.push(match &pack {
                Some(pu) => format!(
                    "单位 {} → 1 {pu} = {ratio} {base}",
                    match &k.pack_unit {
                        Some(o) => format!("1 {o} = {} {}", k.ratio, k.base_unit),
                        None => k.base_unit.clone(),
                    }
                ),
                None => format!("单位 {} → {base}", k.base_unit),
            });
            f.base_unit = Some(base);
            f.pack_unit = pack;
            f.ratio = Some(ratio);
        }
    } else {
        f.base_unit = None;
        f.pack_unit = None;
        f.ratio = None;
    }

    SheetRow {
        row_no,
        name,
        outcome: if changes.is_empty() {
            Outcome::Same
        } else {
            Outcome::Update
        },
        reason: None,
        changes,
        notes,
        product_id: Some(k.id),
        apply: f,
        units_ok,
    }
}

// ─────────────────────────── 落库 ───────────────────────────

pub struct ApplyResult {
    pub created: usize,
    pub updated: usize,
    pub same: usize,
    pub bad: usize,
}

/// 按预览结果写进去。调用方负责开事务 —— 一张表要么整张生效，要么一行都不生效。
pub fn apply(conn: &Connection, path: &Path) -> Result<ApplyResult> {
    let p = preview(conn, path)?;
    let mut created = 0;
    let mut updated = 0;

    for row in &p.rows {
        match row.outcome {
            Outcome::Create => {
                let f = &row.apply;
                // 拼音没填就按名字生成 —— 填了就用他的，那多半是他给自己留的检索别名
                let py = to_pinyin(&row.name);
                let abbr = f.pinyin.clone().unwrap_or(py.abbr);
                conn.execute(
                    "INSERT INTO products
                       (name, pinyin_full, pinyin_abbr, category, brand, spec,
                        base_unit, pack_unit, pack_ratio, price_pack_cents, price_base_cents)
                     VALUES (?1, ?2, ?3, 'other', ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    rusqlite::params![
                        row.name,
                        py.full,
                        abbr,
                        f.brand.clone().unwrap_or_default(),
                        f.spec.clone().unwrap_or_default(),
                        f.base_unit,
                        f.pack_unit,
                        f.ratio.unwrap_or(1),
                        f.pack_price,
                        f.base_price,
                    ],
                )?;
                created += 1;
            }
            Outcome::Update => {
                let Some(id) = row.product_id else { continue };
                let f = &row.apply;
                // COALESCE：这次没带的字段保持原样，不需要为每种组合拼一条 SQL
                conn.execute(
                    "UPDATE products SET
                       brand            = COALESCE(?1, brand),
                       spec             = COALESCE(?2, spec),
                       pinyin_abbr      = COALESCE(?3, pinyin_abbr),
                       price_pack_cents = COALESCE(?4, price_pack_cents),
                       price_base_cents = COALESCE(?5, price_base_cents),
                       updated_at       = datetime('now')
                     WHERE id = ?6",
                    rusqlite::params![
                        f.brand,
                        f.spec,
                        f.pinyin,
                        f.pack_price,
                        f.base_price,
                        id
                    ],
                )?;
                // 单位单独一条：允许改的时候才碰，且三列一起写，不留半套
                if row.units_ok {
                    conn.execute(
                        "UPDATE products
                            SET base_unit = ?1, pack_unit = ?2, pack_ratio = ?3,
                                updated_at = datetime('now')
                          WHERE id = ?4",
                        rusqlite::params![f.base_unit, f.pack_unit, f.ratio.unwrap_or(1), id],
                    )?;
                }
                updated += 1;
            }
            Outcome::Same | Outcome::Bad => {}
        }
    }

    Ok(ApplyResult {
        created,
        updated,
        same: p.same,
        bad: p.bad,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;
    use rust_xlsxwriter::Workbook;
    use std::path::PathBuf;

    /// 表里的一行。用 Option 是因为**留空和填值是两回事** —— 这是整套逻辑的要害
    #[derive(Default, Clone)]
    struct Row<'a> {
        name: &'a str,
        brand: Option<&'a str>,
        spec: Option<&'a str>,
        base_unit: Option<&'a str>,
        pack_unit: Option<&'a str>,
        ratio: Option<i64>,
        pack_price: Option<f64>,
        base_price: Option<f64>,
        pinyin: Option<&'a str>,
    }

    fn row(name: &str) -> Row<'_> {
        Row {
            name,
            ..Default::default()
        }
    }

    fn tmp(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ly-ledger-sheet-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(format!("{tag}.xlsx"))
    }

    /// 按导出表的列序写一份。中间夹着「当前库存」「加权成本」两列，
    /// 它们是算出来的结果，导入时必须被忽略
    fn sheet(tag: &str, rows: &[Row]) -> PathBuf {
        let path = tmp(tag);
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        for (c, h) in [
            "商品名", "品牌", "规格", "基础单位", "包装单位", "换算",
            "整包售价", "单件售价", "当前库存", "加权成本", "拼音",
        ]
        .iter()
        .enumerate()
        {
            ws.write_string(0, c as u16, *h).unwrap();
        }
        for (i, r) in rows.iter().enumerate() {
            let y = i as u32 + 1;
            ws.write_string(y, 0, r.name).unwrap();
            if let Some(v) = r.brand {
                ws.write_string(y, 1, v).unwrap();
            }
            if let Some(v) = r.spec {
                ws.write_string(y, 2, v).unwrap();
            }
            if let Some(v) = r.base_unit {
                ws.write_string(y, 3, v).unwrap();
            }
            if let Some(v) = r.pack_unit {
                ws.write_string(y, 4, v).unwrap();
            }
            if let Some(v) = r.ratio {
                ws.write_number(y, 5, v as f64).unwrap();
            }
            if let Some(v) = r.pack_price {
                ws.write_number(y, 6, v).unwrap();
            }
            if let Some(v) = r.base_price {
                ws.write_number(y, 7, v).unwrap();
            }
            // 库存和成本照样写进去，验证导入时不理它们
            ws.write_number(y, 8, 999.0).unwrap();
            ws.write_number(y, 9, 888.0).unwrap();
            if let Some(v) = r.pinyin {
                ws.write_string(y, 10, v).unwrap();
            }
        }
        wb.save(&path).unwrap();
        path
    }

    fn shop() -> Connection {
        let conn = open_memory().unwrap();
        conn.execute(
            "INSERT INTO products (name, pinyin_abbr, category, brand, base_unit, pack_unit,
                                   pack_ratio, price_pack_cents, price_base_cents)
             VALUES ('中华(硬)', 'zhy', 'cigarette', '中华', '包', '条', 10, 55000, 5700)",
            [],
        )
        .unwrap();
        conn
    }

    fn get(conn: &Connection, name: &str) -> Known {
        current(conn).unwrap().remove(name).expect("查不到这个商品")
    }

    fn outcomes(p: &SheetPreview) -> (usize, usize, usize, usize) {
        (p.create, p.update, p.same, p.bad)
    }

    // ═══════════════════ 加商品 ═══════════════════

    #[test]
    fn 表里多一行就建出一个商品() {
        let conn = shop();
        let f = sheet(
            "create",
            &[Row {
                base_unit: Some("斤"),
                base_price: Some(320.0),
                ..row("茉莉银针")
            }],
        );

        let r = apply(&conn, &f).unwrap();
        assert_eq!((r.created, r.updated), (1, 0));

        let k = get(&conn, "茉莉银针");
        assert_eq!((k.base_unit.as_str(), k.ratio), ("斤", 1));
        assert_eq!(k.base_price, Some(32_000));
        assert_eq!(k.pinyin_abbr, "mlyz", "拼音自动生成，不用他填");
    }

    #[test]
    fn 新商品带包装换算也能建() {
        let conn = shop();
        let f = sheet(
            "create2",
            &[Row {
                brand: Some("苏烟"),
                spec: Some("软盒"),
                base_unit: Some("包"),
                pack_unit: Some("条"),
                ratio: Some(10),
                pack_price: Some(680.0),
                base_price: Some(70.0),
                ..row("苏烟(软金砂)")
            }],
        );

        apply(&conn, &f).unwrap();
        let k = get(&conn, "苏烟(软金砂)");
        assert_eq!(k.pack_unit.as_deref(), Some("条"));
        assert_eq!(k.ratio, 10);
        assert_eq!((k.pack_price, k.base_price), (Some(68_000), Some(7_000)));
        assert_eq!((k.brand.as_str(), k.spec.as_str()), ("苏烟", "软盒"));
    }

    #[test]
    fn 新商品不写基础单位就不建() {
        // 没有单位的商品是个壳，卖它的时候才发现 —— 不如现在就说
        let conn = shop();
        let f = sheet(
            "nounit",
            &[Row {
                base_price: Some(10.0),
                ..row("不知名")
            }],
        );

        let p = preview(&conn, &f).unwrap();
        assert_eq!(outcomes(&p), (0, 0, 0, 1));
        assert!(p.rows[0].reason.as_deref().unwrap().contains("基础单位"));
    }

    #[test]
    fn 写了换算却没写包装单位就不建() {
        // 建表时的 CHECK 也会拦，但那时报的是约束名，老板看不懂
        let conn = shop();
        let f = sheet(
            "noratio",
            &[Row {
                base_unit: Some("包"),
                ratio: Some(10),
                ..row("某烟")
            }],
        );

        let p = preview(&conn, &f).unwrap();
        assert_eq!(p.bad, 1);
        assert!(p.rows[0].reason.as_deref().unwrap().contains("包装单位"));
    }

    // ═══════════════════ 改价 ═══════════════════

    #[test]
    fn 空格子不动库里的价() {
        // 导出的表里大半格子是空的。当成 0 写回去，一次就能把几十个价清光，
        // 而且界面还会显示「导入成功」
        let conn = shop();
        let f = sheet("blank", &[row("中华(硬)")]);

        let r = apply(&conn, &f).unwrap();
        assert_eq!((r.created, r.updated, r.same), (0, 0, 1));
        let k = get(&conn, "中华(硬)");
        assert_eq!((k.pack_price, k.base_price), (Some(55_000), Some(5_700)));
    }

    #[test]
    fn 只填一列时另一列保持原样() {
        let conn = shop();
        let f = sheet(
            "one",
            &[Row {
                pack_price: Some(580.0),
                ..row("中华(硬)")
            }],
        );

        apply(&conn, &f).unwrap();
        let k = get(&conn, "中华(硬)");
        assert_eq!((k.pack_price, k.base_price), (Some(58_000), Some(5_700)));
    }

    #[test]
    fn 两位小数不丢分() {
        // 56.7 在 f64 里是 56.699999…，直接截断会变成 5669
        let conn = shop();
        let f = sheet(
            "cents",
            &[Row {
                pack_price: Some(555.55),
                base_price: Some(56.7),
                ..row("中华(硬)")
            }],
        );

        apply(&conn, &f).unwrap();
        let k = get(&conn, "中华(硬)");
        assert_eq!((k.pack_price, k.base_price), (Some(55_555), Some(5_670)));
    }

    #[test]
    fn 改品牌规格和检索拼音() {
        let conn = shop();
        let f = sheet(
            "meta",
            &[Row {
                brand: Some("中华"),
                spec: Some("硬盒"),
                pinyin: Some("zh"),
                ..row("中华(硬)")
            }],
        );

        let r = apply(&conn, &f).unwrap();
        assert_eq!(r.updated, 1);
        let k = get(&conn, "中华(硬)");
        assert_eq!(k.spec, "硬盒");
        assert_eq!(
            k.pinyin_abbr, "zh",
            "填了拼音就用他的 —— 那是他给自己留的检索别名"
        );
    }

    // ═══════════════════ 单位这条线 ═══════════════════

    #[test]
    fn 没有账的商品可以改单位() {
        let conn = shop();
        let f = sheet(
            "unit_ok",
            &[Row {
                base_unit: Some("包"),
                pack_unit: Some("条"),
                ratio: Some(20),
                ..row("中华(硬)")
            }],
        );

        let r = apply(&conn, &f).unwrap();
        assert_eq!(r.updated, 1);
        assert_eq!(
            get(&conn, "中华(硬)").ratio,
            20,
            "一次货都没进过，这时候改还来得及"
        );
    }

    #[test]
    fn 有账的商品单位改不了但价照改() {
        // 库存流水存的是基础单位数量。1条=10包 改成 20，历史上每一笔的含义当场全变
        let conn = shop();
        let id: i64 = conn
            .query_row("SELECT id FROM products WHERE name = '中华(硬)'", [], |r| {
                r.get(0)
            })
            .unwrap();
        let input: crate::services::purchases::ReceiveInput =
            serde_json::from_value(serde_json::json!({
                "bizDate": "2026-09-19",
                "items": [{ "productId": id, "unit": "pack", "qty": "2", "unitCostYuan": "520" }],
            }))
            .unwrap();
        crate::services::purchases::receive(&conn, &input).unwrap();

        let f = sheet(
            "unit_locked",
            &[Row {
                pack_unit: Some("条"),
                ratio: Some(20),
                pack_price: Some(580.0),
                ..row("中华(硬)")
            }],
        );

        let p = preview(&conn, &f).unwrap();
        assert_eq!(p.rows[0].outcome, Outcome::Update);
        assert!(
            p.rows[0].notes[0].contains("已经有进货或销售记录"),
            "得说清楚为什么没改：{:?}",
            p.rows[0].notes
        );

        apply(&conn, &f).unwrap();
        let k = get(&conn, "中华(硬)");
        assert_eq!(k.ratio, 10, "换算不许动");
        assert_eq!(k.pack_price, Some(58_000), "价照改");
    }

    // ═══════════════════ 坏数据 ═══════════════════

    #[test]
    fn 同一个商品出现两回要拦下() {
        let conn = shop();
        let f = sheet(
            "dup",
            &[
                Row {
                    pack_price: Some(580.0),
                    ..row("中华(硬)")
                },
                Row {
                    pack_price: Some(600.0),
                    ..row("中华(硬)")
                },
            ],
        );

        let p = preview(&conn, &f).unwrap();
        assert_eq!(p.bad, 1);
        assert!(p.rows[1].reason.as_deref().unwrap().contains("已经出现过"));
        assert_eq!(
            get(&conn, "中华(硬)").pack_price,
            Some(55_000),
            "预览不落库"
        );
    }

    #[test]
    fn 负价格不收() {
        let conn = shop();
        let f = sheet(
            "neg",
            &[Row {
                pack_price: Some(-5.0),
                ..row("中华(硬)")
            }],
        );
        let p = preview(&conn, &f).unwrap();
        assert!(p.rows[0].reason.as_deref().unwrap().contains("负数"));
    }

    #[test]
    fn 读不懂的那一行不拖垮整张表() {
        let conn = shop();
        let path = tmp("mixed");
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        for (c, h) in ["商品名", "基础单位", "整包售价", "单件售价"]
            .iter()
            .enumerate()
        {
            ws.write_string(0, c as u16, *h).unwrap();
        }
        ws.write_string(1, 0, "中华(硬)").unwrap();
        ws.write_string(1, 2, "五百八").unwrap();
        ws.write_string(2, 0, "茉莉银针").unwrap();
        ws.write_string(2, 1, "斤").unwrap();
        ws.write_number(2, 3, 320.0).unwrap();
        wb.save(&path).unwrap();

        let r = apply(&conn, &path).unwrap();
        assert_eq!((r.created, r.bad), (1, 1), "坏的那行跳过，好的那行照样建");
        assert_eq!(get(&conn, "中华(硬)").pack_price, Some(55_000), "没动");
    }

    #[test]
    fn 不是那张表就直说() {
        let conn = shop();
        let path = tmp("wrong");
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.write_string(0, 0, "日期").unwrap();
        ws.write_string(0, 1, "金额").unwrap();
        wb.save(&path).unwrap();

        let err = preview(&conn, &path).unwrap_err().to_string();
        assert!(err.contains("商品名"), "要指出缺哪一列：{err}");
        assert!(err.contains("导出"), "还要说清楚去哪儿拿模板：{err}");
    }

    #[test]
    fn 库存和成本那两列改了也不生效() {
        // 它们是从流水算出来的结果，不是可以填的输入。
        // sheet() 往这两列写的都是 999 / 888
        let conn = shop();
        let f = sheet(
            "readonly",
            &[Row {
                pack_price: Some(580.0),
                ..row("中华(硬)")
            }],
        );

        apply(&conn, &f).unwrap();
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM inventory", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0, "库存只能靠进货销售变，不能靠填表");
    }

    // ═══════════════════ 往返 ═══════════════════

    #[test]
    fn 导出的那张表原样导回去什么都不该变() {
        // 界面上写着「导出的商品表同时就是导入模板」。这条测试就是那句话本身 ——
        // 表头改一个字、列挪一个位置，这里就红
        let conn = shop();
        conn.execute(
            "INSERT INTO products (name, category, base_unit) VALUES ('泸小二', 'liquor', '瓶')",
            [],
        )
        .unwrap();

        let export = crate::services::excel::export_products(&conn).unwrap();
        let path = tmp("roundtrip");
        std::fs::write(&path, &export.bytes).unwrap();

        let p = preview(&conn, &path).unwrap();
        assert_eq!(outcomes(&p), (0, 0, 2, 0), "一个字没改，就该是两行「没变」");
    }
}
