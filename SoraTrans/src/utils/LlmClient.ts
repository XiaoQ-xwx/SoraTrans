import { fetch } from '@tauri-apps/plugin-http';
import type { ModelSetting } from './AppSetting';
import { sleep } from './JevClient';

// LLM 复核客户端：OpenAI 兼容 /chat/completions
// 只用来复核 Jev 判不准的中间区间条目（或 Jev 未启用时全量判定），
// 输出约定为纯 JSON，解析失败重试一次。

/// 每次请求带多少条文本去复核
export const LLM_BATCH_SIZE = 10;
const MAX_TEXT_CHARS = 800;
const REQUEST_TIMEOUT_MS = 90000;

export interface LlmReviewItem {
    key: string;
    text: string;
    context: string;
}

export interface LlmReviewResult {
    localizable: number;
    reason: string;
}

/// LLM 作为决策引擎时的结果：score 是"可本地化可能性" 0~1，与 Jev 的 noul 概率同口径
export interface LlmJudgeResult {
    score: number;
    reason: string;
}

/// 按状态码区分是否需要重试，避免 404/401 这类错误白白重试
class LlmError extends Error {
    readonly retryable: boolean;
    constructor(message: string, retryable: boolean) {
        super(message);
        this.retryable = retryable;
    }
}

/// LLM 作为「决策引擎」：一次判 10 条，返回每条的可本地化可能性（0~1）
/// 与 reviewBatchByLlm 的区别只是提问方式与返回字段，HTTP 细节完全一致。
export async function judgeBatchByLlm(
    items: LlmReviewItem[],
    setting: ModelSetting,
): Promise<Map<string, LlmJudgeResult>> {
    if (items.length === 0) return new Map();

    const lines = items.map((item, index) =>
        `${index + 1}. [${item.key}] 出处：${item.context}；文本：${truncate(item.text, MAX_TEXT_CHARS)}`
    );

    const systemPrompt = [
        "你是游戏本地化文本判定助手。",
        "为每条文本给出「可本地化可能性」score（0.0~1.0），请按下面标准校准：",
        "  0.9~1.0：确定是玩家可见、需要翻译的文本；",
        "  0.0~0.1：确定不是（程序标识符、资源路径、纯数字符号、调试信息、内部配置键等）；",
        "  0.3~0.7：拿不准（只含富文本标签/占位符、专有名词、语义残缺、中英混排等）——不要硬给 0 或 1；",
        "score 会被用来分流是否需要二次复核，请如实反映把握程度。",
        '只输出 JSON 对象，格式：{"results":[{"key":"条目key","score":0.0到1.0,"reason":"简述理由"}]}',
        "必须为输入的每一条文本都返回一条结果，不要遗漏。不要输出任何解释性文字。",
    ].join("\n");

    const userPrompt = `待判定文本：\n${lines.join("\n")}`;

    let lastError = "";
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            let res: Response;
            try {
                res = await fetch(buildChatUrl(setting.llm_base_url), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${setting.llm_api_key.trim()}`,
                    },
                    body: JSON.stringify({
                        model: setting.llm_model,
                        temperature: 0,
                        messages: [
                            { role: "system", content: systemPrompt },
                            { role: "user", content: userPrompt },
                        ],
                    }),
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                });
            } catch (e) {
                throw new LlmError(`LLM 网络请求失败：${e instanceof Error ? e.message : String(e)}`, true);
            }

            if (!res.ok) {
                const detail = await res.text().catch(() => "");
                throw new LlmError(
                    describeLlmError(res.status, detail),
                    res.status === 429 || res.status >= 500,
                );
            }

            const data = await res.json() as { choices?: { message?: { content?: string } }[] };
            const content = data.choices?.[0]?.message?.content ?? "";
            const parsed = JSON.parse(extractJson(content)) as {
                results?: { key?: string, score?: number | string, localizable?: number | string, reason?: string }[]
            };
            const result = new Map<string, LlmJudgeResult>();
            for (const row of parsed.results ?? []) {
                if (!row.key) continue;
                const raw = row.score ?? row.localizable;
                const score = typeof raw === "string" ? Number(raw) : raw;
                if (typeof score !== "number" || Number.isNaN(score)) continue;
                result.set(row.key, {
                    score: Math.min(1, Math.max(0, score)),
                    reason: row.reason ?? "",
                });
            }
            if (result.size === 0) {
                throw new LlmError("LLM 返回内容无法解析为判定结果", true);
            }
            return result;
        } catch (e) {
            lastError = e instanceof Error ? e.message : String(e);
            const retryable = e instanceof LlmError ? e.retryable : true;
            if (!retryable || attempt === 2) break;
            await sleep(1000 * Math.pow(2, attempt));
        }
    }
    throw new Error(lastError || "LLM 判定失败");
}

export async function reviewBatchByLlm(
    items: LlmReviewItem[],
    setting: ModelSetting,
): Promise<Map<string, LlmReviewResult>> {
    if (items.length === 0) return new Map();

    const lines = items.map((item, index) =>
        `${index + 1}. [${item.key}] 出处：${item.context}；文本：${truncate(item.text, MAX_TEXT_CHARS)}`
    );

    const systemPrompt = [
        "你是游戏本地化文本判定助手。",
        "判断给定文本是否为玩家可见、需要翻译并回写进游戏的本地化文本。",
        "程序标识符、资源路径、纯数字/符号、调试信息、内部配置键等应判为不可本地化。",
        '只输出 JSON 对象，格式：{"results":[{"key":"条目key","localizable":0或1,"reason":"简述理由"}]}',
        "必须为输入的每一条文本都返回一条结果，不要遗漏。",
        "不要输出任何解释性文字。",
    ].join("\n");

    const userPrompt = `待判定文本：\n${lines.join("\n")}`;

    // 最多 3 次：429/5xx/网络异常指数退避重试，参数类错误直接抛
    let lastError = "";
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            let res: Response;
            try {
                res = await fetch(buildChatUrl(setting.llm_base_url), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${setting.llm_api_key.trim()}`,
                    },
                    body: JSON.stringify({
                        model: setting.llm_model,
                        temperature: 0,
                        messages: [
                            { role: "system", content: systemPrompt },
                            { role: "user", content: userPrompt },
                        ],
                    }),
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                });
            } catch (e) {
                // 网络中断/超时：可重试
                throw new LlmError(`LLM 网络请求失败：${e instanceof Error ? e.message : String(e)}`, true);
            }

            if (!res.ok) {
                const detail = await res.text().catch(() => "");
                throw new LlmError(
                    describeLlmError(res.status, detail),
                    res.status === 429 || res.status >= 500,
                );
            }

            const data = await res.json() as {
                choices?: { message?: { content?: string } }[];
            };
            const content = data.choices?.[0]?.message?.content ?? "";
            return parseReviewContent(content, items);
        } catch (e) {
            lastError = e instanceof Error ? e.message : String(e);
            const retryable = e instanceof LlmError ? e.retryable : true;
            if (!retryable || attempt === 2) break;
            await sleep(1000 * Math.pow(2, attempt));
        }
    }
    throw new Error(lastError || "LLM 复核失败");
}

