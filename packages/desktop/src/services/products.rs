//! 删商品。
//!
//! 商品本身不是流水，但历史单据指着它 —— 一个卖过货的商品被真删掉，
//! 上个月那张销售单就变成「不知道卖的是什么」，报表也跟着塌一块。
//! 所以这里分两种走法：
//!
//!   没动过的  没进过货、没卖过、没有任何库存流水 → 真删，行从库里消失。
//!             名字录错了、牌子勾多了，当场删掉就是这一种。
//!   动过的    → 不真删，改成停用。列表和搜索里不再出现，老账照样查得到。
//!
//! 由后端判，不让老板选：「这个商品有没有被别的单子引用」老板根本无从知道，
//! 而这恰恰是能不能真删的唯一判据。让他选只会选出一个坏结果。

use rusqlite::{Connection, OptionalExtension};

use crate::bail;
use crate::error::Result;

#[derive(Debug, PartialEq, Eq)]
pub enum Removal {
    /// 真删了，products 里已经没这一行
    Deleted,
    /// 有账在，只停用。带上是哪几笔挡住了 —— 老板得知道软件凭什么不听话
    Deactivated { purchases: i64, sales: i64 },
}

#[derive(Debug)]
pub struct RemoveResult {
    pub name: String,
    pub outcome: Removal,
}

/// 商品被多少张单子引用。三张表都要数：进货、销售，再加一道库存流水兜底 ——
/// schema 里还留着 adjust / stocktake 两种流水，哪天谁写进来了，这里不改也仍然安全。
/// 漏数一张表的代价是留下一条指向不存在商品的流水，而且要等到看报表那天才发现。
fn references(conn: &Connection, id: i64) -> Result<(i64, i64, i64)> {
    let one = |sql: &str| -> Result<i64> {
        Ok(conn.query_row(sql, [id], |r| r.get(0))?)
    };
    Ok((
        one("SELECT count(*) FROM purchase_items  WHERE product_id = ?1")?,
        one("SELECT count(*) FROM sale_items      WHERE product_id = ?1")?,
        one("SELECT count(*) FROM stock_movements WHERE product_id = ?1")?,
    ))
}

pub fn remove_product(conn: &Connection, id: i64) -> Result<RemoveResult> {
    let name: String = match conn
        .query_row("SELECT name FROM products WHERE id = ?1", [id], |r| r.get(0))
        .optional()?
    {
        Some(n) => n,
        None => bail!("商品不存在：{id}"),
    };

    let (purchases, sales, movements) = references(conn, id)?;

    // 结存快照也算一道：没流水却有结存说明数据被手工动过，这种更不该真删
    let stock: i64 = conn
        .query_row(
            "SELECT qty_base_milli FROM inventory WHERE product_id = ?1",
            [id],
            |r| r.get(0),
        )
        .optional()?
        .unwrap_or(0);

    if purchases > 0 || sales > 0 || movements > 0 || stock != 0 {
        conn.execute(
            "UPDATE products SET is_active = 0, updated_at = datetime('now')
              WHERE id = ?1",
            [id],
        )?;
        return Ok(RemoveResult {
            name,
            outcome: Removal::Deactivated { purchases, sales },
        });
    }

    // 空结存行是商品建出来后被读过一次留下的，跟着一起清掉，
    // 不然 products 没了它还挂在那儿，外键指向一个不存在的商品
    conn.execute("DELETE FROM inventory WHERE product_id = ?1", [id])?;
    conn.execute("DELETE FROM products WHERE id = ?1", [id])?;

    Ok(RemoveResult {
        name,
        outcome: Removal::Deleted,
    })
}
