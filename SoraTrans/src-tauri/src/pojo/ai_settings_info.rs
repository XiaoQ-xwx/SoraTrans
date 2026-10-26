use serde::{Deserialize, Serialize};
use sqlx::prelude::FromRow;

/// 主库 ai_settings 单行配置（OpenAI 兼容接口）
#[derive(Debug, Deserialize, Serialize, FromRow, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AiSettingsInfo {
    pub base_url: String,
    pub api_key: String,
    pub model: String,
}
