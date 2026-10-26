import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ChevronRight, Loader2 } from "lucide-react";
import { manager } from "@/utils/DbManager";

type Msg = { ok: boolean, text: string } | null
type ExportFormat = "kvjson" | "csv"
// 导出粒度：single = 一个文件；per_asset = 按资源文件拆成多个
type ExportGranularity = "single" | "per_asset"
// 识别方式：llm = OpenAI 兼容 chat/completions；jev = TypeSafe System One 决策模型
type AiProvider = "llm" | "jev"


// 两种协议各存一份配置：切到 JEV 用 JEV 的 base_url/model，切回 LLM 再还原回去。
// 存在 app_settings 里而不是新表，避免再加一次迁移。
const cfgKey = (p: AiProvider) => `ai_config_${p}`
type SavedAiConfig = { baseUrl?: string, apiKey?: string, model?: string }

export default function SettingsView() {

    // AI 接口配置默认折叠：不做翻译时不需要看到它
    const [aiOpen, setAiOpen] = useState(false)
    const [baseUrl, setBaseUrl] = useState("")
    const [apiKey, setApiKey] = useState("")
    const [model, setModel] = useState("")
    const [saveLoading, setSaveLoading] = useState(false)
    const [testLoading, setTestLoading] = useState(false)
    const [msg, setMsg] = useState<Msg>(null)
    // AI 区专用提示：保存/测试连接的结果必须显示在按钮旁边，
    // 之前统一塞在页面最底部，点完测试连接要滚动整页才能看到结果
    const [aiMsg, setAiMsg] = useState<Msg>(null)

    // 导出格式（决定"一键导出"生成的文件格式）
    const [exportFormat, setExportFormat] = useState<ExportFormat>("kvjson")
    // 识别方式
    const [provider, setProvider] = useState<AiProvider>("llm")
    // 导出粒度
    const [granularity, setGranularity] = useState<ExportGranularity>("single")

    useEffect(() => {
        manager.getAiSettings().then((s) => {
            if (!s) return;
            setBaseUrl(s.baseUrl)
            setApiKey(s.apiKey)
            setModel(s.model)
        })
        manager.getAppSetting("export_format").then((v) => {
            if (v === "csv" || v === "kvjson") setExportFormat(v)
        })
        manager.getAppSetting("ai_provider").then((v) => {
            if (v === "llm" || v === "jev") setProvider(v)
        })
        manager.getAppSetting("export_granularity").then((v) => {
            if (v === "single" || v === "per_asset") setGranularity(v)
        })
    }, [])

    const valid = () => {
        if (!baseUrl.trim() || !model.trim()) {
            setAiMsg({ ok: false, text: "Base URL 与模型名不能为空" })
            return false
        }
        return true
    }

    const handleSave = async () => {
        if (!valid() || saveLoading) return;
        setSaveLoading(true)
        try {
            await manager.saveAiSettings(baseUrl.trim(), apiKey.trim(), model.trim())
            // 同时按当前协议存档，切换协议时才能把这份配置原样还原回来
            await manager.setAppSetting(cfgKey(provider), JSON.stringify({
                baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim()
            }))
            setAiMsg({ ok: true, text: "已保存" })
        } catch (e) {
            setAiMsg({ ok: false, text: `保存失败: ${e}` })
        } finally {
            setSaveLoading(false)
        }
    }

    const handleTest = async () => {
        if (!valid() || testLoading) return;
        setTestLoading(true)
        setAiMsg(null)
        try {
            await manager.testAiConnection(baseUrl.trim(), apiKey.trim(), model.trim(), provider)
            setAiMsg({ ok: true, text: `连接成功（${provider === "jev" ? "JEV" : "LLM"} · ${model.trim()}）` })
        } catch (e) {
            setAiMsg({ ok: false, text: `连接失败: ${e}` })
        } finally {
            setTestLoading(false)
        }
    }

    // 读取某协议已保存的配置；从未保存过返回 null
    const readSavedConfig = async (p: AiProvider): Promise<SavedAiConfig | null> => {
        try {
            const raw = await manager.getAppSetting(cfgKey(p))
            if (!raw) return null
            const parsed = JSON.parse(raw)
            return (parsed && typeof parsed === "object") ? parsed as SavedAiConfig : null
        } catch {
            return null
        }
    }

    // 切换识别方式：先把当前输入存档到旧协议，再载入新协议的配置，并立即同步生效配置。
    // 不自动同步的话，切了协议但运行识别仍读库里的旧 model，表现为"切了还在用上一个协议"。
    const handleProviderChange = async (v: AiProvider) => {
        if (v === provider) return
        const prev = provider
        setProvider(v)
        setAiMsg(null)
        try {
            if (baseUrl.trim() || model.trim()) {
                await manager.setAppSetting(cfgKey(prev), JSON.stringify({
                    baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim()
                }))
            }
            const saved = await readSavedConfig(v)
            // 没有历史配置时：base_url / key 沿用当前（同一网关很常见），
            // model 换成该协议的默认值，避免把 jev-latest 发给 chat/completions
            const next: SavedAiConfig = saved ?? {
                baseUrl: baseUrl.trim(),
                apiKey: apiKey.trim(),
                model: v === "jev" ? "jev-latest" : "deepseek-chat",
            }
            setBaseUrl(next.baseUrl ?? "")
            setApiKey(next.apiKey ?? "")
            setModel(next.model ?? "")
            await manager.setAppSetting("ai_provider", v)
            if ((next.baseUrl ?? "").trim() && (next.model ?? "").trim()) {
                await manager.saveAiSettings(
                    (next.baseUrl ?? "").trim(),
                    (next.apiKey ?? "").trim(),
                    (next.model ?? "").trim(),
                )
            }
            setAiMsg({
                ok: true,
                text: saved
                    ? `已切换到 ${v === "jev" ? "JEV" : "LLM"}，载入该协议已保存的配置`
                    : `已切换到 ${v === "jev" ? "JEV" : "LLM"}，模型填入默认值 ${next.model}`,
            })
        } catch (e) {
            setAiMsg({ ok: false, text: `切换识别方式失败: ${e}` })
        }
    }

    const handleGranularityChange = async (v: ExportGranularity) => {
        setGranularity(v)
        try {
            await manager.setAppSetting("export_granularity", v)
        } catch (e) {
            setMsg({ ok: false, text: `保存导出粒度失败: ${e}` })
        }
    }

    const handleFormatChange = async (v: ExportFormat) => {
        setExportFormat(v)
        try {
            await manager.setAppSetting("export_format", v)
        } catch (e) {
            setMsg({ ok: false, text: `保存导出格式失败: ${e}` })
        }
    }

    const aiSummary = model.trim()
        ? `${provider === "jev" ? "JEV · " : "LLM · "}${model.trim()}@${baseUrl.replace(/^https?:\/\//, "")}`
        : "未配置"

    return (
        <div className="p-4 flex flex-col gap-4 overflow-y-auto h-full">
            {/* ---------- AI 识别（折叠） ---------- */}
            <div className="flex flex-col gap-2 max-w-[520px]">
                <button
                    onClick={() => setAiOpen(!aiOpen)}
                    className="flex items-center gap-2 w-full text-left cursor-pointer select-none group"
                >
                    <ChevronRight className={`size-3 text-neutral-400 transition-transform ${aiOpen ? "rotate-90" : ""}`} />
                    <span className="text-sm font-semibold">AI 识别</span>
                    <span className="text-[10px] text-neutral-400 truncate">{aiSummary}</span>
                </button>

                {aiOpen && (
                    <div className="flex flex-col gap-3 pl-5 pt-1">
                        <p className="text-[10px] text-neutral-400 leading-relaxed select-none">
                            配置 OpenAI 兼容接口（DeepSeek / OpenAI / Ollama / LM Studio 等），用于识别文本分组是否属于可本地化的游戏文本。
                            API Key 仅保存在本机数据库。
                        </p>
                        <div className="flex flex-col gap-1">
                            <Label className="text-[10px] text-neutral-500">识别方式</Label>
                            <label className="flex items-start gap-2 cursor-pointer select-none">
                                <input type="radio" name="ai-provider" className="mt-[3px]" checked={provider === "llm"}
                                    onChange={() => handleProviderChange("llm")} />
                                <span className="flex flex-col">
                                    <span className="text-xs">LLM（OpenAI 兼容 chat/completions）</span>
                                    <span className="text-[10px] text-neutral-400">DeepSeek / OpenAI / Ollama 等通用接口</span>
                                </span>
                            </label>
                            <label className="flex items-start gap-2 cursor-pointer select-none">
                                <input type="radio" name="ai-provider" className="mt-[3px]" checked={provider === "jev"}
                                    onChange={() => handleProviderChange("jev")} />
                                <span className="flex flex-col">
                                    <span className="text-xs">JEV 决策模型（TypeSafe System One）</span>
                                    <span className="text-[10px] text-neutral-400">
                                        不生成文字、直接输出带概率的判定，适合本场景的纯分类；接口为 POST base/systemone
                                    </span>
                                </span>
                            </label>
                        </div>
                        <div className="flex flex-col gap-1">
                            <Label htmlFor="ai-base-url" className="text-[10px] text-neutral-500">Base URL</Label>
                            <Input id="ai-base-url" value={baseUrl} onChange={e => setBaseUrl(e.target.value)}
                                placeholder={provider === "jev" ? "https://inference.do-ai.run/v1" : "https://api.deepseek.com/v1"}
                                className="h-8 text-xs" />
                        </div>
                        <div className="flex flex-col gap-1">
                            <Label htmlFor="ai-api-key" className="text-[10px] text-neutral-500">API Key（本地服务可留空）</Label>
                            <Input id="ai-api-key" type="password" value={apiKey} onChange={e => setApiKey(e.target.value)}
                                placeholder="sk-..." className="h-8 text-xs" />
                        </div>
                        <div className="flex flex-col gap-1">
                            <Label htmlFor="ai-model" className="text-[10px] text-neutral-500">模型</Label>
                            <Input id="ai-model" value={model} onChange={e => setModel(e.target.value)}
                                placeholder={provider === "jev" ? "jev-latest" : "deepseek-chat"}
                                className="h-8 text-xs" />
                        </div>
                        <div className="flex items-center gap-2">
                            <Button size="sm" onClick={handleSave} disabled={saveLoading} className="gap-1">
                                {saveLoading && <Loader2 className="size-3 animate-spin" />}
                                保存
                            </Button>
                            <Button size="sm" variant="outline" onClick={handleTest} disabled={testLoading} className="gap-1">
                                {testLoading && <Loader2 className="size-3 animate-spin" />}
                                测试连接
                            </Button>
                        </div>
                        {aiMsg && (
                            <p className={`text-[10px] leading-relaxed break-all ${aiMsg.ok ? "text-green-600" : "text-red-500"}`}>
                                {aiMsg.text}
                            </p>
                        )}
                    </div>
                )}
            </div>

            {/* ---------- 导出格式 ---------- */}
            <div className="flex flex-col gap-2 max-w-[520px]">
                <div className="flex items-center gap-1">
                    <span className="text-sm font-semibold">导出格式</span>
                </div>
                <p className="text-[10px] text-neutral-400 leading-relaxed select-none">
                    「一键导出」生成的文件格式。翻译结束后用「导入译文」读回同格式的文件即可。
                </p>
                <label className="flex items-start gap-2 cursor-pointer select-none">
                    <input type="radio" name="export-format" className="mt-[3px]"
                        checked={exportFormat === "kvjson"}
                        onChange={() => handleFormatChange("kvjson")} />
                    <span className="flex flex-col">
                        <span className="text-xs">LinguaGacha KV-JSON（推荐）</span>
                        <span className="text-[10px] text-neutral-400 leading-relaxed">
                            原文作键的 JSON，可直接拖进 LinguaGacha；相同原文自动去重，术语更统一，导入时按原文匹配回写。
                        </span>
                    </span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer select-none">
                    <input type="radio" name="export-format" className="mt-[3px]"
                        checked={exportFormat === "csv"}
                        onChange={() => handleFormatChange("csv")} />
                    <span className="flex flex-col">
                        <span className="text-xs">CSV（Key=id）</span>
                        <span className="text-[10px] text-neutral-400 leading-relaxed">
                            每行「id,原文」，逐行对应、不去重；适合需要知道具体是哪一个字段的场景。
                        </span>
                    </span>
                </label>
            </div>

            {/* ---------- 导出粒度 ---------- */}
            <div className="flex flex-col gap-2 max-w-[520px]">
                <div className="flex items-center gap-1">
                    <span className="text-sm font-semibold">导出粒度</span>
                </div>
                <p className="text-[10px] text-neutral-400 leading-relaxed select-none">
                    「一键导出」时选一个文件，还是按游戏里的资源文件拆成多个。
                </p>
                <label className="flex items-start gap-2 cursor-pointer select-none">
                    <input type="radio" name="export-granularity" className="mt-[3px]"
                        checked={granularity === "single"}
                        onChange={() => handleGranularityChange("single")} />
                    <span className="flex flex-col">
                        <span className="text-xs">单个文件</span>
                        <span className="text-[10px] text-neutral-400 leading-relaxed">
                            全部文本汇总成一个 JSON / CSV，方便整体交给翻译工具。
                        </span>
                    </span>
                </label>
                <label className="flex items-start gap-2 cursor-pointer select-none">
                    <input type="radio" name="export-granularity" className="mt-[3px]"
                        checked={granularity === "per_asset"}
                        onChange={() => handleGranularityChange("per_asset")} />
                    <span className="flex flex-col">
                        <span className="text-xs">按资源文件拆分（推荐）</span>
                        <span className="text-[10px] text-neutral-400 leading-relaxed">
                            选一个目录，每个资源文件（如 UI、chara_0、iteminformation）单独一个文件，导出后可直接按文件对照/替换。
                        </span>
                    </span>
                </label>
            </div>

            {msg && (
                <p className={`text-[10px] leading-relaxed break-all max-w-[520px] ${msg.ok ? "text-green-600" : "text-red-500"}`}>
                    {msg.text}
                </p>
            )}
        </div>
    )
}
