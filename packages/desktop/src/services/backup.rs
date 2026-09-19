//! 备份与恢复。
//!
//! **本地部署的头号风险不是技术问题，是数据丢失。** 跑在云上硬盘坏了还有
//! 服务商快照；跑在柜台电脑上，硬盘坏了就是几年台账全没，而老板绝不会
//! 自己备份。所以备份不是运维事项，是一期必须交付的产品功能，
//! 优先级高于利润报表（docs/03）。

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use chrono::{DateTime, Local};
use rusqlite::{Connection, OpenFlags};

use crate::error::Result;

const KEEP: usize = 30;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFile {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub created_at: String,
    #[serde(skip)]
    pub modified: SystemTime,
}

pub fn list_backups(dir: &Path) -> Result<Vec<BackupFile>> {
    fs::create_dir_all(dir)?;

    let mut out = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("db") {
            continue;
        }
        let meta = entry.metadata()?;
        let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        out.push(BackupFile {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: path.to_string_lossy().into_owned(),
            size_bytes: meta.len(),
            created_at: DateTime::<Local>::from(modified).to_rfc3339(),
            modified,
        });
    }

    // 文件名就是日期，倒序即最新在前
    out.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(out)
}

/// 删掉 SQLite 打开 WAL 库时生成的 -shm / -wal 边车文件。
fn drop_sidecars(path: &Path) {
    for suffix in ["-shm", "-wal"] {
        let mut p = path.as_os_str().to_os_string();
        p.push(suffix);
        // 删不掉不影响备份本身
        let _ = fs::remove_file(PathBuf::from(p));
    }
}

/// 把备份文件转成单文件模式（journal_mode = DELETE）。
///
/// 源库跑在 WAL 下，备份出来也是 WAL —— 那就不是「一个文件」了。
/// 而恢复说明写的是「把这一个 .db 复制回去」，老板不会也不该去管边车文件。
/// 转成 DELETE 模式让这句承诺是字面成立的。
fn make_single_file(path: &Path) -> Result<()> {
    {
        let conn = Connection::open(path)?;
        conn.execute_batch("PRAGMA journal_mode = DELETE;")?;
    }
    drop_sidecars(path);
    Ok(())
}

pub struct VerifyResult {
    pub ok: bool,
    pub detail: String,
}

/// 校验备份文件本身是否可用。
///
/// **只验证「写出了文件」是不够的。** 一个损坏的备份比没有备份更危险 ——
/// 它让老板以为自己有后路，真到要恢复那天才发现没有。
/// 校验一个几十 MB 的 SQLite 文件是毫秒级的事，没有理由省。
pub fn verify_backup(path: &Path) -> VerifyResult {
    let outcome = (|| -> Result<VerifyResult> {
        let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;

        let check: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        if check != "ok" {
            return Ok(VerifyResult {
                ok: false,
                detail: format!("integrity_check: {check}"),
            });
        }

        // 再确认业务表真的在里面 —— 一个空但「完整」的库同样没用
        let n: i64 = conn.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='sales'",
            [],
            |r| r.get(0),
        )?;
        if n != 1 {
            return Ok(VerifyResult {
                ok: false,
                detail: "备份里没有 sales 表，不是一个有效的台账库".to_string(),
            });
        }

        Ok(VerifyResult {
            ok: true,
            detail: "ok".to_string(),
        })
    })();

    // 只读打开也会生成边车文件，别把垃圾留在备份目录
    drop_sidecars(path);

    outcome.unwrap_or_else(|e| VerifyResult {
        ok: false,
        detail: e.to_string(),
    })
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl BackupResult {
    fn failed(msg: impl Into<String>) -> Self {
        BackupResult {
            ok: false,
            file: None,
            size_bytes: None,
            error: Some(msg.into()),
        }
    }
}

/// 做一次备份。
///
/// 用 SQLite 的在线 backup API，**不是直接复制文件** ——
/// 直接 copy 正在写入的 db 会得到损坏的副本。
///
/// 校验不通过就删掉这个坏文件，**保留上一份不覆盖**。
pub fn run_backup(source: &Connection, dir: &Path) -> BackupResult {
    match run_backup_inner(source, dir) {
        Ok(r) => r,
        Err(e) => BackupResult::failed(e.to_string()),
    }
}

fn run_backup_inner(source: &Connection, dir: &Path) -> Result<BackupResult> {
    fs::create_dir_all(dir)?;

    let day = Local::now().format("%Y-%m-%d").to_string();
    let target = dir.join(format!("{day}.db"));
    let temp = dir.join(format!("{day}.db.tmp"));

    {
        let mut dst = Connection::open(&temp)?;
        let backup = rusqlite::backup::Backup::new(source, &mut dst)?;
        backup.run_to_completion(64, Duration::from_millis(50), None)?;
    }
    make_single_file(&temp)?;

    let check = verify_backup(&temp);
    if !check.ok {
        // 删不掉就算了，反正它不会被当成有效备份
        let _ = fs::remove_file(&temp);
        drop_sidecars(&temp);
        return Ok(BackupResult::failed(format!(
            "备份文件校验没通过：{}。上一份备份保持不动",
            check.detail
        )));
    }

    if target.exists() {
        fs::remove_file(&target)?;
    }
    fs::rename(&temp, &target)?;

    prune(dir)?;

    Ok(BackupResult {
        ok: true,
        file: Some(
            target
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default(),
        ),
        size_bytes: Some(fs::metadata(&target)?.len()),
        error: None,
    })
}

