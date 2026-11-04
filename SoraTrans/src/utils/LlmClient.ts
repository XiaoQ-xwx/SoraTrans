import { fetch } from '@tauri-apps/plugin-http';
import type { ModelSetting } from './AppSetting';
import { sleep } from './JevClient';

// LLM 决策客户端：OpenAI 兼容 /chat/completions
// 作为判定引擎使用时输出每条的"可本地化可能性"（0~1），
// 输出约定为纯 JSON，解析失败重试一次。

/// 每次请求带多少条文本去判定
export const LLM_BATCH_SIZE = 10;
const MAX_TEXT_CHARS = 800;
const REQUEST_TIMEOUT_MS = 90000;

export interface LlmJudgeItem {
    key: string;
    text: string;
    context: string;
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
export async function judgeBatchByLlm(
    items: LlmJudgeItem[],
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
        "score 请如实反映把握程度，拿不准的不要硬给 0 或 1。",
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
                results?: { key?: string, score?: number | string, reason?: string }[]
            };
            const result = new Map<string, LlmJudgeResult>();
            for (const row of parsed.results ?? []) {
                if (!row.key) continue;
                const raw = row.score;
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

/// 兼容"只填到 /v1"和"填了完整路径"两种配置，顺带去掉首尾空格与尾部斜杠
function buildChatUrl(baseUrl: string): string {
    const trimmed = baseUrl.trim().replace(/\/+$/, "");
    if (trimmed.endsWith("/chat/completions")) return trimmed;
    return `${trimmed}/chat/completions`;
}

/// 解析模型返回的 JSON；优先取 markdown 围栏，其次退回首尾花括号截取
function extractJson(content: string): string {
    // 先取 markdown 代码围栏里的内容，正文含花括号时更可靠
    const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content);
    const candidate = fenced ? fenced[1] : content;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) {
        throw new LlmError("LLM 返回内容不是合法 JSON，无法解析判定结果", true);
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
