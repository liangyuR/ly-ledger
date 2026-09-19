//! 进程状态：一个数据库连接，一个数据根目录。
//!
//! 单机单人，不需要连接池 —— 一个连接加一把锁就够，而且省掉了「两个连接
//! 各开一个事务」这类只在真实使用里偶发、复现不出来的问题。

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{AppHandle, Manager};

use crate::db;
use crate::error::{AppError, Result};
use crate::paths::{self, Root};

pub struct AppState {
    conn: Mutex<Connection>,
    pub root: Root,
}

impl AppState {
    pub fn boot(app: &AppHandle) -> Result<Self> {
        let fallback = app
            .path()
            .app_data_dir()
            .map_err(|e| AppError::new(format!("找不到可写的数据目录：{e}")))?;

        let root = paths::resolve(fallback);
        let conn = db::open(&root.db_file())?;

        // 跑了哪条迁移要留一句。升级那天出问题，这一行是唯一的线索 ——
        // 「迁移到底跑没跑」不该靠猜
        let done = db::migrate(&conn)?;
        if done.applied.is_empty() {
            eprintln!("数据库就绪（{} 条迁移此前已执行）", done.skipped);
        } else {
            eprintln!("已执行迁移：{}", done.applied.join("、"));
        }

        Ok(AppState {
            conn: Mutex::new(conn),
            root,
        })
    }

    /// 借出连接。锁中毒（上一次持锁时 panic 了）说明状态不可信，
    /// 这时宁可报错也不要接着往库里写。
    pub fn with<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| AppError::new("数据库忙不过来了，请重开一次软件"))?;
        f(&conn)
    }

    /// 借出连接并包一个事务。中间任何一步出错整体回滚。
    ///
    /// 「一笔销售要连着改四张表」这类操作必须走这里 —— 拆成几步各自提交，
    /// 中间失败就会留下脏数据，而且没法自愈（docs/03）。
    pub fn tx<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| AppError::new("数据库忙不过来了，请重开一次软件"))?;
        let tx = conn.transaction()?;
        let out = f(&tx)?;
        tx.commit()?;
        Ok(out)
    }
}
