use serde::{Deserialize, Deserializer, Serialize};

/// LLM 返回的单个 pattern 识别结果；client 解析与 repo 回写共用。
/// id 兼容数字与字符串（部分模型会把 id 写成字符串）；
/// label / localizable 缺失时给默认值，避免单个畸形元素让整批解析失败。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiResultInfo {
    #[serde(deserialize_with = "de_id")]
    pub id: i64,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub localizable: bool,
}

fn de_id<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    use serde::de::Error;

    let value = serde_json::Value::deserialize(deserializer)?;
    match value {
        serde_json::Value::Number(n) => n
            .as_i64()
            .ok_or_else(|| D::Error::custom("id 不是整数")),
        serde_json::Value::String(s) => s
            .trim()
            .parse::<i64>()
            .map_err(|_| D::Error::custom("id 字符串无法解析为整数")),
        other => Err(D::Error::custom(format!("无法解析 id: {other}"))),
    }
}