/// 兼容"只填到 /v1"和"填了完整路径"两种配置，顺带去掉首尾空格与尾部斜杠
function buildChatUrl(baseUrl: string): string {
    const trimmed = baseUrl.trim().replace(/\/+$/, "");
    if (trimmed.endsWith("/chat/completions")) return trimmed;
    return `${trimmed}/chat/completions`;
}

/// 解析模型返回的 JSON；优先取 markdown 围栏，其次退回首尾花括号截取
function parseReviewContent(content: string, items: LlmReviewItem[]): Map<string, LlmReviewResult> {
    const jsonText = extractJson(content);
    const parsed = JSON.parse(jsonText) as {
        results?: { key?: string; localizable?: number | boolean; reason?: string }[]
    };
    const result = new Map<string, LlmReviewResult>();
    for (const item of parsed.results ?? []) {
        if (!item.key) continue;
        const value = item.localizable;
        const flag = typeof value === "boolean" ? (value ? 1 : 0) : Number(value);
        if (Number.isNaN(flag)) continue;
        result.set(item.key, { localizable: flag > 0 ? 1 : 0, reason: item.reason ?? "" });
    }
    // 模型漏答是常态，返回缺答数量给上层记账，别静默当成"复核不可用"
    const missing = items.filter((item) => !result.has(item.key)).length;
    if (missing > 0 && result.size === 0) {
        throw new LlmError(`LLM 返回内容无法解析为判定结果（漏答 ${missing} 条）`, true);
    }
    return result;
}

function extractJson(content: string): string {
    // 先取 markdown 代码围栏里的内容，正文含花括号时更可靠
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content);
    const candidate = fenced ? fenced[1] : content;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) {
        throw new LlmError("LLM 返回内容不是合法 JSON，无法解析复核结果", true);
    }
    return candidate.slice(start, end + 1);
}

function describeLlmError(status: number, detail: string): string {
    switch (status) {
        case 401:
            return "LLM API Key 无效或已过期，请在设置页检查";
        case 403:
            return "LLM 拒绝访问（403），请检查账号权限或模型是否开通";
        case 404:
            return "LLM 接口地址或模型名不存在，请检查设置页配置";
        case 429:
            return "LLM 请求过于频繁，请稍后重试";
        case 422:
        case 400:
            return `LLM 请求参数校验失败：${detail.slice(0, 300)}`;
        default:
            return `LLM 请求失败（${status}）：${detail.slice(0, 200)}`;
    }
}

function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max)}…`;
}
