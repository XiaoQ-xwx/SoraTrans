import { useState } from "react";
import { DownloadIcon, Eraser, Sparkles, UploadIcon, XCircle, CheckCircle2, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { invoke } from "@tauri-apps/api/core";
import { useProjectInfoStore } from "@/model/ProjectInfo";
import JudgeDialog from "./JudgeDialog";
import { ToolBtn } from "./TranlateToolBar";
import { useJudgeProgress } from "@/utils/useJudgeProgress";
import { exportLocalizable, inspectDuplicateNames } from "@/utils/LocalizableExport";
import type { DuplicateNameGroup, ExportOptions, LocalizableExportResult } from "@/utils/LocalizableExport";
import ExportOptionsDialog from "./ExportOptionsDialog";
import DuplicateNameDialog from "./DuplicateNameDialog";
import { gm } from "@/utils/GameDbManager";
import type { LocalizableTextInfo } from "@/model/JudgeInfo";
import { importLocalizableTranslations } from "@/utils/LocalizableImport";
import type { LocalizableImportResult } from "@/utils/LocalizableImport";

// 翻译页的「AI 可本地化」面板：
//   1) AI 判断可本地化 —— 调用选定的决策模型（Jev 或 LLM）给每条文本打标
//   2) 一键导出       —— KV JSON（LinguaGacha）或 CSV，可只导可本地化
//   3) 导入译文       —— 把翻译结果按原文/id 写回，跨文件一次搞定
//   4) 重置标记       —— 清空全部判定结果，译文不受影响
export default function LocalizablePanel() {

    const [judgeOpen, setJudgeOpen] = useState(false);
    const [optionsOpen, setOptionsOpen] = useState(false);

    // 发现同名对象时暂存，等用户决定合并还是拆分
    const [dupPrompt, setDupPrompt] = useState<{
        list: LocalizableTextInfo[];
        options: ExportOptions;
        groups: DuplicateNameGroup[];
    } | null>(null);

    const [exporting, setExporting] = useState(false);
    const [exportResult, setExportResult] = useState<LocalizableExportResult | null>(null);
    const [exportError, setExportError] = useState("");

    const [importing, setImporting] = useState(false);
    const [importResult, setImportResult] = useState<LocalizableImportResult | null>(null);
    const [importError, setImportError] = useState("");

    // 重置 AI 可本地化标记（清空 text_judge）
    const [resetOpen, setResetOpen] = useState(false);
    const [resetting, setResetting] = useState(false);
    const [resetTip, setResetTip] = useState("");

    // 判定进度常驻显示，切页回来也能看到
    const total = useJudgeProgress((state) => state.total);
    const judged = useJudgeProgress((state) => state.judged);
    const localizable = useJudgeProgress((state) => state.localizable);
    const running = useJudgeProgress((state) => state.running);
    const judgeMessage = useJudgeProgress((state) => state.message);

    const current = useProjectInfoStore((state) => state.current);
    const infoList = useProjectInfoStore((state) => state.infoList);
    const title = infoList.find((item) => item.id === current)?.title ?? "soratrans";

    // 先弹应用内选项（格式 + 排布），再让用户选位置
    const handleExport = () => {
        if (exporting) return;
        setOptionsOpen(true);
    }

    // 真正的导出动作
    const runExport = async (options: ExportOptions, list: LocalizableTextInfo[]) => {
        setExportError("");
        setExportResult(null);
        setExporting(true);
        try {
            const result = await exportLocalizable(title, options, list);
            if (result) setExportResult(result);
        } catch (e) {
            setExportError(e instanceof Error ? e.message : String(e));
        } finally {
            setExporting(false);
        }
    }

    // 选完格式/排布后：先查有没有同名对象，有就再问一次
    const confirmExport = async (options: ExportOptions) => {
        setOptionsOpen(false);
        setExportError("");
        setExportResult(null);
        try {
            const list = await gm.selectExportTexts(options.onlyLocalizable);
            if (list.length === 0) {
                throw new Error("没有可本地化的文本，请先执行「AI 判断可本地化」");
            }
            if (options.split) {
                const groups = inspectDuplicateNames(list);
                if (groups.length > 0) {
                    setDupPrompt({ list, options, groups });
                    return;
                }
            }
            await runExport(options, list);
        } catch (e) {
            setExportError(e instanceof Error ? e.message : String(e));
        }
    }

    // 用户在重名弹窗里做了选择
    const handleDuplicateChoice = async (mergeSameName: boolean) => {
        const pending = dupPrompt;
        setDupPrompt(null);
        if (!pending) return;
        await runExport({ ...pending.options, mergeSameName }, pending.list);
    }

    // 清空全部判定结果：资源列表的「可本地化」列会全清，
    // 但已写好的译文 text_translate 不动（可以判完再判，不影响译文）
    const handleReset = async () => {
        if (resetting) return;
        setResetTip("");
        setResetting(true);
        try {
            await gm.clearJudgeResults();
            // 计数回到库里的真实状态（已判定归零）
            const progress = await gm.selectJudgeProgress();
            useJudgeProgress.getState().setCounts({
                total: progress.total,
                judged: progress.judged,
                localizable: progress.localizable,
            });
            useJudgeProgress.getState().setFailed(0);
            useJudgeProgress.getState().setMessage(`已重置判定标记：当前已判定 ${progress.judged}/${progress.total} 条`);
            // 通知资源列表刷新「可本地化」列
            useJudgeProgress.getState().bumpVersion();
            setResetOpen(false);
        } catch (e) {
            setResetTip(e instanceof Error ? e.message : String(e));
        } finally {
            setResetting(false);
        }
    }

    const handleImport = async () => {
        if (importing) return;
        setImportError("");
        setImportResult(null);
        setImporting(true);
        try {
            const result = await importLocalizableTranslations();
            if (result) setImportResult(result);
        } catch (e) {
            setImportError(e instanceof Error ? e.message : String(e));
        } finally {
            setImporting(false);
        }
    }

    return (
        <>
            <div className="w-full flex flex-col gap-1">
                <div className="flex items-center gap-1">
                    <span className="text-[10px] text-neutral-400 font-sans leading-none select-none">AI 可本地化</span>
                    <div className="flex-1 h-px bg-neutral-200"></div>
                </div>
                <div className="grid gap-1 lg:grid-cols-2 overflow-hidden">
                    <ToolBtn
                        onClick={() => setJudgeOpen(true)}
                        icon={<Sparkles size={10} className="text-neutral-500" />}
                        text="AI 判断可本地化"
                    />
                    <ToolBtn
                        onClick={handleExport}
                        icon={<DownloadIcon size={10} className="text-neutral-500" />}
                        text="一键导出"
                        disabled={exporting}
                    />
                    <ToolBtn
                        onClick={handleImport}
                        icon={<UploadIcon size={10} className="text-neutral-500" />}
                        text="导入译文"
                        disabled={importing}
                    />
                    <ToolBtn
                        onClick={() => { setResetTip(""); setResetOpen(true); }}
                        icon={<Eraser size={10} className="text-neutral-500" />}
                        text="重置标记"
                        disabled={resetting || running}
                    />
                </div>
                {(total > 0 || running) && (
                    <p className="px-1 text-[10px] leading-tight text-neutral-500">
                        {running ? "处理中… " : ""}已判定 {judged}/{total} · 可本地化 {localizable}
                    </p>
                )}
                {judgeMessage && (
                    <p className="px-1 text-[10px] leading-tight text-neutral-500 break-all">{judgeMessage}</p>
                )}
                {resetTip && (
                    <p className="px-1 text-[10px] leading-tight text-red-600 break-all">{resetTip}</p>
                )}

            </div>

            <JudgeDialog open={judgeOpen} onOpenChange={setJudgeOpen} />
            <ExportOptionsDialog
                open={optionsOpen}
                onOpenChange={setOptionsOpen}
                onConfirm={confirmExport}
            />
            <DuplicateNameDialog
                open={!!dupPrompt}
                groups={dupPrompt?.groups ?? []}
                onCancel={() => setDupPrompt(null)}
                onChoose={handleDuplicateChoice}
            />

            {/* 导出结果 */}
            <Dialog
                open={!!exportResult || !!exportError}
                onOpenChange={(next) => {
                    if (next) return;
                    setExportResult(null);
                    setExportError("");
                }}
            >
                <DialogContent className="w-[360px] gap-0 rounded-2xl p-5">
                    {
                        exportResult ? (
                            <>
                                <div className="flex items-center gap-3">
                                    <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-green-50">
                                        <CheckCircle2 className="size-6 text-green-600" />
                                    </div>
                                    <div className="flex min-w-0 flex-col gap-1">
                                        <div className="text-sm leading-none font-semibold">导出完成</div>
                                        <div className="text-[9px] text-muted-foreground">
                                            {exportResult.format === "json" ? "KV JSON" : "CSV"} · {exportResult.split ? "按对象拆分" : "合并单文件"} · {exportResult.textCount} 条文本 / {exportResult.entryCount} 个条目 / {exportResult.fileCount} 个对象
                                        </div>
                                    </div>
                                </div>
                                <div className="mt-4 min-w-0 rounded-lg bg-muted/50 p-2.5">
                                    <div className="text-[10px] text-muted-foreground select-none">
                                        {exportResult.split ? "导出目录" : "文件路径"}
                                    </div>
                                    <div className="mt-1 min-w-0 truncate font-mono text-[8px] leading-relaxed text-foreground/80">
                                        {exportResult.filePath}
                                    </div>
                                </div>
                                <div className="mt-4 flex gap-2 border-t pt-3">
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="flex-1 gap-1.5"
                                        onClick={() => {
                                            // 拆分模式 filePath 是目录，用 open_dir 直接打开它；
                                            // 合并模式是文件，用 open_folder 打开所在目录
                                            const cmd = exportResult.split ? "open_dir" : "open_folder";
                                            void invoke(cmd, { path: exportResult.filePath }).catch(() => {})
                                        }}
                                    >
                                        <FolderOpen className="size-3.5" />
                                        <span>打开文件夹</span>
                                    </Button>
                                    <Button size="sm" className="flex-1" onClick={() => setExportResult(null)}>
                                        完成
                                    </Button>
                                </div>
                            </>
                        ) : (
                            <>
                                <div className="flex items-start gap-3">
                                    <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-red-50">
                                        <XCircle className="size-6 text-red-600" />
                                    </div>
                                    <div className="flex min-w-0 flex-col gap-1">
                                        <div className="text-sm leading-none font-semibold">导出失败</div>
                                        <div className="text-[9px] text-muted-foreground">请确认已完成 AI 判断</div>
                                    </div>
                                </div>
                                <div className="mt-4 max-h-24 overflow-y-auto break-all rounded-lg bg-red-50 p-2.5 text-[10px] text-red-600">
                                    {exportError}
                                </div>
                                <div className="mt-4 border-t pt-3">
                                    <Button size="sm" className="w-full" onClick={() => setExportError("")}>
                                        确定
                                    </Button>
                                </div>
                            </>
                        )
                    }
                </DialogContent>
            </Dialog>

            {/* 导入结果 */}
            <Dialog
                open={!!importResult || !!importError}
                onOpenChange={(next) => {
                    if (next) return;
                    setImportResult(null);
                    setImportError("");
                }}
            >
                <DialogContent className="w-[360px] gap-0 rounded-2xl p-5">
                    {
                        importResult ? (
                            <>
                                <div className="flex items-center gap-3">
                                    <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-green-50">
                                        <CheckCircle2 className="size-6 text-green-600" />
                                    </div>
                                    <div className="flex min-w-0 flex-col gap-1">
                                        <div className="text-sm leading-none font-semibold">导入完成</div>
                                        <div className="text-[9px] text-muted-foreground">
                                            {importResult.fileCount} 个文件 · 解析 {importResult.pairCount} 条 / 写入 {importResult.writtenCount} 行
                                        </div>
                                    </div>
                                </div>
                                <div className="mt-3 grid grid-cols-2 gap-1.5 text-[10px]">
                                    <div className="flex h-6 items-center justify-between rounded-sm border px-2">
                                        <span className="text-[9px] text-neutral-400">长文本重建</span>
                                        <span className="font-mono text-neutral-600">{importResult.rebuiltCount}</span>
                                    </div>
                                    <div className="flex h-6 items-center justify-between rounded-sm border px-2">
                                        <span className="text-[9px] text-neutral-400">未译片段</span>
                                        <span className={`font-mono ${importResult.filledCount > 0 ? "text-amber-600" : "text-neutral-600"}`}>{importResult.filledCount}</span>
                                    </div>
                                    {
                                        importResult.missingCount > 0 && (
                                            <div className="flex h-6 items-center justify-between rounded-sm border px-2">
                                                <span className="text-[9px] text-neutral-400">缺口段未重建</span>
                                                <span className="font-mono text-amber-600">{importResult.missingCount}</span>
                                            </div>
                                        )
                                    }
                                </div>
                                {
                                    importResult.filledCount > 0 && (
                                        <p className="mt-2 text-[9px] leading-tight text-neutral-400">
                                            未译片段已按原文写入，游戏里这几处仍是原文；要补翻的话，把译文文件里对应条目的值改好再导入一次即可。
                                        </p>
                                    )
                                }
                                <div className="mt-4 border-t pt-3">
                                    <Button size="sm" className="w-full" onClick={() => setImportResult(null)}>
                                        完成
                                    </Button>
                                </div>
                            </>
                        ) : (
                            <>
                                <div className="flex items-start gap-3">
                                    <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-red-50">
                                        <XCircle className="size-6 text-red-600" />
                                    </div>
                                    <div className="flex min-w-0 flex-col gap-1">
                                        <div className="text-sm leading-none font-semibold">导入失败</div>
                                        <div className="text-[9px] text-muted-foreground">请确认译文文件格式正确</div>
                                    </div>
                                </div>
                                <div className="mt-4 max-h-24 overflow-y-auto break-all rounded-lg bg-red-50 p-2.5 text-[10px] text-red-600">
                                    {importError}
                                </div>
                                <div className="mt-4 border-t pt-3">
                                    <Button size="sm" className="w-full" onClick={() => setImportError("")}>
                                        确定
                                    </Button>
                                </div>
                            </>
                        )
                    }
                </DialogContent>
            </Dialog>

            {/* 重置标记确认 */}
            <Dialog open={resetOpen} onOpenChange={(next) => { if (!next && !resetting) setResetOpen(false); }}>
                <DialogContent showCloseButton={!resetting} className="w-[380px] gap-0 rounded-2xl p-5">
                    <div className="flex items-start gap-3">
                        <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-amber-50">
                            <Eraser className="size-6 text-amber-600" />
                        </div>
                        <div className="flex min-w-0 flex-col gap-1">
                            <div className="text-sm leading-none font-semibold">重置 AI 可本地化标记</div>
                            <div className="text-[9px] leading-tight text-muted-foreground">
                                会清空这个游戏的全部判定结果，资源列表的「可本地化」列会变空。
                                已经写好的译文不受影响，之后可以重新判定。
                            </div>
                        </div>
                    </div>
                    {resetTip && (
                        <p className="mt-3 rounded-lg bg-red-50 p-2 text-[10px] text-red-600 break-all">{resetTip}</p>
                    )}
                    <div className="mt-4 flex gap-2 border-t pt-3">
                        <Button
                            variant="outline"
                            size="sm"
                            className="flex-1"
                            disabled={resetting}
                            onClick={() => setResetOpen(false)}
                        >
                            取消
                        </Button>
                        <Button
                            size="sm"
                            className="flex-1"
                            disabled={resetting}
                            onClick={handleReset}
                        >
                            {resetting ? "重置中…" : "确认重置"}
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}
