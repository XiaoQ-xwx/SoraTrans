import { useState } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { ExportOptions, LocalizableExportFormat } from "@/utils/LocalizableExport";

// 导出前先在应用内问清楚：格式（KV JSON / CSV）+ 排布（按对象拆分 / 合并）
// 不再依赖资源管理器的文件类型下拉，避免选错格式。
export default function ExportOptionsDialog({ open, onOpenChange, onConfirm }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onConfirm: (options: ExportOptions) => void;
}) {
    const [format, setFormat] = useState<LocalizableExportFormat>("json");
    const [split, setSplit] = useState(true);
    // 默认只导出可本地化文本；取消勾选则导出全部已提取文本
    const [onlyLocalizable, setOnlyLocalizable] = useState(true);


    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="w-[400px] gap-0 rounded-2xl p-5">
                <div className="text-sm leading-none font-semibold">一键导出</div>
                <div className="mt-1 text-[9px] text-muted-foreground">
                    先选格式与排布，再选导出位置
                </div>

                <label className="mt-3 flex cursor-pointer items-center gap-1.5 text-[10px] text-neutral-600 select-none">
                    <input
                        type="checkbox"
                        checked={onlyLocalizable}
                        onChange={(e) => setOnlyLocalizable(e.target.checked)}
                        className="size-3"
                    />
                    仅导出可本地化文本
                    <span className="text-[8px] text-neutral-400">不勾选则导出全部已提取文本</span>
                </label>

                <div className="mt-4 flex flex-col gap-2">
                    <span className="text-[10px] text-neutral-400 select-none">格式</span>
                    <Option
                        checked={format === "json"}
                        onSelect={() => setFormat("json")}
                        title="KV JSON"
                        desc='{"原文": "译文"}，LinguaGacha / MTool 等工具可直接读'
                    />
                    <Option
                        checked={format === "csv"}
                        onSelect={() => setFormat("csv")}
                        title="CSV"
                        desc="Key,Value 两列，适合需要稳定键的工具"
                    />
                </div>

                <div className="mt-3 flex flex-col gap-2">
                    <span className="text-[10px] text-neutral-400 select-none">排布</span>
                    <Option
                        checked={split}
                        onSelect={() => setSplit(true)}
                        title="每个资源对象一个文件（推荐）"
                        desc="文件名取对象名，例如 en.json / level0.json / model_ika1Avatar.json"
                    />
                    <Option
                        checked={!split}
                        onSelect={() => setSplit(false)}
                        title="合并成一个文件"
                        desc="全部可本地化文本写进同一个文件"
                    />
                </div>

                {split && (
                    <div className="mt-2 text-[8px] leading-tight text-neutral-400">
                        若存在同名对象，导出时会再询问一次如何处理
                    </div>
                )}

                <div className="mt-4 flex gap-2 border-t pt-3">
                    <Button variant="outline" size="sm" className="flex-1" onClick={() => onOpenChange(false)}>
                        取消
                    </Button>
                    <Button size="sm" className="flex-1" onClick={() => onConfirm({ format, split, onlyLocalizable })}>
                        开始导出
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function Option({ checked, onSelect, title, desc }: {
    checked: boolean;
    onSelect: () => void;
    title: string;
    desc: string;
}) {
    return (
        <button
            onClick={onSelect}
            className={`flex items-start gap-2 rounded-sm border px-2 py-1.5 text-left ${checked ? "border-blue-400 bg-blue-50/60" : "hover:bg-muted/40"}`}
        >
            <span className={`mt-[3px] flex size-3 shrink-0 items-center justify-center rounded-full border ${checked ? "border-blue-500" : "border-neutral-300"}`}>
                {checked && <span className="size-1.5 rounded-full bg-blue-500" />}
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[10px] font-medium leading-tight">{title}</span>
                <span className="text-[8px] leading-tight text-neutral-400">{desc}</span>
            </span>
        </button>
    );
}
