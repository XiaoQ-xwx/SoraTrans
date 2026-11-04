use serde::{Deserialize, Serialize};
use sqlx::prelude::FromRow;

/// 应用级键值设置项
#[derive(Debug, Deserialize, Serialize, FromRow, Clone)]
pub struct AppSettingInfo {
    pub key: String,
    pub value: String,
}
