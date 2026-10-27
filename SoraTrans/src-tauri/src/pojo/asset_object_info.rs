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
    /// 该对象是否已有改动（有非空译文或纹理补丁）——制作补丁时会写进资源文件。
    /// 由数据库实时统计，重开应用后仍然有效。
    is_mod: i64,
}