use serde::{Deserialize, Serialize};
use sqlx::prelude::FromRow;

/// 导入译文时的"原文 -> 译文"对（KV JSON / 按原文匹配回写用）
#[derive(Debug, Deserialize, Serialize, FromRow, Clone)]
pub struct TextPairInfo {
    pub src: String,
    pub dst: String,
}
