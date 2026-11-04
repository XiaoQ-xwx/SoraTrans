import { fetch } from '@tauri-apps/plugin-http';
import type { ModelSetting } from './AppSetting';

// 模型目录与连通性探测：设置页的「获取模型」「测试连接」都走这里。
// 与判定链路共用同一套 URL 归一化规则，避免"设置里能测通、判定却报错"。

export interface ProbeResult {
    ok: boolean;
    message: string;
}

/// 归一化成 API 根：去掉用户可能已经带上的端点后缀与尾部斜杠
export function apiRoot(raw: string): string {
    let base = raw.trim().replace(/\/+$/, "");
    base = base
        .replace(/\/systemone$/i, "")
        .replace(/\/chat\/completions$/i, "")
        .replace(/\/decisions$/i, "");
    return base.replace(/\/+$/, "");
}

/// 决策模型端点：根 + /systemone（用户通常只填到 /v1）
export function jevEndpoint(raw: string): string {
    return `${apiRoot(raw)}/systemone`;
}

/// 复核模型端点：根 + /chat/completions
export function llmEndpoint(raw: string): string {
    return `${apiRoot(raw)}/chat/completions`;
}

/// 拉取模型列表（GET {root}/models）
export async function fetchModelList(rawBase: string, apiKey: string): Promise<string[]> {
    const url = `${apiRoot(rawBase)}/models`;
    let res: Response;
    try {
        res = await fetch(url, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${apiKey.trim()}` },
            signal: AbortSignal.timeout(30000),
        });
    } catch (e) {
        throw new Error(`无法连接 ${url}：${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(describeHttp(res.status, detail));
    }
    const data = await res.json() as { data?: unknown, models?: unknown } | unknown[];
    const raw = Array.isArray(data)
        ? data
        : Array.isArray((data as { data?: unknown }).data)
            ? (data as { data: unknown[] }).data
            : Array.isArray((data as { models?: unknown }).models)
                ? (data as { models: unknown[] }).models
                : [];
    const ids = raw
        .map((item) => (typeof item === "string" ? item : (item as { id?: unknown })?.id))
        .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length === 0) {
        throw new Error("接口没有返回任何模型（检查地址是否为 OpenAI 兼容的 /v1）");
    }
    return [...new Set(ids)];
}

/// 测试决策模型：发一个最小 noul 问题，返回概率与耗时
export async function testJev(setting: ModelSetting): Promise<ProbeResult> {
    const url = jevEndpoint(setting.jev_base_url);
    const started = Date.now();
    let res: Response;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${setting.jev_api_key.trim()}`,
            },
            body: JSON.stringify({
                model: setting.jev_model || "jev-latest",
                state: "连接测试",
                questions: {
                    q_test: {
                        type: "noul",
                        instructions: "这条文本是否需要翻译成中文：こんにちは、勇者よ。",
                    },
                },
            }),
            signal: AbortSignal.timeout(60000),
        });
    } catch (e) {
        return { ok: false, message: `无法连接：${e instanceof Error ? e.message : String(e)}` };
    }
    const elapsed = Date.now() - started;
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return { ok: false, message: describeHttp(res.status, detail) };
    }
    const data = await res.json() as { answers?: Record<string, { noul?: number }>, usage?: { input_tokens?: number } };
    const probability = data.answers?.q_test?.noul;
    if (typeof probability !== "number") {
        return { ok: false, message: `响应里没有 noul 概率，可能不是决策模型端点：${JSON.stringify(data).slice(0, 160)}` };
    }
    const tokens = data.usage?.input_tokens;
    return {
        ok: true,
        message: `连接成功 · ${elapsed}ms · 示例概率 ${probability.toFixed(2)}${tokens ? ` · ${tokens} tokens` : ""}`,
    };
}

/// 测试复核模型：发一句最小对话，返回内容与耗时
export async function testLlm(setting: ModelSetting): Promise<ProbeResult> {
    const url = llmEndpoint(setting.llm_base_url);
    const started = Date.now();
    let res: Response;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${setting.llm_api_key.trim()}`,
            },
            body: JSON.stringify({
                model: setting.llm_model,
                temperature: 0,
                messages: [{ role: "user", content: "只回复两个字：收到" }],
            }),
            signal: AbortSignal.timeout(90000),
        });
    } catch (e) {
        return { ok: false, message: `无法连接：${e instanceof Error ? e.message : String(e)}` };
    }
    const elapsed = Date.now() - started;
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        return { ok: false, message: describeHttp(res.status, detail) };
    }
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content ?? "";
    return { ok: true, message: `连接成功 · ${elapsed}ms · 回复「${content.trim().slice(0, 30)}」` };
}

function describeHttp(status: number, body: string): string {
    const brief = body.replace(/\s+/g, " ").slice(0, 200);
    switch (status) {
        case 401: return `401 认证失败：API Key 无效或已过期${brief ? `（${brief}）` : ""}`;
        case 403: return "403 拒绝访问：检查账号权限或模型是否开通";
        case 404: return "404 地址或模型不存在：检查接口地址与模型名";
        case 429: return "429 请求过于频繁：稍后重试";
        default: return `HTTP ${status}${brief ? `：${brief}` : ""}`;
    }
}
