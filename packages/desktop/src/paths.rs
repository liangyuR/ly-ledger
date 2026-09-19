//! 数据放在哪。
//!
//! Node 版是便携包：整个目录可整体拷走，数据库就在包里的 `data/ledger.db`。
//! 那条承诺不能因为换了 Tauri 就作废 —— docs/06 那页纸上写着「把这一个 .db
//! 复制回去」，它得字面成立。
//!
//! 所以优先用 **exe 同级目录**（便携模式）。只有当那个目录写不进去
//! （比如被装进了 Program Files）才退到系统的应用数据目录。
//!
//! 一切相对路径按这里解析，**不按当前工作目录** —— cwd 取决于谁怎么启动的，
//! 双击图标和从任务计划里拉起就不是同一个值。这条在 Node 版踩到过。

use std::fs;
use std::path::{Path, PathBuf};

/// 覆盖数据目录用的环境变量。给「我想把数据放 D 盘」和测试留的口子。
const ENV_OVERRIDE: &str = "LY_LEDGER_DATA";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootKind {
    /// exe 同级，整个文件夹可以拷走
    Portable,
    /// 退路：系统应用数据目录
    AppData,
    /// 环境变量指定
    Override,
}

#[derive(Debug, Clone)]
pub struct Root {
    pub dir: PathBuf,
    pub kind: RootKind,
}

impl RootKind {
    /// 给人看的一句话。店主问「我的账存哪了」时，自检页要答得上
    pub fn label(self) -> &'static str {
        match self {
            RootKind::Portable => "便携模式（数据就在程序旁边，整个文件夹拷走即可换机）",
            RootKind::AppData => "程序目录写不进去，数据放在了系统的应用数据目录",
            RootKind::Override => "由 LY_LEDGER_DATA 指定",
        }
    }
}

impl Root {
    pub fn db_file(&self) -> PathBuf {
        self.dir.join("data").join("ledger.db")
    }

    pub fn backup_dir(&self) -> PathBuf {
        self.dir.join("backup")
    }
}

/// 决定数据根目录。`fallback` 是系统应用数据目录（由 Tauri 给出）。
pub fn resolve(fallback: PathBuf) -> Root {
    if let Some(dir) = std::env::var_os(ENV_OVERRIDE) {
        let dir = PathBuf::from(dir);
        return Root {
            dir,
            kind: RootKind::Override,
        };
    }

    if let Some(exe_dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        if writable(&exe_dir) {
            return Root {
                dir: exe_dir,
                kind: RootKind::Portable,
            };
        }
    }

    Root {
        dir: fallback,
        kind: RootKind::AppData,
    }
}

/// 能不能在这个目录里建出 `data/` 并写进东西。
///
/// 只看权限位不够：Windows 的 Program Files 有「虚拟化重定向」，
/// 写入看起来成功，文件却落到了别处，老板事后在包里找不到自己的账。
/// 所以真的建一个文件再删掉。
fn writable(dir: &Path) -> bool {
    let probe_dir = dir.join("data");
    if fs::create_dir_all(&probe_dir).is_err() {
        return false;
    }
    let probe = probe_dir.join(".write-probe");
    match fs::write(&probe, b"ok") {
        Ok(()) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 环境变量优先于一切() {
        // 串行跑的单测里改环境变量是安全的；这里只验证优先级分支
        let tmp = std::env::temp_dir().join("ly-ledger-root-test");
        std::env::set_var(ENV_OVERRIDE, &tmp);
        let r = resolve(PathBuf::from("不该用到"));
        std::env::remove_var(ENV_OVERRIDE);
        assert_eq!(r.kind, RootKind::Override);
        assert_eq!(r.dir, tmp);
    }

    #[test]
    fn 数据库和备份都挂在根目录下() {
        let r = Root {
            dir: PathBuf::from("C:/烟酒台账"),
            kind: RootKind::Portable,
        };
        assert!(r.db_file().ends_with("data/ledger.db") || r.db_file().ends_with("data\\ledger.db"));
        assert!(r.backup_dir().ends_with("backup"));
    }
}
