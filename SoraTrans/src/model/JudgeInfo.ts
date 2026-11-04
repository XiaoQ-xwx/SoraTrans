// AI 可本地化判定相关的数据结构（与 src-tauri/src/pojo/judge_info.rs 一一对应）

/// 待判定文本条目：文本本体 + 判定上下文
export interface JudgeTargetInfo {
    id: number;
    object_id: number;
    object_name: string;
    object_type: string;
    semantic: string;
    field_path: string;
    text: string;
}

/// LLM 复审候选：已判定但置信度落在中间区间、且还没被复核过的条目
export interface ReviewTargetInfo {
    id: number;
    object_id: number;
    object_name: string;
    object_type: string;
    semantic: string;
    field_path: string;
    text: string;
    // 决策阶段给出的原始置信度，复审后保留
    confidence: number;
}

/// 单条判定结果，回传给后端入库
export interface TextJudgeInfo {
    origin_id: number;
    object_id: number;
    localizable: number;
    confidence: number | null;
    // jev = 决策模型判定；llm = LLM 复核判定
    source: string;
    checked_by_llm: number;
    reason: string | null;
    model: string | null;
}

/// 按文件聚合的可本地化统计
/// total = 该文件文本总条数，judged = 已判定条数
export interface ObjectJudgeStat {
    object_id: number;
    total: number;
    judged: number;
    localizable: number;
}

/// 判定总进度
export interface JudgeProgressInfo {
    total: number;
    judged: number;
    localizable: number;
}

/// 可本地化文本（导出用）
export interface LocalizableTextInfo {
    id: number;
    object_id: number;
    object_name: string;
    semantic: string;
    text: string;
    text_template: string | null;
    // 已有译文（无译文时为空串），KV JSON 导出时作为 value
    trans_text: string;
}
