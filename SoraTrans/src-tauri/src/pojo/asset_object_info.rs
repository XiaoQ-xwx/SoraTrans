use serde::{Deserialize, Serialize};
use sqlx::prelude::FromRow;

#[derive(Debug, Deserialize, Serialize, FromRow, Clone)]
pub struct AssetObjectInfo{
    id: i64,
    name: String,
    r#type: String,
    path_id: i64,
    size: i64,
    line_count: i64,
    /// 该对象下 AI 判定为可本地化的文本行数（未识别/无则可本地化文本为 0）
    localizable_lines: i64,
}