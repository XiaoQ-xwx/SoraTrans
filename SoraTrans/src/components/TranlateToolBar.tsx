import { useAssetObjectStore } from "@/model/AssetObjectInfo"
import { WebviewWindow } from "@tauri-apps/api/webviewWindow"
import { Ban, DownloadIcon, ImageIcon, Sparkles, UploadIcon } from "lucide-react"
import { ReactNode, useEffect, useState } from "react"
import { FiFileText, FiTable } from "react-icons/fi"
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import { listen } from '@tauri-apps/api/event';
import { assetApi } from "@/utils/AssetApi";
import { gm } from "@/utils/GameDbManager";
import { manager } from "@/utils/DbManager";
import { AiProgress } from "@/model/AiSettings";
import { csvEscape, parseCsvRows } from "./TextToolBar";
import { extractTemplateAuto, extractVarTokens, isCsvTableText, LONG_TEXT_THRESHOLD, DEFAULT_COLUMN_MODE, type CsvColumnMode } from "@/utils/TextTemplate";

// 译文必须与原片段携带相同的变量标记（如 {_NAME_}）：丢了变量写回会破坏游戏文本
const sameVarTokens = (src: string, dst: string): boolean => {
    const a = extractVarTokens(src)
    const b = extractVarTokens(dst)
    if (a.length !== b.length) return false
    return [...a].sort().join("\u0000") === [...b].sort().join("\u0000")
}
import { PatchDialog, PatchPhase } from "./PatchDialog";

// 导出用的文本行（含长文本模板）
type ExportRow = { id: number, origin_text: string, trans_text: string | null, text_template: string | null, asset_name: string | null }

// 与 AssetWorker 端 AssetScanner.OutputFolderName 保持一致
const OUTPUT_FOLDER_NAME = "SoraTransOutput";

