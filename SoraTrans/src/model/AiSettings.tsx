export interface AiSettings {
    baseUrl: string,
    apiKey: string,
    model: string,
}

// 识别进度事件 ai-recognition-progress 的载荷
export interface AiProgress {
    done: number,
    total: number,
    failedBatches: number,
    finished: boolean,
    error: string | null,
}

// 一次识别任务的汇总
export interface AiRunSummary {
    totalPatterns: number,
    updated: number,
    failedBatches: number,
    cancelled: boolean,
    lastError: string | null,
}
