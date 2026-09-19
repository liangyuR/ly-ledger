//! 每日自动备份的排期。
//!
//! 起一个后台线程，每天 03:00 跑一次。**启动时也补一次** ——
//! 柜台电脑不是 7×24 开机的，凌晨三点多半关着。只在今天还没备过时才补，
//! 不会每次重开软件都写一份。
//!
//! 电脑睡眠错过了触发点没关系：醒来后线程会晚一点醒；关机错过的由启动补备兜住。

use std::thread;
use std::time::Duration;

use chrono::{Local, NaiveTime, TimeDelta};
use tauri::{AppHandle, Manager};

use crate::services::backup;
use crate::state::AppState;

const BACKUP_HOUR: u32 = 3;

/// 距离下一个 hour:00 还有多久。
fn until_next(hour: u32) -> Duration {
    let now = Local::now();
    let at = NaiveTime::from_hms_opt(hour, 0, 0).expect("小时数合法");

    let mut next = now.with_time(at).single().unwrap_or(now);
    if next <= now {
        next += TimeDelta::days(1);
    }

    (next - now).to_std().unwrap_or(Duration::from_secs(60))
}

/// 关掉自动备份的后门。给测试和「我自己有备份方案」留的。
fn disabled() -> bool {
    std::env::var("LY_LEDGER_NO_BACKUP").as_deref() == Ok("1")
}

pub fn schedule(app: &AppHandle) {
    if disabled() {
        eprintln!("自动备份已被 LY_LEDGER_NO_BACKUP 关闭");
        return;
    }

    let handle = app.clone();
    thread::spawn(move || {
        // 启动补备：今天还没有备份才补
        let today_file = format!("{}.db", Local::now().format("%Y-%m-%d"));
        let need_catch_up = {
            let state = handle.state::<AppState>();
            match backup::backup_status(&state.root.backup_dir()) {
                Ok(s) => s.last_backup_file.as_deref() != Some(today_file.as_str()),
                Err(_) => true,
            }
        };
        if need_catch_up {
            run_once(&handle, "启动补备");
        }

        loop {
            thread::sleep(until_next(BACKUP_HOUR));
            run_once(&handle, "定时");
        }
    });
}

fn run_once(app: &AppHandle, reason: &str) {
    let state = app.state::<AppState>();
    let dir = state.root.backup_dir();

    let result = state.with(|conn| Ok(backup::run_backup(conn, &dir)));

    match result {
        Ok(r) if r.ok => {
            eprintln!("备份完成（{reason}）：{}", r.file.unwrap_or_default());
        }
        // 静默失败的备份等于没有备份 —— 至少要在日志里留一句
        Ok(r) => eprintln!("备份失败（{reason}）：{}", r.error.unwrap_or_default()),
        Err(e) => eprintln!("备份失败（{reason}）：{e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 下一次触发一定在未来且不超过一天() {
        let d = until_next(BACKUP_HOUR);
        assert!(d.as_secs() > 0);
        assert!(d.as_secs() <= 24 * 3600);
    }
}
