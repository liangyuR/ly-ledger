//! 错误类型。
//!
//! HTTP 时代错误是 `{ ok: false, error: "人话" }` + 一个状态码，而前端从来
//! 只读那句人话（`ApiError.message`），状态码没有任何一处分支用到。所以这里
//! 不保留状态码 —— invoke 失败时直接把那句话扔回去。
//!
//! **错误信息是给柜台后面那个人看的。** 不出现表名、字段名、Rust 类型名。

use std::fmt;

#[derive(Debug)]
pub struct AppError(pub String);

impl AppError {
    pub fn new(msg: impl Into<String>) -> Self {
        AppError(msg.into())
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for AppError {}

/// invoke 的错误通道只认 Serialize。序列化成**裸字符串**，
/// 前端 `ApiError(String(err))` 就能还原成原来那句话。
impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        // 数据库原文对老板没有意义，但排查时又必须留着 —— 折中：
        // 前缀给人话，原文附在后面，出问题时截图里带得走。
        AppError(format!("数据出错了：{e}"))
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError(format!("读写文件失败：{e}"))
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError(format!("数据格式不对：{e}"))
    }
}

impl From<rust_xlsxwriter::XlsxError> for AppError {
    fn from(e: rust_xlsxwriter::XlsxError) -> Self {
        AppError(format!("生成表格失败：{e}"))
    }
}

pub type Result<T> = std::result::Result<T, AppError>;

/// `bail!("商品不存在：{id}")`
#[macro_export]
macro_rules! bail {
    ($($arg:tt)*) => {
        return Err($crate::error::AppError::new(format!($($arg)*)))
    };
}

/// `ensure!(qty > 0, "数量必须为正")`
#[macro_export]
macro_rules! ensure {
    ($cond:expr, $($arg:tt)*) => {
        if !($cond) {
            return Err($crate::error::AppError::new(format!($($arg)*)));
        }
    };
}
