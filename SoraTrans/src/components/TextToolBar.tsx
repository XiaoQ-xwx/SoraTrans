import { useTextOriginStore } from "@/model/TextOrigin"
import { useAssetObjectStore } from "@/model/AssetObjectInfo";
import { gm } from "@/utils/GameDbManager";
import { AiProgress, AiRunSummary } from "@/model/AiSettings";
import { Ban, CheckCircle2, DownloadIcon, Edit, FolderOpen, Layers, Loader2, Sparkles, UploadIcon, XCircle } from "lucide-react"
import { ReactNode, useEffect, useRef, useState } from "react"
import { Checkbox } from "@/components/ui/checkbox";
import { listen } from '@tauri-apps/api/event';
import { save, open } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import {
    extractTemplateAuto,
    LONG_TEXT_THRESHOLD,
    DEFAULT_COLUMN_MODE,
    type CsvColumnMode,
} from "@/utils/TextTemplate";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";

type ExportPhase = "exporting" | "done" | "error"

export default function TextToolBar() {

    const selectTextItem = useTextOriginStore((state) => state.selectTextItem)

    const setSelectTextItem = useTextOriginStore((state)=>state.setSelectTextItem)

    const handleEditBtn = () => {
        if (!selectTextItem?.id) return;
        gm.insertTrans(selectTextItem.id, selectTextItem.trans_text)
        useTextOriginStore.getState().updateListItem(selectTextItem)
    }

    // 导出动画弹窗状态：exporting 旋转动画 / done 完成 / error 失败
    const [exportOpen, setExportOpen] = useState(false)
    const [exportPhase, setExportPhase] = useState<ExportPhase>("exporting")
    const [exportError, setExportError] = useState("")
    const [exportPath, setExportPath] = useState("")
    // 同步守卫：防止保存对话框关闭到弹窗打开之间的重复点击
    const exportingRef = useRef(false)

    const handleExportOpenChange = (open: boolean) => {
        setExportOpen(open);
        if (!open) exportingRef.current = false;
    }

    const handleExportBtn = async () => {
        if (exportingRef.current) return;

        const list = useTextOriginStore.getState().list
        const title = useTextOriginStore.getState().title
        const initTitle = useTextOriginStore.getState().initTitle
        const isSubTitle = initTitle != title
        const filePath = await save({
            title: "导出翻译文件",
            defaultPath: isSubTitle ? `${initTitle}_${title}.csv` : `${title}.csv`,
            filters: [
                {
                    name: "CSV",
                    extensions: ["csv"],
                },
            ],
        });

        if (!filePath) return;

        exportingRef.current = true;
        setExportPath(filePath)
        setExportError("")
        setExportPhase("exporting")
        setExportOpen(true)
        // 先让旋转动画绘制一帧，再执行同步的提取/序列化，
        // 否则数据量大时主线程阻塞，弹窗会直接跳到完成态
        await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(null)))
        );

        try {
            // CSV 每行一个条目：键,文本，首行固定表头 Key,Value
            // 普通文本键为 id；超长文本拆成 id:{0}、id:{1} ... 每行一个片段，
            // 同时把片段换成占位符的模板回写到 text_origin.text_template
            const lines: string[] = ["Key,Value"];
            const templateUpdates: { id: number, text_template: string }[] = [];
            // 与「一键导出」共用同一个固定口径（日文列 + 英文列一起导）
            const columnMode: CsvColumnMode = DEFAULT_COLUMN_MODE;

            for (const text of list) {
                if (text.origin_text.length > LONG_TEXT_THRESHOLD) {
                    const { template, placeholders } = extractTemplateAuto(text.origin_text, "ja", columnMode);
                    if (Object.keys(placeholders).length > 0) {
                        for (const [token, content] of Object.entries(placeholders)) {
                            lines.push(`${csvEscape(`${text.id}:${token}`)},${csvEscape(content)}`);
                        }
                        templateUpdates.push({ id: text.id, text_template: template });
                        continue;
                    }
                }
                lines.push(`${text.id},${csvEscape(text.origin_text)}`);
            }

            await writeTextFile(filePath, lines.join("\n"));

            if (templateUpdates.length > 0) {
                await gm.updateTextTemplates(templateUpdates);
                const templateMap = new Map(templateUpdates.map(item => [item.id, item.text_template]));
                useTextOriginStore.getState().setList(
                    useTextOriginStore.getState().list.map(item => {
                        const textTemplate = templateMap.get(item.id);
                        return textTemplate !== undefined
                            ? { ...item, text_template: textTemplate }
                            : item;
                    })
                );
            }
            setExportPhase("done")
        } catch (error) {
            // 失败也必须收口到 error 态，不能让弹窗永久停在旋转中
            console.log(`err: ${error}`)
            setExportError(String(error))
            setExportPhase("error")
        }
    }

    const handleImportBtn = async () => {
        const file = await open({
            multiple: false,
            directory: false,
            title: "选择翻译 CSV 文件",
            filters: [
                {
                    name: "CSV",
                    extensions: ["csv"],
                },
            ],
        });

        if (!file || Array.isArray(file)) return;

        try {
            const list = useTextOriginStore.getState().list
            const text = await readTextFile(file);
            const rows = parseCsvRows(text);

            // 跳过首行表头 Key,Value
            if (rows.length > 0 && rows[0][0] === "Key" && rows[0][1] === "Value") {
                rows.shift();
            }

            // CSV 键格式：普通文本 "id,译文"；长文本 "id:{0},译文片段"，
            // 按 id 分组后用模板重组完整译文
            // both 口径的键形如 123:{e0}（英文列）/ 123:{j1}（日文列），单列是 123:{0}
            const LONG_KEY_PATTERN = /^(\d+):(\{[ej]?\d+\})$/;
            const normalMap = new Map<number, string>();
            const longParts = new Map<number, Record<string, string>>();

            for (const [key, value] of rows) {
                const match = LONG_KEY_PATTERN.exec(key);
                if (match) {
                    const id = Number(match[1]);
                    const parts = longParts.get(id) ?? {};
                    parts[match[2]] = value;
                    longParts.set(id, parts);
                } else if (/^\d+$/.test(key)) {
                    normalMap.set(Number(key), value);
                } else {
                    throw new Error(`无法识别的键 "${key}"，应为 id 或 id:{占位符}`);
                }
            }
            const templateMap = await gm.selectTextTemplates([...longParts.keys()]);

            // 模板中的 {0}/{1} 占位符
            const TOKEN_PATTERN = /\{[ej]?\d+\}/g;

            const newList = list.map(item => {
                // 普通文本：译文直接入库
                const normal = normalMap.get(item.id);
                if (normal !== undefined) {
                    return { ...item, trans_text: normal };
                }

                // 长文本：按 id 查出模板，把占位符逐个替换为对应译文，重组完整译文
                const parts = longParts.get(item.id);
                if (parts === undefined) { return item; }

                const template = templateMap.get(item.id);
                if (template === undefined) {
                    throw new Error(`id ${item.id} 缺少再提取模板，请重新导出后再导入`);
                }
                const transText = template.replace(TOKEN_PATTERN, (token) => {
                    const translated = parts[token];
                    if (translated === undefined) {
                        throw new Error(`id ${item.id} 缺少占位符 ${token} 的译文`);
                    }
                    return translated;
                });

                return { ...item, trans_text: transText };
            });

            useTextOriginStore.getState().updateList(newList)
            await gm.insertBatchTrans(newList)
        } catch (error) {
            console.log(`err: ${error}`)
        }

    }

    // ============ AI 识别 ============
    const [aiRunning, setAiRunning] = useState(false)
    const [aiCancelling, setAiCancelling] = useState(false)
    const [aiDone, setAiDone] = useState(0)
    const [aiTotal, setAiTotal] = useState(0)
    const [aiSummary, setAiSummary] = useState<AiRunSummary | null>(null)
    const [aiError, setAiError] = useState("")
    // 同步守卫：state 更新是异步的，同一帧内重复点击会穿透（与导出功能的 exportingRef 一致）
    const aiRunningRef = useRef(false)
    const localizableOnly = useTextOriginStore((state) => state.localizableOnly)
    const setLocalizableOnly = useTextOriginStore((state) => state.setLocalizableOnly)

    // 识别进度由 Rust 侧事件推送；结束态（finished）由返回值汇总呈现
    useEffect(() => {
        const un = listen<AiProgress>("ai-recognition-progress", (event) => {
            const p = event.payload
            if (p.finished) return
            setAiDone(p.done)
            setAiTotal(p.total)
        })
        return () => { un.then(fn => fn()) }
    }, [])

    // objectId 传 null 表示识别全库分组
    const runAi = async (objectId: number | null) => {
        if (aiRunningRef.current) return
        aiRunningRef.current = true
        setAiError("")
        setAiSummary(null)
        setAiCancelling(false)
        setAiRunning(true)
        try {
            const summary = await gm.runAiRecognition(objectId)
            setAiSummary(summary)
            if (summary.lastError) setAiError(`部分分组识别失败：${summary.lastError}`)
        } catch (e) {
            setAiError(String(e))
        } finally {
            aiRunningRef.current = false
            setAiRunning(false)
            setAiCancelling(false)
        }
    }

    const handleAiBtn = () => {
        const objId = useAssetObjectStore.getState().id
        if (!objId) {
            setAiError("尚未选择资源对象")
            return
        }
        runAi(objId)
    }

    const handleAiAllBtn = () => {
        runAi(null)
    }

    const handleCancelAi = async () => {
        // 取消只置位标志：后端会在 200ms 内丢弃在途请求并收尾
        setAiCancelling(true)
        try { await gm.cancelAiRecognition() } catch { setAiCancelling(false) }
    }

    //TODO: 打开编辑器编辑

    return (
        <div className="px-2 py-3 flex h-full flex-col gap-1 py-1 overflow-hidden lg:py-4">
            <div className="w-full flex flex-col gap-2 py-1">
                <ToolTitle title="属性" />
                <div className="leading-none flex flex-col gap-1 overflow-hidden">
                    <p className="text-[10px] text-neutral-400 leading-none select-none">id</p>
                    <p className="border px-2 h-6 flex items-center font-mono rounded-sm text-[10px] truncate">{selectTextItem?.id}</p>
                </div>
                <div className="leading-none flex flex-col gap-1 overflow-hidden">
                    <p className="text-[10px] text-neutral-400 leading-none select-none">原文</p>
                    <p className="border px-1 flex h-10 items-center font-san rounded-sm text-[10px]">
                        <textarea defaultValue={selectTextItem?.origin_text ?? ""} disabled={true} className="w-full h-[30px] overflow-y-scroll resize-none flex items-center justify-between font-san text-[10px] scrollbar-none" />
                    </p>
                </div>
                <div className="leading-none flex flex-col gap-1 overflow-hidden">
                    <p className="text-[10px] text-neutral-400 leading-none select-none">译文</p>
                    <p className="border px-1 flex h-10 items-center font-san rounded-sm text-[10px]">
                        <textarea value={selectTextItem?.trans_text ?? ""} onChange={e => {
                                    if (!selectTextItem) return;
                                        setSelectTextItem({
                                            ...selectTextItem,
                                            trans_text: e.target.value,
                                        });
                        }} className="w-full h-[30px] overflow-y-scroll outline-none resize-none flex items-center justify-between font-san text-[10px] scrollbar-none" />
                    </p>
                </div>
                <div>
                    <ToolBtn icon={<Edit size={10} className="text-neutral-500" />} onClick={handleEditBtn} text="修改" />
                </div>
            </div>
            <div className="w-full flex flex-col gap-2 ">
                <ToolTitle title="批量操作" />
                <div className="grid gap-1 md:grid-cols-2 overflow-hidden">
                    <ToolBtn onClick={handleImportBtn} icon={<UploadIcon size={10} className="text-neutral-500" />} text="导入所有译文" />
                    <ToolBtn onClick={handleExportBtn} icon={<DownloadIcon size={10} className="text-neutral-500" />} text="导出所有原文" />
                </div>
            </div>
            <div className="w-full flex flex-col gap-2">
                <ToolTitle title="AI 识别" />
                <div className="grid gap-1 md:grid-cols-2 overflow-hidden">
                    <ToolBtn
                        onClick={handleAiBtn}
                        title="识别当前资源对象涉及的文本分组"
                        icon={aiRunning
                            ? <Loader2 size={10} className="animate-spin text-neutral-500" />
                            : <Sparkles size={10} className="text-neutral-500" />}
                        text={aiRunning
                            ? (aiCancelling ? "取消中..." : "识别中...")
                            : "AI 识别"}
                    />
                    {aiRunning
                        ? <ToolBtn
                            onClick={handleCancelAi}
                            title="丢弃在途请求并停止后续批次"
                            icon={<Ban size={10} className="text-neutral-500" />}
                            text="取消"
                        />
                        : <ToolBtn
                            onClick={handleAiAllBtn}
                            title="识别当前游戏的全部分组"
                            icon={<Layers size={10} className="text-neutral-500" />}
                            text="识别全部"
                        />}
                </div>
                <p className="text-[10px] text-neutral-400 select-none leading-relaxed">
                    标注按结构分组（Pattern）保存，同结构分组在各对象间共享。
                </p>
                {aiRunning && (
                    <p className="text-[10px] text-neutral-400 select-none leading-none">已识别 {aiDone}/{aiTotal} 组</p>
                )}
                {!aiRunning && aiSummary && (
                    <p className="text-[10px] text-neutral-400 select-none leading-relaxed">
                        已标注 {aiSummary.updated}/{aiSummary.totalPatterns} 组
                        {aiSummary.cancelled ? "（已取消）" : ""}
                        {aiSummary.failedBatches > 0 ? `，${aiSummary.failedBatches} 批失败` : ""}
                    </p>
                )}
                {aiError && <p className="text-[10px] text-red-500 break-all leading-relaxed">{aiError}</p>}
                <div className="flex items-center gap-1.5 py-0.5">
                    <Checkbox
                        id="ai-localizable-only"
                        checked={localizableOnly}
                        onCheckedChange={(v) => setLocalizableOnly(v === true)}
                        className="size-3"
                    />
                    <label htmlFor="ai-localizable-only" className="text-[10px] text-neutral-500 select-none cursor-pointer">仅显示可本地化</label>
                </div>
            </div>
            <ExportDialog
                open={exportOpen}
                phase={exportPhase}
                errorMsg={exportError}
                filePath={exportPath}
                onOpenChange={handleExportOpenChange}
            />
        </div>
    )
}

