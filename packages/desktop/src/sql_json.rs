//! 把查询结果按**列名**转成 JSON 对象。
//!
//! 商品 / 客户 / 供应商三个列表在 Node 版是 `SELECT *` 直出，前端的
//! `Product` 接口吃的就是 `base_unit` `price_base_cents` 这些原始列名。
//! 手写一遍 struct 再 rename 回去，等于把同一份字段名抄第二遍 ——
//! 抄漏一个，页面上就少一列，而且类型检查发现不了。

use rusqlite::types::ValueRef;
use rusqlite::Statement;
use serde_json::{Map, Value};

use crate::error::Result;

/// 执行查询，每行按列名转成一个 JSON 对象。
pub fn rows_to_json(stmt: &mut Statement<'_>, params: impl rusqlite::Params) -> Result<Vec<Value>> {
    let columns: Vec<String> = stmt.column_names().into_iter().map(String::from).collect();

    let mut rows = stmt.query(params)?;
    let mut out = Vec::new();

    while let Some(row) = rows.next()? {
        let mut obj = Map::with_capacity(columns.len());
        for (i, name) in columns.iter().enumerate() {
            let value = match row.get_ref(i)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(v) => Value::from(v),
                ValueRef::Real(v) => Value::from(v),
                ValueRef::Text(v) => Value::from(String::from_utf8_lossy(v).into_owned()),
                // 库里没有 BLOB 列，真出现了也不该悄悄变成别的东西
                ValueRef::Blob(_) => Value::Null,
            };
            obj.insert(name.clone(), value);
        }
        out.push(Value::Object(obj));
    }

    Ok(out)
}
