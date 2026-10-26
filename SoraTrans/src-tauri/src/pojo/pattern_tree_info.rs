use serde::{Deserialize, Serialize};
use sqlx::prelude::FromRow;

#[derive(Debug, Deserialize, Serialize, FromRow, Clone)]
pub struct PatternTreeInfo{
    id: i64,
    semantic: String,
    count: i64,
    /// AI 标注的语义分类，未识别时为 NULL
    ai_label: Option<String>,
    /// AI 判定的可本地化标记：1 可 / 0 不可 / NULL 未识别
    localizable: Option<i64>,
}
