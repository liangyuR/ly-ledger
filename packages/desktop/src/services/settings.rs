//! 设置表读写。值一律存字符串，取的时候自己转。

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::Result;

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    let v = conn
        .query_row("SELECT value FROM app_settings WHERE key = ?1", [key], |r| {
            r.get::<_, String>(0)
        })
        .optional()?;
    Ok(v)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
        params![key, value],
    )?;
    Ok(())
}

pub fn get_flag(conn: &Connection, key: &str) -> Result<bool> {
    Ok(get_setting(conn, key)?.as_deref() == Some("1"))
}

pub fn set_flag(conn: &Connection, key: &str, on: bool) -> Result<()> {
    set_setting(conn, key, if on { "1" } else { "0" })
}
