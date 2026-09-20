//! 连接、pragma、迁移。
//!
//! 迁移文件用 `include_str!` 编进二进制 —— 打包后没有 migrations 目录可读，
//! 而「少一个 .sql 文件就建不出表」是那种装到店主电脑上才会发现的故障。
//!
//! `_migrations` 表名和记录的文件名与 Node 版**逐字一致**，所以旧的
//! `ledger.db` 直接拿过来就能用，不需要任何数据迁移动作。

use std::fs;
use std::path::Path;

use rusqlite::Connection;

use crate::error::Result;

/// 按文件名顺序执行。新增迁移就往这里加一行 —— 顺序即执行顺序。
const MIGRATIONS: &[(&str, &str)] = &[
    ("001_init.sql", include_str!("../migrations/001_init.sql")),
    ("002_settings.sql", include_str!("../migrations/002_settings.sql")),
    ("003_expenses.sql", include_str!("../migrations/003_expenses.sql")),
    ("004_services.sql", include_str!("../migrations/004_services.sql")),
];

/// 打开一个连接并设好 pragma。
pub fn open(path: &Path) -> Result<Connection> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let conn = Connection::open(path)?;
    set_pragmas(&conn)?;
    Ok(conn)
}

fn set_pragmas(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        // 读写不互相阻塞，崩溃后不易损坏
        "PRAGMA journal_mode = WAL;\
         -- SQLite 默认不开外键约束，不开的话建表时写的 REFERENCES 形同虚设\n\
         PRAGMA foreign_keys = ON;\
         -- 这是台账不是缓存：断电安全优先于写入速度。单人一天几十笔，FULL 的开销无感\n\
         PRAGMA synchronous = FULL;",
    )?;
    Ok(())
}

/// 测试用：内存库，建完表就返回。不碰磁盘上的任何东西。
#[cfg(test)]
pub fn open_memory() -> Result<Connection> {
    let conn = Connection::open_in_memory()?;
    conn.execute_batch("PRAGMA foreign_keys = ON;")?;
    migrate(&conn)?;
    Ok(conn)
}

pub struct MigrateResult {
    pub applied: Vec<String>,
    pub skipped: usize,
}

/// 按顺序执行未跑过的迁移，已执行过的跳过。
///
/// 每个迁移整体在一个事务里 —— 失败就整体回滚，不留半个表。
/// 幂等：反复执行结果一致。
pub fn migrate(conn: &Connection) -> Result<MigrateResult> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS _migrations (
           name       TEXT PRIMARY KEY,
           applied_at TEXT NOT NULL DEFAULT (datetime('now'))
         )",
    )?;

    let done: Vec<String> = {
        let mut stmt = conn.prepare("SELECT name FROM _migrations")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };

    let mut applied = Vec::new();

    for (name, sql) in MIGRATIONS {
        if done.iter().any(|d| d == name) {
            continue;
        }
        conn.execute_batch("BEGIN")?;
        let run = (|| -> Result<()> {
            conn.execute_batch(sql)?;
            conn.execute("INSERT INTO _migrations (name) VALUES (?1)", [name])?;
            Ok(())
        })();
        match run {
            Ok(()) => {
                conn.execute_batch("COMMIT")?;
                applied.push((*name).to_string());
            }
            Err(e) => {
                conn.execute_batch("ROLLBACK")?;
                return Err(e);
            }
        }
    }

    Ok(MigrateResult {
        applied,
        skipped: done.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 迁移建出了全部业务表() {
        let conn = open_memory().unwrap();
        let n: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> '_migrations'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 13, "12 张业务表 + app_settings");
    }

    #[test]
    fn 重复迁移是幂等的() {
        let conn = open_memory().unwrap();
        let again = migrate(&conn).unwrap();
        assert!(again.applied.is_empty());
        assert_eq!(again.skipped, MIGRATIONS.len());
    }

    #[test]
    fn 外键约束是开着的() {
        let conn = open_memory().unwrap();
        let on: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
        assert_eq!(on, 1, "外键没开，建表时写的 REFERENCES 就形同虚设");
    }
}
