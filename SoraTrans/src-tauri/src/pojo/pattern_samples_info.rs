use serde::{Deserialize, Serialize};

/// 一个 pattern 分组的送审数据：结构路径 + 去重后的样本文本 + 该组整体规模。
///
/// total / jp_count 是"这组一共有多少行、其中多少行含非 ASCII（日文）字符"。
/// 只看 10 条样本时，上万行的混合分组很容易被误判（样本全噪声就判成不可本地化，
/// 样本全日文就判成可本地化）；带上整体比例，模型才能判断这组到底是不是混合组。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PatternSamplesInfo {
    pub id: i64,
    pub semantic: String,
    /// 该 pattern 在库中的文本行总数（去重后）
    pub total: i64,
    /// 其中含非 ASCII 字符（日文假名/汉字等）的行数
    pub jp_count: i64,
    pub samples: Vec<String>,
}