/// 滚动保留最近 30 份。
fn prune(dir: &Path) -> Result<()> {
    for f in list_backups(dir)?.into_iter().skip(KEEP) {
        // 删不掉不影响备份本身
        let _ = fs::remove_file(&f.path);
    }
    Ok(())
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatus {
    pub last_backup_at: Option<String>,
    pub last_backup_file: Option<String>,
    pub age_days: Option<i64>,
    /// 超过 3 天没成功备份就该标红 —— 静默失败的备份等于没有备份
    pub stale: bool,
    pub count: usize,
    pub dir: String,
}

pub fn backup_status(dir: &Path) -> Result<BackupStatus> {
    let files = list_backups(dir)?;
    let dir_text = dir.to_string_lossy().into_owned();

    let Some(latest) = files.first() else {
        return Ok(BackupStatus {
            last_backup_at: None,
            last_backup_file: None,
            age_days: None,
            stale: true,
            count: 0,
            dir: dir_text,
        });
    };

    let age_days = SystemTime::now()
        .duration_since(latest.modified)
        .map(|d| d.as_secs() as i64 / 86_400)
        .unwrap_or(0);

    Ok(BackupStatus {
        last_backup_at: Some(latest.created_at.clone()),
        last_backup_file: Some(latest.name.clone()),
        age_days: Some(age_days),
        stale: age_days > 3,
        count: files.len(),
        dir: dir_text,
    })
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveOption {
    pub letter: String,
    pub free: bool,
}

/// 找可插拔的盘符。
///
/// 本机备份防不了硬盘损坏 —— 硬盘坏了，备份和原件一起没。
/// 异地副本是这套备份方案里唯一真正兜底的一环。
///
/// 只列盘符、不分辨是不是真的 U 盘（跟 Node 版一致）：分辨要调 Win32 的
/// GetDriveType，为一个「让老板自己认盘符」的下拉框不值得引入 winapi。
pub fn removable_drives() -> Vec<DriveOption> {
    if !cfg!(windows) {
        return Vec::new();
    }
    // C 盘是系统盘，从 D 开始找
    "DEFGHIJKLMNOPQRSTUVWXYZ"
        .chars()
        .filter(|c| Path::new(&format!("{c}:\\")).exists())
        .map(|c| DriveOption {
            letter: format!("{c}:"),
            free: true,
        })
        .collect()
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

fn usb_failed(msg: impl Into<String>) -> UsbResult {
    UsbResult {
        ok: false,
        target: None,
        error: Some(msg.into()),
    }
}

/// 把最新一份备份复制到 U 盘。
pub fn copy_latest_to_usb(dir: &Path, drive_letter: &str) -> Result<UsbResult> {
    let files = list_backups(dir)?;
    let Some(latest) = files.first() else {
        return Ok(usb_failed("还没有任何备份，先备份一次"));
    };

    let shaped = drive_letter.len() == 2
        && drive_letter.as_bytes()[0].is_ascii_alphabetic()
        && drive_letter.as_bytes()[1] == b':';
    if !shaped {
        return Ok(usb_failed(format!("盘符看不懂：{drive_letter}")));
    }

    let target_dir = PathBuf::from(format!("{drive_letter}\\")).join("烟酒台账备份");
    if let Err(e) = fs::create_dir_all(&target_dir) {
        return Ok(usb_failed(format!("写不进 {drive_letter}：{e}")));
    }

    let target = target_dir.join(&latest.name);
    if let Err(e) = fs::copy(&latest.path, &target) {
        return Ok(usb_failed(format!("写不进 {drive_letter}：{e}")));
    }

    let check = verify_backup(&target);
    if !check.ok {
        return Ok(usb_failed(format!(
            "复制到 U 盘后校验没通过：{}",
            check.detail
        )));
    }

    Ok(UsbResult {
        ok: true,
        target: Some(target.to_string_lossy().into_owned()),
        error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_memory;

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ly-ledger-backup-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn 备份出来的是单个文件能通过校验() {
        let conn = open_memory().unwrap();
        let dir = tmp_dir("single");

        let r = run_backup(&conn, &dir);
        assert!(r.ok, "{:?}", r.error);

        let file = dir.join(r.file.unwrap());
        assert!(file.exists());
        // 恢复说明写的是「把这一个 .db 复制回去」，得字面成立
        assert!(!dir.join("ledger.db-wal").exists());
        for entry in fs::read_dir(&dir).unwrap() {
            let name = entry.unwrap().file_name().to_string_lossy().into_owned();
            assert!(name.ends_with(".db"), "备份目录里混进了：{name}");
        }
        assert!(verify_backup(&file).ok);

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn 损坏的文件校验不通过() {
        let dir = tmp_dir("broken");
        let path = dir.join("坏的.db");
        fs::write(&path, "这不是一个 SQLite 文件").unwrap();
        assert!(!verify_backup(&path).ok, "坏文件必须验不过");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn 空库虽然完整但不算有效备份() {
        // 一个空但「完整」的库同样没用 —— 它让老板以为自己有后路
        let dir = tmp_dir("empty");
        let path = dir.join("空的.db");
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch("CREATE TABLE 随便 (a INTEGER); PRAGMA journal_mode = DELETE;")
                .unwrap();
        }
        let v = verify_backup(&path);
        assert!(!v.ok);
        assert!(v.detail.contains("sales"), "{}", v.detail);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn 没有备份时状态就是该标红() {
        let dir = tmp_dir("status");
        let s = backup_status(&dir).unwrap();
        assert_eq!(s.count, 0);
        assert!(s.stale, "一份都没有时必须是标红状态");
        assert_eq!(s.last_backup_file, None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn 同一天重复备份只留一份() {
        let conn = open_memory().unwrap();
        let dir = tmp_dir("twice");
        assert!(run_backup(&conn, &dir).ok);
        assert!(run_backup(&conn, &dir).ok);
        assert_eq!(list_backups(&dir).unwrap().len(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }
}
