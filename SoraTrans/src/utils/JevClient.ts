import { fetch } from '@tauri-apps/plugin-http';
import type { ModelSetting } from './AppSetting';

// Jev（TypeSafe System One 决策模型）客户端
// 协议要点（jevmodel.org/v1/systemone，第三方兼容端点需一致）：
//   POST { model, state, questions }
//   questions 为 name -> { type: "noul"|"choice"|"score", instructions, criteria }
//   一次最多 8 个问题；instructions <= 1800 字符；限流 120 次/分钟
//   响应 { answers: { name: { type: "noul", noul: 0.93 } }, usage: { input_tokens } }
// 计费注意：state 会按"每个问题各计一次"计费，所以条目文本必须放在各题的
// instructions 里，state 只放极短的公共说明，否则同一批文本被重复计费 8 倍。

/// 每个请求最多能问的问题数（Jev 硬限制）
export const JEV_MAX_QUESTIONS = 8;
/// instructions 的硬上限：协议允许 1800，这里留 200 余量给提示语
const MAX_INSTRUCTIONS = 1600;
/// 单次请求超时，避免端点挂起时判定无限期卡住
const REQUEST_TIMEOUT_MS = 60000;
/// 公共上下文，保持极短（它会被每题重复计费）
const STATE_HINT = "任务：判断给定文本是否为游戏内玩家可见、需要翻译并回写的本地化文本。";

export interface JudgeQuestionItem {
    // 用文本条目 id 作为问题标识
    key: string;
    // 待判定文本
    text: string;
    // 出处（文件名 / 字段语义 / 字段路径）
    context: string;
}

class RetryableError extends Error {}

/// 单条文本的可本地化概率（0~1）
export async function judgeBatchByJev(
    items: JudgeQuestionItem[],
    setting: ModelSetting,
): Promise<Map<string, number>> {
    if (items.length === 0) return new Map();
    if (items.length > JEV_MAX_QUESTIONS) {
        throw new Error(`Jev 单次最多 ${JEV_MAX_QUESTIONS} 个问题，当前 ${items.length} 个`);
    }

    // 用批次内容生成 Idempotency-Key：同一批内容重试/重跑都命中同一条计费记录。
    // 注意只在重试窗口内有效——换了内容自然会换 key。
    const idempotencyKey = hashKey(items);
    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            return await requestOnce(items, setting, idempotencyKey);
        } catch (e) {
            if (e instanceof RetryableError && attempt < maxAttempts - 1) {
                // 429 限流 / 5xx / 网络异常：指数退避后重试
                await sleep(1000 * Math.pow(2, attempt));
                continue;
            }
            throw e instanceof Error ? e : new Error(String(e));
        }
    }
    throw new Error("Jev 请求失败：重试次数已用尽");
}

async function requestOnce(
    items: JudgeQuestionItem[],
    setting: ModelSetting,
    idempotencyKey: string,
): Promise<Map<string, number>> {
    const questions: Record<string, unknown> = {};
    for (const item of items) {
        questions[`q_${item.key}`] = {
            type: "noul",
            // 拼完再整体硬截断，防止超长 field_path / object_name 顶穿 1800 触发 422
            instructions: truncate(
                `判定这条游戏文本是否属于"应该翻译并回写"的本地化文本。出处：${item.context}。文本：${item.text}`,
                MAX_INSTRUCTIONS,
            ),
            criteria: {
                true: "玩家可见、需要翻译的文本",
                false: "程序标识符、资源路径、纯数字符号、调试信息等不需要翻译的内容",
            },
        };
    }

    let res: Response;
    try {
        res = await fetch(normalizeUrl(setting.jev_base_url), {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${setting.jev_api_key.trim()}`,
                'Idempotency-Key': idempotencyKey,
            },
            body: JSON.stringify({
                model: setting.jev_model || "jev-latest",
                state: STATE_HINT,
                questions,
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch (e) {
        // 网络中断 / 超时都按可重试处理
        throw new RetryableError(`Jev 网络请求失败：${e instanceof Error ? e.message : String(e)}`);
    }

    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        if (res.status === 429 || res.status >= 500) {
            throw new RetryableError(`Jev 请求失败（${res.status}）：${detail.slice(0, 200)}`);
        }
        throw new Error(describeJevError(res.status, detail));
    }

    const data = await res.json() as {
        answers?: Record<string, { noul?: number }>;
    };

    const result = new Map<string, number>();
    for (const item of items) {
        const answer = data.answers?.[`q_${item.key}`];
        if (answer && typeof answer.noul === "number") {
            result.set(item.key, answer.noul);
        }
    }
    return result;
}

function describeJevError(status: number, detail: string): string {
    switch (status) {
        case 401:
            return "Jev API Key 无效或已吊销，请在设置页检查";
        case 402:
            return "Jev 账户余额不足，请充值后重试";
        case 422:
            return `Jev 请求参数校验失败：${detail.slice(0, 300)}`;
        default:
            return `Jev 请求失败（${status}）：${detail.slice(0, 200)}`;
    }
}

/// 归一化用户填写的端点并补上决策接口路径。
/// 用户通常只填到 /v1（与 LLM 共用同一个网关地址），
/// Jev 的实际端点是 /v1/systemone，这里自动补齐；填了完整路径就原样用。
function normalizeUrl(raw: string): string {
    const base = raw.trim().replace(/\/+$/, "");
    if (base.endsWith("/systemone")) return base;
    if (base.endsWith("/decisions")) return base;
    return `${base}/systemone`;
}

/// 用批次内容生成稳定的幂等键（djb2 哈希，长度远小于 100 字符上限）
function hashKey(items: JudgeQuestionItem[]): string {
    const raw = items.map((item) => `${item.key}:${item.text}`).join("|");
    let hash = 5381;
    for (let i = 0; i < raw.length; i++) {
        hash = ((hash << 5) + hash + raw.charCodeAt(i)) | 0;
    }
    return `soratrans-${items.length}-${(hash >>> 0).toString(36)}`;
}

function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    return `${text.slice(0, max)}…`;
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