// 导出动画弹窗：进行中展示旋转动画且禁止关闭，完成/失败后由用户手动关闭
function ExportDialog({ open, phase, errorMsg, filePath, onOpenChange }: {
    open: boolean,
    phase: ExportPhase,
    errorMsg: string,
    filePath: string,
    onOpenChange: (open: boolean) => void,
}) {
    const guardExporting = (e: Event) => {
        if (phase == "exporting") e.preventDefault()
    }

    const handleOpenFolder = () => {
        if (!filePath) return;
        invoke("open_folder", { path: filePath })
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(o) => {
                if (phase == "exporting") return;
                onOpenChange(o)
            }}
        >
            <DialogContent
                showCloseButton={phase != "exporting"}
                onEscapeKeyDown={guardExporting}
                onInteractOutside={guardExporting}
                className={`gap-0 rounded-2xl ${phase == "exporting" ? "w-72 p-5" : "w-[340px] p-5"}`}
            >
                {
                    phase == "exporting" && (
                        <div className="flex items-center gap-3">
                            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-blue-50">
                                <Loader2 className="size-5 animate-spin text-blue-600" />
                            </div>
                            <div className="flex flex-col gap-1 pt-0.5">
                                <div className="text-sm leading-none font-semibold">正在导出</div>
                                <div className="text-[8px] text-muted-foreground">正在生成翻译文件，请勿关闭窗口...</div>
                            </div>
                        </div>
                    )
                }
                {
                    phase == "done" && (
                        <>
                            <div className="flex items-center gap-3">
                                <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-green-50">
                                    <CheckCircle2 className="size-6 text-green-600" />
                                </div>
                                <div className="flex flex-col justify-center gap-1 pt-1 min-w-0">
                                    <div className="text-sm leading-none font-semibold">导出完成</div>
                                    <div className="text-[8px] text-muted-foreground">翻译文件已成功导出</div>
                                </div>
                            </div>
                            <div className="mt-4 min-w-0 rounded-lg bg-muted/50 p-2.5">
                                <div className="text-[10px] text-muted-foreground select-none">文件路径</div>
                                <div className="mt-1 min-w-0 truncate font-mono text-[8px] leading-relaxed text-foreground/80">
                                    {filePath}
                                </div>
                            </div>
                            <div className="mt-4 min-w-0 border-t pt-3">
                                <div className="flex gap-2">
                                    <Button variant="outline" size="sm" onClick={handleOpenFolder} className="flex-1 gap-1.5">
                                        <FolderOpen className="size-3.5" />
                                        <span>打开文件夹</span>
                                    </Button>
                                    <Button size="sm" onClick={() => onOpenChange(false)} className="flex-1">
                                        完成
                                    </Button>
                                </div>
                            </div>
                        </>
                    )
                }
                {
                    phase == "error" && (
                        <>
                            <div className="flex items-start gap-3">
                                <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-red-50">
                                    <XCircle className="size-6 text-red-600" />
                                </div>
                                <div className="flex flex-col gap-1 pt-1 min-w-0">
                                    <div className="text-base leading-none font-semibold">导出失败</div>
                                    <div className="text-[10px] text-muted-foreground">导出过程中出现错误，请重试</div>
                                </div>
                            </div>
                            <div className="mt-4 min-w-0 max-h-24 overflow-y-auto rounded-lg bg-red-50 p-2.5">
                                <div className="text-[10px] text-red-400 select-none">错误信息</div>
                                <div className="mt-1.5 min-w-0 break-all font-mono text-[11px] leading-relaxed text-red-600">
                                    {errorMsg}
                                </div>
                            </div>
                            <div className="mt-4 min-w-0 border-t pt-3">
                                <Button size="sm" onClick={() => onOpenChange(false)} className="w-full">
                                    确定
                                </Button>
                            </div>
                        </>
                    )
                }
            </DialogContent>
        </Dialog>
    )
}

