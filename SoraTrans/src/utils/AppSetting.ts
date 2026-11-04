import { invoke } from "@tauri-apps/api/core";

// 模型配置：Jev 决策模型与 LLM 模型都允许指向任意第三方端点，
// 只要协议兼容即可（Jev = /systemone，LLM = OpenAI 兼容 /chat/completions）。
// 配置存在主库 app_setting 表（key = "model_setting"），不写进前端产物。

/// 判定模式：只区分"用谁做决策"。复审是单独的手动开关（用 LLM）。
export type JudgeMode = "jev" | "llm";

export const JUDGE_MODES: { value: JudgeMode, label: string }[] = [
    { value: "jev", label: "Jev 决策" },
    { value: "llm", label: "LLM 决策" },
];

/// 决策阶段是否用 Jev
export function modeUsesJev(mode: JudgeMode): boolean {
    return mode === "jev";
}

/// 是否需要 LLM（决策或复审任一环节）
export function modeUsesLlm(setting: ModelSetting): boolean {
    return setting.judge_mode === "llm" || setting.llm_review;
}

export interface ModelSetting {
    judge_mode: JudgeMode;
    // 是否启用 LLM 复审（手动开关，判定弹窗里可以覆盖）
    llm_review: boolean;
    // Jev 决策模型（结构化决策，输出概率，不做文本生成）
    jev_base_url: string;
    jev_api_key: string;
    jev_model: string;
    // LLM 模型（OpenAI 兼容），可做决策引擎，也可做复审
    llm_base_url: string;
    llm_api_key: string;
    llm_model: string;
    // 并发请求数（Jev 侧限流 120 次/分钟/key，别开太大）
    concurrency: number;
    // 置信度阈值：>= high 判为可本地化；<= low 判为不可；(low, high) 之间交给复审
    threshold_high: number;
    threshold_low: number;
}

export const DEFAULT_MODEL_SETTING: ModelSetting = {
    judge_mode: "jev",
    llm_review: false,
    jev_base_url: "https://jevmodel.org/v1",
    jev_api_key: "",
    jev_model: "jev-latest",
    llm_base_url: "https://api.openai.com/v1",
    llm_api_key: "",
    llm_model: "gpt-4o-mini",
    concurrency: 10,
    threshold_high: 0.7,
    threshold_low: 0.3,
};

const SETTING_KEY = "model_setting";

/// 读取模型配置；没存过则返回默认值
export async function loadModelSetting(): Promise<ModelSetting> {
    const list = await invoke<{ key: string, value: string }[]>("select_app_settings");
    const row = list.find((item) => item.key === SETTING_KEY);
    if (!row) return { ...DEFAULT_MODEL_SETTING };
    try {
        const parsed = JSON.parse(row.value) as Partial<ModelSetting> & {
            jev_enabled?: boolean;
            llm_enabled?: boolean;
            judge_mode?: string;
        };
        // 兼容历史配置：
        //   旧版 jev_enabled/llm_enabled 两个开关 -> 判定模式 + 复审开关
        //   上一版四档模式 jev_llm / llm_llm -> 决策 + 复审
        const rawMode = parsed.judge_mode as string | undefined;
        if (rawMode === "jev_llm") {
            parsed.judge_mode = "jev";
            parsed.llm_review = true;
        } else if (rawMode === "llm_llm") {
            parsed.judge_mode = "llm";
            parsed.llm_review = true;
        } else if (!rawMode) {
            if (parsed.jev_enabled !== undefined || parsed.llm_enabled !== undefined) {
                parsed.judge_mode = parsed.jev_enabled ? "jev" : "llm";
                parsed.llm_review = Boolean(parsed.jev_enabled && parsed.llm_enabled);
            }
        }
        if (parsed.judge_mode !== "jev" && parsed.judge_mode !== "llm") {
            parsed.judge_mode = "jev";
        }
        return { ...DEFAULT_MODEL_SETTING, ...parsed } as ModelSetting;
    } catch {
        // 配置损坏时回落到默认值，避免整个页面崩掉
        return { ...DEFAULT_MODEL_SETTING };
    }
}

/// 保存模型配置
export async function saveModelSetting(setting: ModelSetting): Promise<void> {
    await invoke("save_app_settings", {
        list: [{ key: SETTING_KEY, value: JSON.stringify(setting) }],
    });
}

/// 校验配置是否可执行判定；返回 null 表示可用，否则返回中文原因
export function validateModelSetting(setting: ModelSetting): string | null {
    if (modeUsesJev(setting.judge_mode)) {
        if (!setting.jev_base_url.trim()) return "Jev 接口地址不能为空";
        if (!setting.jev_api_key.trim()) return "Jev API Key 不能为空";
    }
    if (modeUsesLlm(setting)) {
        if (!setting.llm_base_url.trim()) return "LLM 接口地址不能为空";
        if (!setting.llm_api_key.trim()) return "LLM API Key 不能为空";
    }
    if (!Number.isFinite(setting.threshold_high) || !Number.isFinite(setting.threshold_low)) {
        return "置信度阈值必须是数字";
    }
    if (setting.threshold_low < 0 || setting.threshold_high > 1) {
        return "置信度阈值必须在 0~1 之间";
    }
    if (setting.threshold_low >= setting.threshold_high) {
        return "置信度阈值配置错误：低阈值必须小于高阈值";
    }
    if (!Number.isFinite(setting.concurrency) || setting.concurrency < 1 || setting.concurrency > 32) {
        return "并发数必须在 1~32 之间";
    }
    return null;
}
