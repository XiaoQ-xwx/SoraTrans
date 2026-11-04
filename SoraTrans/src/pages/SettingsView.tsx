import { DEFAULT_MODEL_SETTING, loadModelSetting, saveModelSetting } from "@/utils/AppSetting";
import type { ModelSetting } from "@/utils/AppSetting";
import { fetchModelList, testJev, testLlm } from "@/utils/ModelProbe";
import type { ProbeResult } from "@/utils/ModelProbe";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

// 设置页：配置 AI 判定用的模型。
// Jev 决策模型与 LLM 决策模型都支持第三方端点，只要协议兼容：
//   Jev -> POST {root}/systemone，body 为 state + questions
//   LLM -> POST {root}/chat/completions（OpenAI 兼容）
// 「获取模型」拉 /v1/models 列表，「测试连接」发一个最小请求验证 Key 与模型名。
export default function SettingsView() {

    const [setting, setSetting] = useState<ModelSetting>(DEFAULT_MODEL_SETTING);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [tip, setTip] = useState("");

    // 模型列表与连通性探测状态
    const [models, setModels] = useState<string[]>([]);
    const [modelError, setModelError] = useState("");
    const [fetchingJev, setFetchingJev] = useState(false);
    const [fetchingLlm, setFetchingLlm] = useState(false);
    const [testingJev, setTestingJev] = useState(false);
    const [testingLlm, setTestingLlm] = useState(false);
    const [jevProbe, setJevProbe] = useState<ProbeResult | null>(null);
    const [llmProbe, setLlmProbe] = useState<ProbeResult | null>(null);

    useEffect(() => {
        loadModelSetting()
            .then((val) => setSetting(val))
            .catch(() => setTip("读取配置失败"))
            .finally(() => setLoading(false));
    }, []);

    const update = <K extends keyof ModelSetting>(key: K, value: ModelSetting[K]) => {
        setSetting((prev) => ({ ...prev, [key]: value }));
        setTip("");
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            await saveModelSetting(setting);
            setTip("已保存");
        } catch (e) {
            setTip(`保存失败：${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setSaving(false);
        }
    };

    // 获取模型列表：用对应卡片的地址与 Key
    const handleFetchModels = async (kind: "jev" | "llm") => {
        setModelError("");
        const base = kind === "jev" ? setting.jev_base_url : setting.llm_base_url;
        const key = kind === "jev" ? setting.jev_api_key : setting.llm_api_key;
        if (!base.trim()) { setModelError("请先填写接口地址"); return; }
        if (!key.trim()) { setModelError("请先填写 API Key"); return; }
        if (kind === "jev") setFetchingJev(true); else setFetchingLlm(true);
        try {
            const list = await fetchModelList(base, key);
            // 两个卡片共用一份列表，方便把同一个网关下的模型分派给两种决策模式
            setModels((prev) => [...new Set([...prev, ...list])]);
        } catch (e) {
            setModelError(e instanceof Error ? e.message : String(e));
        } finally {
            if (kind === "jev") setFetchingJev(false); else setFetchingLlm(false);
        }
    };

    const handleTest = async (kind: "jev" | "llm") => {
        if (kind === "jev") {
            setTestingJev(true);
            setJevProbe(null);
            try {
                setJevProbe(await testJev(setting));
            } finally {
                setTestingJev(false);
            }
        } else {
            setTestingLlm(true);
            setLlmProbe(null);
            try {
                setLlmProbe(await testLlm(setting));
            } finally {
                setTestingLlm(false);
            }
        }
    };

    // 把某个模型指派为 Jev 决策模型或 LLM 决策模型
    const assignModel = (model: string, target: "jev" | "llm") => {
        if (target === "jev") {
            setSetting((prev) => ({ ...prev, jev_model: model, jev_enabled: true }));
            setJevProbe(null);
        } else {
            setSetting((prev) => ({ ...prev, llm_model: model, llm_enabled: true }));
            setLlmProbe(null);
        }
        setTip(`已将 ${model} 设为${target === "jev" ? "Jev" : "LLM"} 决策模型`);
    };

    if (loading) {
        return <div className="p-6 text-xs text-neutral-400">正在读取配置…</div>;
    }

    return (
        <div className="h-full w-full overflow-y-auto px-6 py-4">
            <div className="flex flex-col gap-3">
                <Card
                    title="Jev 决策模型"
                    desc="结构化决策模型，输出概率而不生成文本；按阈值直接判定可本地化文本"
                    footer={
                        <ActionRow
                            onFetch={() => handleFetchModels("jev")}
                            onTest={() => handleTest("jev")}
                            fetching={fetchingJev}
                            testing={testingJev}
                            probe={jevProbe}
                        />
                    }
                >
                    <Field label="接口地址" hint="填到 /v1 即可，程序自动补 /systemone">
                        <input
                            value={setting.jev_base_url}
                            onChange={(e) => update("jev_base_url", e.target.value)}
                            className={inputClass}
                            placeholder="https://jevmodel.org/v1"
                        />
                    </Field>
                    <Field label="API Key" hint="存在本地数据库，不会写入前端产物">
                        <input
                            type="password"
                            value={setting.jev_api_key}
                            onChange={(e) => update("jev_api_key", e.target.value)}
                            className={inputClass}
                            placeholder="sk-..."
                        />
                    </Field>
                    <Field label="模型名" hint="可手填，也可点「获取模型」后从候选里选">
                        <input
                            list="soratrans-models"
                            value={setting.jev_model}
                            onChange={(e) => update("jev_model", e.target.value)}
                            className={inputClass}
                            placeholder="jev-latest"
                        />
                    </Field>
                </Card>

                <Card
                    title="LLM 决策模型"
                    desc="OpenAI 兼容的普通对话模型，作为判定引擎输出可本地化可能性"
                    footer={
                        <ActionRow
                            onFetch={() => handleFetchModels("llm")}
                            onTest={() => handleTest("llm")}
                            fetching={fetchingLlm}
                            testing={testingLlm}
                            probe={llmProbe}
                        />
                    }
                >
                    <Field label="接口地址" hint="填到 /v1 即可，程序会拼 /chat/completions">
                        <input
                            value={setting.llm_base_url}
                            onChange={(e) => update("llm_base_url", e.target.value)}
                            className={inputClass}
                            placeholder="https://api.openai.com/v1"
                        />
                    </Field>
                    <Field label="API Key">
                        <input
                            type="password"
                            value={setting.llm_api_key}
                            onChange={(e) => update("llm_api_key", e.target.value)}
                            className={inputClass}
                            placeholder="sk-..."
                        />
                    </Field>
                    <Field label="模型名" hint="可手填，也可点「获取模型」后从候选里选">
                        <input
                            list="soratrans-models"
                            value={setting.llm_model}
                            onChange={(e) => update("llm_model", e.target.value)}
                            className={inputClass}
                            placeholder="deepseek-v4.1-flash"
                        />
                    </Field>
                </Card>

                <datalist id="soratrans-models">
                    {models.map((m) => <option key={m} value={m} />)}
                </datalist>

                {(models.length > 0 || modelError) && (
                    <div className="rounded-sm bg-white p-3 shadow-sm">
                        <div className="flex items-center justify-between">
                            <div className="flex flex-col gap-1">
                                <span className="text-xs font-semibold select-none">可用模型</span>
                                <span className="text-[9px] text-neutral-400 select-none">
                                    点右侧按钮即可把该模型指派为 Jev 或 LLM 决策模型
                                </span>
                            </div>
                            <span className="text-[9px] text-neutral-400 select-none">共 {models.length} 个</span>
                        </div>
                        {modelError && (
                            <p className="mt-2 rounded-sm bg-red-50 px-2 py-1 text-[10px] text-red-600 break-all">{modelError}</p>
                        )}
                        <div className="mt-2 flex flex-col gap-1 max-h-[220px] overflow-y-auto pr-1">
                            {models.map((m) => {
                                const isJev = m === setting.jev_model;
                                const isLlm = m === setting.llm_model;
                                return (
                                    <div key={m} className="flex items-center gap-2 rounded-sm border px-2 h-7">
                                        <span className="flex-1 truncate text-[10px] font-mono">{m}</span>
                                        <button
                                            onClick={() => assignModel(m, "jev")}
                                            className={`h-5 px-2 rounded-sm text-[9px] border ${isJev ? "bg-blue-50 border-blue-300 text-blue-600" : "hover:bg-muted/60"}`}
                                        >
                                            {isJev ? "Jev 决策 ✓" : "设为 Jev"}
                                        </button>
                                        <button
                                            onClick={() => assignModel(m, "llm")}
                                            className={`h-5 px-2 rounded-sm text-[9px] border ${isLlm ? "bg-emerald-50 border-emerald-300 text-emerald-600" : "hover:bg-muted/60"}`}
                                        >
                                            {isLlm ? "LLM 决策 ✓" : "设为 LLM"}
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                <Card title="判定参数" desc="落在两个阈值之间的条目按 0.5 兜底判定">
                    <div className="grid grid-cols-3 gap-2">
                        <Field label="可本地化阈值（≥）">
                            <input
                                type="number"
                                step="0.05"
                                min="0"
                                max="1"
                                value={setting.threshold_high}
                                onChange={(e) => update("threshold_high", numberValue(e.target.value, setting.threshold_high, 0, 1))}
                                className={inputClass}
                            />
                        </Field>
                        <Field label="不可本地化阈值（≤）">
                            <input
                                type="number"
                                step="0.05"
                                min="0"
                                max="1"
                                value={setting.threshold_low}
                                onChange={(e) => update("threshold_low", numberValue(e.target.value, setting.threshold_low, 0, 1))}
                                className={inputClass}
                            />
                        </Field>
                        <Field label="并发请求数" hint="Jev 限流 120 次/分钟，实测 18s/请求，10~16 比较稳">
                            <input
                                type="number"
                                min="1"
                                max="32"
                                value={setting.concurrency}
                                onChange={(e) => update("concurrency", numberValue(e.target.value, setting.concurrency, 1, 32))}
                                className={inputClass}
                            />
                        </Field>
                    </div>
                </Card>

                <div className="flex items-center gap-3">
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="h-7 w-20 rounded-sm bg-[#0067c0] text-xs text-white hover:bg-[#0067c0]/70 disabled:bg-gray-300"
                    >
                        {saving ? "保存中" : "保存"}
                    </button>
                    {tip && <span className="text-[10px] text-neutral-500">{tip}</span>}
                </div>
            </div>
        </div>
    );
}

const inputClass =
    "h-6 rounded-sm border px-2 text-[10px] outline-none focus:border-blue-400";

// 数字输入兜底：清空输入框时 Number("") 会变成 0，
// 这里退回上一个有效值，并夹在 [min, max] 内，避免把 0 并发写进配置
function numberValue(raw: string, fallback: number, min: number, max: number): number {
    const value = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
}

// 卡片底部的「获取模型 / 测试连接」与结果提示
function ActionRow({ onFetch, onTest, fetching, testing, probe }: {
    onFetch: () => void;
    onTest: () => void;
    fetching: boolean;
    testing: boolean;
    probe: ProbeResult | null;
}) {
    return (
        <div className="flex flex-col gap-1">
            <div className="flex gap-2">
                <button
                    onClick={onFetch}
                    disabled={fetching}
                    className="h-6 px-2 rounded-sm border text-[10px] hover:bg-muted/60 disabled:text-neutral-300"
                >
                    {fetching ? "获取中…" : "获取模型"}
                </button>
                <button
                    onClick={onTest}
                    disabled={testing}
                    className="h-6 px-2 rounded-sm border text-[10px] hover:bg-muted/60 disabled:text-neutral-300"
                >
                    {testing ? "测试中…" : "测试连接"}
                </button>
            </div>
            {probe && (
                <p className={`text-[9px] leading-tight break-all ${probe.ok ? "text-emerald-600" : "text-red-600"}`}>
                    {probe.ok ? "✅ " : "❌ "}{probe.message}
                </p>
            )}
        </div>
    );
}

function Card({ title, desc, enabled, onToggle, footer, children }: {
    title: string;
    desc: string;
    enabled?: boolean;
    onToggle?: (value: boolean) => void;
    footer?: ReactNode;
    children: ReactNode;
}) {
    return (
        <div className="rounded-sm bg-white p-3 shadow-sm">
            <div className="flex items-start justify-between gap-2">
                <div className="flex flex-col gap-1">
                    <span className="text-xs font-semibold select-none">{title}</span>
                    <span className="text-[9px] text-neutral-400 select-none">{desc}</span>
                </div>
                {
                    onToggle && (
                        <label className="flex cursor-pointer items-center gap-1 text-[10px] text-neutral-500 select-none">
                            <input
                                type="checkbox"
                                checked={enabled ?? false}
                                onChange={(e) => onToggle(e.target.checked)}
                                className="size-3"
                            />
                            启用
                        </label>
                    )
                }
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2">{children}</div>
            {footer && <div className="mt-2">{footer}</div>}
        </div>
    );
}

function Field({ label, hint, children }: { label: string, hint?: string, children: ReactNode }) {
    return (
        <div className="flex flex-col gap-1">
            <span className="text-[10px] text-neutral-400 select-none">{label}</span>
            {children}
            {hint && <span className="text-[8px] leading-tight text-neutral-300 select-none">{hint}</span>}
        </div>
    );
}