export default function TranslateToolBar() {

    const selectAssetObj = useAssetObjectStore((state) => state.selectAssetObj)

    const handleViewData = () => {
        if (!selectAssetObj) return;
        const webviewWindow = new WebviewWindow('viewdata', {
            url: `viewdata.html?id=${selectAssetObj.id}&title=${selectAssetObj.name}`,
            title: '查看数据',
            width: 300,
            height: 520,
            decorations: false,
            minWidth: 300,
            resizable: true,
            transparent: true,
        });
        webviewWindow.once('tauri://created', () => {
            console.log("新窗口建立成功");
        });
        webviewWindow.once('tauri://error', (e) => {
            console.error("新窗口建立失败", e);
        });
    }

    const handleViewText = () => {
        if (!selectAssetObj) return;
        const webviewWindow = new WebviewWindow('viewtext', {
            url: `viewtext.html?objId=${selectAssetObj.id}&title=${selectAssetObj.name}`,
            title: '查看数据',
            width: 800,
            height: 520,
            decorations: false,
            minWidth: 500,
            minHeight: 170,
            resizable: true,
            transparent: true,
        })
        webviewWindow.once('tauri://created', () => {
            console.log("新窗口建立成功");
        });
        webviewWindow.once('tauri://error', (e) => {
            console.error("新窗口建立失败", e);
        });
    }

    const handlePreviewTexture = () => {
        if (!selectAssetObj) return;
        const webviewWindow = new WebviewWindow('texturepreview', {
            url: `texturepreview.html?id=${selectAssetObj.id}&title=${selectAssetObj.name}`,
            title: '预览图片',
            width: 520,
            height: 560,
            decorations: false,
            minWidth: 240,
            minHeight: 200,
            resizable: true,
            transparent: true,
        })
        webviewWindow.once('tauri://created', () => {
            console.log("新窗口建立成功");
        });
        webviewWindow.once('tauri://error', (e) => {
            console.error("新窗口建立失败", e);
        });
    }

    const [patchOpen, setPatchOpen] = useState(false)
    const [patchPhase, setPatchPhase] = useState<PatchPhase>("making")
    const [patchError, setPatchError] = useState("")
    const [patchDir, setPatchDir] = useState("")

    // 纹理导入/导出的临时反馈消息：操作完成后显示，3 秒后自动清除
    const [textureBusy, setTextureBusy] = useState(false)
    const [textureMsg, setTextureMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null)
    useEffect(() => {
        if (!textureMsg) return;
        const t = setTimeout(() => setTextureMsg(null), 3000);
        return () => clearTimeout(t);
    }, [textureMsg])

    const handleExportTexture = async () => {
        if (!selectAssetObj) return;
        const savePath = await save({
            title: "导出纹理为 PNG",
            defaultPath: `${selectAssetObj.name}.png`,
            filters: [{ name: "PNG", extensions: ["png"] }],
        });
        if (!savePath) return;
        setTextureBusy(true);
        setTextureMsg(null);
        try {
            const { width, height } = await assetApi.exportTexture(selectAssetObj.id, savePath);
            setTextureMsg({ kind: "ok", text: `已导出 ${width}×${height}` });
        } catch (e) {
            setTextureMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
        } finally {
            setTextureBusy(false);
        }
    }

    const handleImportTexture = async () => {
        if (!selectAssetObj) return;
        const picked = await open({
            title: "选择要导入的 PNG 图片",
            multiple: false,
            filters: [{ name: "PNG", extensions: ["png"] }],
        });
        if (!picked || Array.isArray(picked)) return;
        const pngPath = picked as string;
        setTextureBusy(true);
        setTextureMsg(null);
        try {
            await assetApi.importTexture(selectAssetObj.id, pngPath);
            useAssetObjectStore.getState().setModInfo(selectAssetObj.id);
        } catch (e) {
            setTextureMsg({ kind: "err", text: e instanceof Error ? e.message : String(e) });
        } finally {
            setTextureBusy(false);
        }
    }

    // ============ AI 识别与批量导出 / 导入 ============
    const [aiRunning, setAiRunning] = useState(false)
    const [aiDone, setAiDone] = useState(0)
    const [aiTotal, setAiTotal] = useState(0)
    const [batchBusy, setBatchBusy] = useState(false)
    const [batchMsg, setBatchMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null)
    // 默认只导出 AI 判定可本地化的文本：这正是"从所有行数里筛出真正游戏文本"的目的
    const [localizableOnly, setLocalizableOnly] = useState(true)
    const [exportFormat, setExportFormat] = useState<"kvjson" | "csv">("kvjson")

    useEffect(() => {
        manager.getAppSetting("export_format").then((v) => {
            if (v === "csv" || v === "kvjson") setExportFormat(v)
        })
    }, [])

    // AI 识别进度由 Rust 侧事件推送
    useEffect(() => {
        const un = listen<AiProgress>("ai-recognition-progress", (event) => {
            const p = event.payload
            if (p.finished) return
            setAiDone(p.done)
            setAiTotal(p.total)
        })
        return () => { un.then(fn => fn()) }
    }, [])

    const handleAiAll = async () => {
        if (batchBusy) return
        setBatchBusy(true)
        setBatchMsg(null)
        setAiRunning(true)
        try {
            const s = await gm.runAiRecognition(null)
            const parts = [`标注 ${s.updated}/${s.totalPatterns} 组`]
            if (s.cancelled) parts.push("已取消")
            if (s.failedBatches > 0) parts.push(`${s.failedBatches} 批失败`)
            setBatchMsg({
                kind: s.failedBatches > 0 ? "err" : "ok",
                text: `AI 识别完成：${parts.join("，")}`,
            })
        } catch (e) {
            setBatchMsg({ kind: "err", text: String(e) })
        } finally {
            setAiRunning(false)
            setBatchBusy(false)
        }
    }

    const handleCancelAi = async () => {
        try { await gm.cancelAiRecognition() } catch { /* 忽略 */ }
    }

    // 长文本"再提取"：把整条文本里的日文片段换成 {n} 占位符，
    // 只导出片段、模板回写库；导入时按模板拼回，结构与原文完全一致。
    // 复用仓库 v0.1.1 的 extractTextTemplate 机制（text_origin.text_template）。
    // extractTemplateAuto：先判断是不是"带 ENG 列的双语 CSV 表"（chara_0 / UI / actionlib 这类），
    // 是就按列拆单元格；否则退回日文片段正则。导出与导入必须共用，占位符编号才不错位。
    const splitLongText = (r: ExportRow, mode: CsvColumnMode): { template: string, placeholders: Record<string, string> } | null => {
        if (r.origin_text.length <= LONG_TEXT_THRESHOLD) return null
        const { template, placeholders } = extractTemplateAuto(r.origin_text, "ja", mode)
        return Object.keys(placeholders).length > 0 ? { template, placeholders } : null
    }

    const handleExportAll = async () => {
        if (batchBusy) return
        setBatchMsg(null)
        try {
            let rows = await gm.selectExportTexts(localizableOnly) as ExportRow[]
            // 产线 A：带 ENG 列的双语 CSV 表（chara_0 / UI / actionlib 这类）不参与 AI 判定。
            // AI 是按 pattern——也就是整块 m_Script（一份十万字符的表格）——判定的，
            // 一旦整块被判成噪声，里面几百条正文会被一起丢掉。这类表由结构决定必然要翻，
            // 所以勾了"仅可本地化"时也要把它们补回来；产线 B（散落字段）才依赖 AI 标注。
            let structuredCount = 0
            if (localizableOnly) {
                const allRows = await gm.selectExportTexts(false) as ExportRow[]
                const picked = new Set(rows.map(r => r.id))
                const structured = allRows.filter(r => !picked.has(r.id) && isCsvTableText(r.origin_text))
                if (structured.length > 0) {
                    structuredCount = structured.length
                    rows = [...rows, ...structured].sort((a, b) => a.id - b.id)
                }
            }
            if (rows.length === 0) {
                setBatchMsg({
                    kind: "err",
                    text: localizableOnly
                        ? "没有可导出文本：请先点「AI 识别全部」，或取消勾选「仅导出可本地化文本」"
                        : "没有可导出文本",
                })
                return
            }

            const isJson = exportFormat === "kvjson"
            const ext = isJson ? "json" : "csv"
            // 口径固定：日文列与英文列一并导出，多语言取舍交给后期工具
            const columnMode: CsvColumnMode = DEFAULT_COLUMN_MODE
            const granularity = await manager.getAppSetting("export_granularity")
            const perAsset = granularity === "per_asset"

            // 把给定的一批行序列化成文件内容（长文本按片段拆分，模板单独收集回写）
            const buildContent = (subset: ExportRow[], columnMode: CsvColumnMode) => {
                const templateUpdates: { id: number, text_template: string }[] = []
                let splitCount = 0
                let content = ""
                if (isJson) {
                    // KV-JSON：原文（长文本则是日文片段）作键，LinguaGacha 会自动去重
                    const obj: Record<string, string> = {}
                    for (const r of subset) {
                        const split = splitLongText(r, columnMode)
                        if (split) {
                            templateUpdates.push({ id: r.id, text_template: split.template })
                            splitCount++
                            for (const frag of Object.values(split.placeholders)) {
                                if (!(frag in obj)) obj[frag] = ""
                            }
                            continue
                        }
                        obj[r.origin_text] = r.trans_text ?? ""
                    }
                    content = JSON.stringify(obj, null, 2)
                } else {
                    const lines = ["Key,Value"]
                    for (const r of subset) {
                        const split = splitLongText(r, columnMode)
                        if (split) {
                            templateUpdates.push({ id: r.id, text_template: split.template })
                            splitCount++
                            for (const [tok, frag] of Object.entries(split.placeholders)) {
                                lines.push(`${r.id}:${tok},${csvEscape(frag)}`)
                            }
                            continue
                        }
                        lines.push(`${r.id},${csvEscape(r.origin_text)}`)
                    }
                    content = lines.join("\n")
                }
                return { content, templateUpdates, splitCount }
            }

            if (perAsset) {
                // 按资源文件拆分：一个资源文件一个文件，与手动提取的目录结构一致
                const dir = await open({ title: "选择导出目录（按资源文件拆分）", directory: true, multiple: false })
                if (!dir || Array.isArray(dir)) return

                setBatchBusy(true)
                const groups = new Map<string, ExportRow[]>()
                for (const r of rows) {
                    const key = r.asset_name?.trim() || "_unknown"
                    const list = groups.get(key) ?? []
                    list.push(r)
                    groups.set(key, list)
                }

                const used = new Set<string>()
                const allTemplates: { id: number, text_template: string }[] = []
                let splitTotal = 0
                for (const [assetName, subset] of groups) {
                    const safe = assetName.replace(/[\\/:*?"<>|]/g, "_")
                    let fileName = `${safe}.${ext}`
                    if (used.has(fileName)) fileName = `${safe}_${subset[0].id}.${ext}`
                    used.add(fileName)
                    const built = buildContent(subset, columnMode)
                    await writeTextFile(await join(dir as string, fileName), built.content)
                    allTemplates.push(...built.templateUpdates)
                    splitTotal += built.splitCount
                }
                if (allTemplates.length > 0) await gm.updateTextTemplates(allTemplates)
                setBatchMsg({
                    kind: "ok",
                    text: `已按资源文件导出 ${groups.size} 个文件，共 ${rows.length} 行`
                        + (splitTotal > 0 ? `（${splitTotal} 条长文本已按片段拆分）` : "")
                        + (structuredCount > 0 ? `，含 ${structuredCount} 条结构化表格（不参与 AI 筛选）` : ""),
                })
                return
            }

            const filePath = await save({
                title: "导出待翻译文本",
                defaultPath: `soratrans_text.${ext}`,
                filters: isJson
                    ? [{ name: "JSON", extensions: ["json"] }]
                    : [{ name: "CSV", extensions: ["csv"] }],
            })
            if (!filePath) return

            setBatchBusy(true)
            const built = buildContent(rows, columnMode)
            await writeTextFile(filePath, built.content)
            // 模板回写库，导入时用它把片段拼回整条文本
            if (built.templateUpdates.length > 0) await gm.updateTextTemplates(built.templateUpdates)
            setBatchMsg({
                kind: "ok",
                text: `已导出 ${rows.length} 行` + (built.splitCount > 0 ? `（${built.splitCount} 条长文本已按片段拆分）` : "")
                    + (structuredCount > 0 ? `，含 ${structuredCount} 条结构化表格（不参与 AI 筛选）` : ""),
            })
        } catch (e) {
            setBatchMsg({ kind: "err", text: String(e) })
        } finally {
            setBatchBusy(false)
        }
    }

    const handleImportAll = async () => {
        if (batchBusy) return
        const picked = await open({
            title: "选择译文文件（可多选；LinguaGacha 输出的 JSON / SoraTrans 的 CSV）",
            multiple: true,
            filters: [{ name: "译文文件", extensions: ["json", "csv"] }],
        })
        if (!picked) return
        const paths = Array.isArray(picked) ? picked : [picked]
        if (paths.length === 0) return

        setBatchBusy(true)
        setBatchMsg(null)
        try {
            let written = 0
            // 口径固定，导出与导入必然一致，不存在"改设置导致 {n} 错位"的问题
            const columnMode: CsvColumnMode = DEFAULT_COLUMN_MODE

            // 全量行只在开始时读一次：多选几十个文件时，不能每个文件都重新拉一遍库
            const allRows = await gm.selectExportTexts(false) as ExportRow[]
            const rowById = new Map(allRows.map(r => [r.id, r]))
            // 有模板的长文本只是一小批，占位符也预先算好，供每个文件复用
            const templateRows = allRows
                .filter(r => !!r.text_template)
                .map(r => ({ row: r, placeholders: extractTemplateAuto(r.origin_text, "ja", columnMode).placeholders }))

            const byText: { origin_text: string, trans_text: string }[] = []
            const byId: { id: number, trans_text: string }[] = []
            // 拼回后仍残留 {n} 说明有片段缺译；这类条目不写库（否则字面占位符会落进资源字段）
            let skipped = 0
            // 译文丢失变量标记的片段数（保留原文片段，不写坏数据）
            let varMismatch = 0

            for (const path of paths) {
            const text = await readTextFile(path)

            if (path.toLowerCase().endsWith(".json")) {
                const data = JSON.parse(text)
                // 原文（长文本为日文片段）-> 译文
                const fragMap = new Map<string, string>()
                if (Array.isArray(data)) {
                    // 兼容 Message-JSON：[{ name, message, translation }]
                    for (const it of data) {
                        const src = it?.message ?? it?.orig ?? it?.source
                        const dst = it?.translation ?? it?.trans ?? it?.target
                        if (typeof src === "string" && typeof dst === "string" && dst.trim()) fragMap.set(src, dst)
                    }
                } else {
                    // KV-JSON：{ 原文: 译文 }
                    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
                        if (typeof v === "string" && v.trim()) fragMap.set(k, v)
                    }
                }

                const done = new Set<number>()
                // 先按模板拼回长文本（占位符已在循环外预计算，这里直接复用）
                for (const { row: r, placeholders } of templateRows) {
                    const tpl = r.text_template as string
                    let assembled = tpl
                    let changed = false
                    for (const [tok, frag] of Object.entries(placeholders)) {
                        const tr = fragMap.get(frag)
                        if (!tr || !tr.trim()) continue
                        if (!sameVarTokens(frag, tr)) {
                            varMismatch++
                            continue
                        }
                        assembled = assembled.split(tok).join(tr)
                        changed = true
                    }
                    if (changed) {
                        if (/\{[ej]?\d+\}/.test(assembled)) {
                            skipped++
                            continue
                        }
                        byId.push({ id: r.id, trans_text: assembled })
                        done.add(r.id)
                    }
                }
                // 其余按原文整条匹配
                for (const r of allRows) {
                    if (done.has(r.id)) continue
                    const tr = fragMap.get(r.origin_text)
                    if (tr && tr.trim()) byText.push({ origin_text: r.origin_text, trans_text: tr })
                }
            } else {
                const csvRows = parseCsvRows(text)
                if (csvRows.length > 0 && csvRows[0][0] === "Key" && csvRows[0][1] === "Value") csvRows.shift()

                const longParts = new Map<number, Record<string, string>>()
                const normal = new Map<number, string>()
                for (const [k, v] of csvRows) {
                    // both 口径的键形如 123:{e0}（英文）/ 123:{j1}（日文），单列是 123:{0}
                    const m = /^(\d+):(\{[ej]?\d+\})$/.exec(k)
                    if (m) {
                        const id = Number(m[1])
                        const parts = longParts.get(id) ?? {}
                        parts[m[2]] = v
                        longParts.set(id, parts)
                    } else if (/^\d+$/.test(k)) {
                        normal.set(Number(k), v)
                    }
                }

                for (const [id, parts] of longParts) {
                    const tpl = rowById.get(id)?.text_template
                    if (!tpl) continue
                    let assembled = tpl
                    let changed = false
                    for (const [tok, tr] of Object.entries(parts)) {
                        if (!tr || !tr.trim()) continue
                        // CSV 分支拿不到原片段，用模板占位符反查原文片段做校验
                        const srcFrag = extractTemplateAuto(rowById.get(id)?.origin_text ?? "", "ja", columnMode).placeholders[tok]
                        if (srcFrag !== undefined && !sameVarTokens(srcFrag, tr)) {
                            varMismatch++
                            continue
                        }
                        assembled = assembled.split(tok).join(tr)
                        changed = true
                    }
                    if (changed) {
                        if (/\{[ej]?\d+\}/.test(assembled)) {
                            skipped++
                            continue
                        }
                        byId.push({ id, trans_text: assembled })
                    }
                }
                for (const [id, v] of normal) {
                    if (longParts.has(id)) continue
                    byId.push({ id, trans_text: v })
                }
            }
            }

            if (byText.length > 0) written += await gm.importTransByText(byText)
            if (byId.length > 0) written += await gm.importTransById(byId)

            setBatchMsg({
                kind: skipped > 0 || varMismatch > 0 ? "err" : "ok",
                text: `已导入 ${paths.length} 个文件的译文，写入 ${written} 行`
                    + (skipped > 0 ? `；${skipped} 条因长文本片段缺译被跳过（未写入，避免破坏原表）` : "")
                    + (varMismatch > 0 ? `；${varMismatch} 个片段译文丢了变量标记，已保留原文` : ""),
            })
            const st = useAssetObjectStore.getState()
            gm.selectAssetObjectList(st.assetId, st.currentSort)
        } catch (e) {
            setBatchMsg({ kind: "err", text: String(e) })
        } finally {
            setBatchBusy(false)
        }
    }

    const handleMakePatch = async () => {
        const dir = await open({
            title: "选择导出文件夹",
            multiple: false,
            directory: true,
        })
        if (!dir) return;

        // 补丁实际写入所选目录下的固定子目录，对话框展示/打开该目录
        const outDir = await join(dir, OUTPUT_FOLDER_NAME);
        setPatchDir(outDir)
        setPatchError("")
        setPatchPhase("making")
        setPatchOpen(true)
        try {
            await assetApi.makePatch(dir);
            setPatchPhase("done")
        } catch (e) {
            setPatchError(String(e))
            setPatchPhase("error")
        }
    }

    return (
        <div className="px-2 flex flex-col gap-1 py-1 lg:py-4">
            <div className="w-full flex flex-col gap-1">
                <ToolTitle title="属性" />
                <div className="leading-none flex flex-col flex-1 gap-1 overflow-hidden">
                    <p className="text-[10px] text-neutral-400 leading-none select-none">名称</p>
                    <p className="border px-2 h-6 flex items-center font-san rounded-sm text-[10px] truncate">{selectAssetObj?.name}</p>
                </div>
                <div className="grid gap-1 grid-cols-2">
                    <div className="flex flex-col gap-1 overflow-hidden">
                        <p className="text-[10px] text-neutral-400 leading-none select-none truncate">Path ID</p>
                        <p className="border px-2 h-6 flex items-center rounded-sm font-mono leading-none text-[10px] truncate">{selectAssetObj?.path_id}</p>
                    </div>
                    <div className="flex flex-col gap-1 overflow-hidden">
                        <p className="text-[10px] text-neutral-400 leading-none select-none truncate">行数</p>
                        <p className="border px-2 h-6 flex items-center rounded-sm text-[10px] leading-none font-mono truncate">{selectAssetObj?.line_count}</p>
                    </div>
                </div>
                <div className="leading-none flex flex-col flex-1 gap-1 overflow-hidden">
                    <p className="text-[10px] text-neutral-400 leading-none select-none">类型</p>
                    <p className="border px-2 h-6 flex items-center justify-between font-san rounded-sm text-[10px] truncate">{selectAssetObj?.type}</p>
                </div>
            </div>
            <div className="w-full flex flex-col gap-1">
                <ToolTitle title="查看" />
                <div className="grid gap-1 lg:grid-cols-2 overflow-hidden">
                    <ToolBtn onClick={handleViewData} icon={<FiTable size={10} className="text-neutral-500" />} text="查看数据" />
                    {selectAssetObj?.type !== "Texture2D" && (
                        <ToolBtn onClick={handleViewText} icon={<FiFileText size={10} className="text-neutral-500" />} text="查看文本" />
                    )}
                    {selectAssetObj?.type === "Texture2D" && (
                        <ToolBtn onClick={handlePreviewTexture} icon={<ImageIcon size={10} className="text-neutral-500" />} text="预览图片" />
                    )}
                </div>
            </div>
            <div className="w-full flex flex-col gap-1">
                <ToolTitle title="导入 / 导出" />
                <div className="grid gap-1 lg:grid-cols-2 overflow-hidden">
                    {selectAssetObj?.type === "Texture2D" && (
                        <>
                            <ToolBtn
                                onClick={handleExportTexture}
                                icon={<DownloadIcon size={10} className="text-neutral-500" />}
                                text="导出图片"
                                disabled={textureBusy}
                            />
                            <ToolBtn
                                onClick={handleImportTexture}
                                icon={<UploadIcon size={10} className="text-neutral-500" />}
                                text="导入图片"
                                disabled={textureBusy}
                            />
                        </>
                    )}
                    {/* <ToolBtn icon={<UploadIcon size={10} className="text-neutral-500" />} text="导入 Raw" />
                    <ToolBtn icon={<DownloadIcon size={10} className="text-neutral-500" />} text="导出 Raw" />
                    <ToolBtn icon={<UploadIcon size={10} className="text-neutral-500" />} text="导入 Dump" />
                    <ToolBtn icon={<DownloadIcon size={10} className="text-neutral-500" />} text="导出 Dump" /> */}
                    <ToolBtn onClick={handleMakePatch} icon={<DownloadIcon size={10} className="text-neutral-500" />} text="制作补丁" />
                </div>
                {textureMsg && (
                    <p className={`text-[10px] leading-tight px-1 py-0.5 rounded-sm break-all ${textureMsg.kind === "ok" ? "text-emerald-600 bg-emerald-50" : "text-red-600 bg-red-50"}`}>
                        {textureMsg.text}
                    </p>
                )}
            </div>
            <div className="w-full flex flex-col gap-1">
                <ToolTitle title="AI 与批量" />
                <div className="grid gap-1 lg:grid-cols-2 overflow-hidden">
                    <ToolBtn
                        onClick={aiRunning ? handleCancelAi : handleAiAll}
                        icon={aiRunning
                            ? <Ban size={10} className="text-neutral-500" />
                            : <Sparkles size={10} className="text-neutral-500" />}
                        text={aiRunning ? "取消识别" : "AI 识别全部"}
                        disabled={batchBusy && !aiRunning}
                    />
                    <ToolBtn
                        onClick={handleExportAll}
                        icon={<DownloadIcon size={10} className="text-neutral-500" />}
                        text="一键导出"
                        disabled={batchBusy}
                    />
                    <ToolBtn
                        onClick={handleImportAll}
                        icon={<UploadIcon size={10} className="text-neutral-500" />}
                        text="导入译文"
                        disabled={batchBusy}
                    />
                </div>
                <label className="flex items-center gap-1 text-[10px] text-neutral-500 select-none cursor-pointer">
                    <input
                        type="checkbox"
                        checked={localizableOnly}
                        onChange={e => setLocalizableOnly(e.target.checked)}
                        className="size-3"
                    />
                    仅导出 AI 判定可本地化的文本
                </label>
                <p className="text-[10px] text-neutral-400 leading-tight select-none">
                    格式：{exportFormat === "kvjson" ? "LinguaGacha KV-JSON" : "CSV(Key=id)"}（在设置页切换）
                </p>
                {aiRunning && (
                    <p className="text-[10px] text-neutral-400 leading-tight">识别中 {aiDone}/{aiTotal} 组</p>
                )}
                {batchMsg && (
                    <p className={`text-[10px] leading-tight px-1 py-0.5 rounded-sm break-all ${batchMsg.kind === "ok" ? "text-emerald-600 bg-emerald-50" : "text-red-600 bg-red-50"}`}>
                        {batchMsg.text}
                    </p>
                )}
            </div>
            <PatchDialog open={patchOpen} phase={patchPhase} errorMsg={patchError} dir={patchDir} onOpenChange={setPatchOpen} />
        </div>
    )
}

function ToolTitle({ title }: { title: string }) {
    return (
        <div className="flex items-center gap-1">
            <span className="text-[10px] text-neutral-400 font-sans leading-none select-none">{title}</span>
            <div className="flex-1 h-px bg-neutral-200"></div>
        </div>
    )
}

export function ToolBtn({ icon, text, onClick, disabled }: { icon: ReactNode, text: string, onClick?: () => void, disabled?: boolean }) {

    return (
        <div onClick={disabled ? undefined : onClick} className={`flex items-center px-1 h-6 justify-center gap-1 border rounded-sm ${disabled ? "opacity-50 cursor-not-allowed border-neutral-200" : "cursor-pointer hover:bg-muted/50 hover:border-gray-400"}`}>
            {icon}
            <span className="text-[10px] truncate leading-none select-none">{text}</span>
        </div>
    )
}