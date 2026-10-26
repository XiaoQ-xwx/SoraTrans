use serde::{Deserialize, Serialize};
use sqlx::prelude::FromRow;

/// 导出用的文本行：id + 原文 + 已有译文（可能为空）
#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct ExportTextInfo {
    pub id: i64,
    pub origin_text: String,
    pub trans_text: Option<String>,
    /// 长文本"再提取"模板；有值时导出应按占位符拆分、导入按模板拼回
    pub text_template: Option<String>,
    /// 所属资源文件名（TextAsset 名等），用于按文件拆分导出
    pub asset_name: Option<String>,
}

/// 以原文为键的导入项（LinguaGacha KV-JSON 回填）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextPairInfo {
    pub origin_text: String,
    pub trans_text: String,
}

/// 以 id 为键的导入项（SoraTrans 自有 CSV 回填）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdPairInfo {
    pub id: i64,
    pub trans_text: String,
}
