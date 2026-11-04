use serde::{Deserialize, Serialize};
use sqlx::prelude::FromRow;

/// 待 AI 判定的文本条目：文本本体 + 判定所需的上下文
#[derive(Debug, Deserialize, Serialize, FromRow, Clone)]
pub struct JudgeTargetInfo {
    pub id: i64,
    pub object_id: i64,
    pub object_name: String,
    pub object_type: String,
    pub semantic: String,
    pub field_path: String,
    pub text: String,
}

/// LLM 复审的候选条目：已判定但置信度落在中间区间、且还没被 LLM 复核过的文本
#[derive(Debug, Deserialize, Serialize, FromRow, Clone)]
pub struct ReviewTargetInfo {
    pub id: i64,
    pub object_id: i64,
    pub object_name: String,
    pub object_type: String,
    pub semantic: String,
    pub field_path: String,
    pub text: String,
    /// 决策阶段给出的原始置信度（保留下来，避免复审后丢失）
    pub confidence: f64,
}

/// 单条文本的判定结果（前端判定完成后回传入库）
#[derive(Debug, Deserialize, Serialize, FromRow, Clone)]
pub struct TextJudgeInfo {
    pub origin_id: i64,
    pub object_id: i64,
    pub localizable: i64,
    pub confidence: Option<f64>,
    pub source: String,
    pub checked_by_llm: i64,
    pub reason: Option<String>,
    pub model: Option<String>,
}

/// 按文件（assets_object）聚合的可本地化统计，供资源列表展示
/// total = 该文件文本总条数（来自 text_origin），judged = 已判定条数
#[derive(Debug, Deserialize, Serialize, FromRow, Clone)]
pub struct ObjectJudgeStat {
    pub object_id: i64,
    pub total: i64,
    pub judged: i64,
    pub localizable: i64,
}

/// 判定进度：总文本数 / 已判定数 / 其中可本地化数
#[derive(Debug, Deserialize, Serialize, FromRow, Clone)]
pub struct JudgeProgressInfo {
    pub total: i64,
    pub judged: i64,
    pub localizable: i64,
}

/// 可本地化文本（导出用），带文件归属、再提取模板与已有译文
#[derive(Debug, Deserialize, Serialize, FromRow, Clone)]
pub struct LocalizableTextInfo {
    pub id: i64,
    pub object_id: i64,
    pub object_name: String,
    pub semantic: String,
    pub text: String,
    pub text_template: Option<String>,
    /// 已有译文（无译文时为空串），KV JSON 导出时作为 value
    pub trans_text: String,
}