// CSV 字段转义：含逗号/引号/换行时用双引号包裹，内部引号双写
export function csvEscape(s: string): string {
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// 解析 CSV 为 [键, 值] 行，支持引号包裹的多行字段与 "" 转义引号
export function parseCsvRows(text: string): [string, string][] {
    const rows: [string, string][] = [];
    let field = "";
    let row: string[] = [];
    let inQuotes = false;
    let i = text.startsWith("﻿") ? 1 : 0;

    const pushField = () => { row.push(field); field = ""; };
    const pushRow = () => {
        if (row.length > 1 || row[0] !== "") {
            if (row.length !== 2) throw new Error(`CSV 格式错误：每行应为 键,值 两列，实际 ${row.length} 列`);
            rows.push([row[0], row[1]]);
        }
        row = [];
    };

    while (i < text.length) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
                inQuotes = false; i++; continue;
            }
            field += c; i++; continue;
        }
        if (c === '"') { inQuotes = true; i++; continue; }
        if (c === ',') { pushField(); i++; continue; }
        if (c === '\n' || c === '\r') {
            pushField(); pushRow();
            if (c === '\r' && text[i + 1] === '\n') i++;
            i++; continue;
        }
        field += c; i++;
    }
    pushField(); pushRow();

    if (inQuotes) throw new Error("CSV 格式错误：存在未闭合的引号");
    return rows;
}

function ToolTitle({ title }: { title: string }) {
    return (
        <div className="flex items-center gap-1">
            <span className="text-[10px] text-neutral-400 font-sans leading-none select-none">{title}</span>
            <div className="flex-1 h-px bg-neutral-200"></div>
        </div>
    )
}

export function ToolBtn({ icon, text, onClick, title }: { icon: ReactNode, text: string, onClick?: () => void, title?: string }) {

    return (
        <div onClick={onClick} title={title} className="flex cursor-pointer hover:bg-muted/50 hover:border-gray-400 items-center px-1 h-6 justify-center gap-1 border rounded-sm">
            {icon}
            <span className="text-[10px] truncate leading-none select-none">{text}</span>
        </div>
    )
}