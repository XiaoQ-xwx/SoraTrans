import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { DuplicateNameGroup } from "@/utils/LocalizableExport";

// 导出拆分时如果发现同名对象（Unity 里大量 UI 文本对象都叫 TextMeshProUGUI），
// 由用户决定是合并成一个文件还是各自单独成文件。
export default function DuplicateNameDialog({ open, groups, onCancel, onChoose }: {
    open: boolean;
    groups: DuplicateNameGroup[];
    onCancel: () => void;
    onChoose: (mergeSameName: boolean) => void;
}) {
    const totalObjects = groups.reduce((sum, group) => sum + group.count, 0);
    const preview = groups.slice(0, 6);

    return (
        <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
            <DialogContent className="w-[420px] gap-0 rounded-2xl p-5">
                <div className="text-sm leading-none font-semibold">发现同名对象</div>
                <div className="mt-1 text-[9px] text-muted-foreground">
                    {groups.length} 组同名对象，共 {totalObjects} 个对象。它们会导出成同名文件，需要你决定怎么处理。
                </div>

                <div className="mt-3 max-h-[150px] overflow-y-auto rounded-lg bg-muted/50 p-2">
                    {preview.map((group) => (
                        <div key={group.name} className="flex items-center justify-between py-0.5 text-[10px]">
                            <span className="truncate font-mono text-neutral-600">{group.name}</span>
                            <span className="shrink-0 pl-2 font-mono text-neutral-400">×{group.count}</span>
                        </div>
                    ))}
                    {groups.length > preview.length && (
                        <div className="pt-1 text-[9px] text-neutral-400">
                            …等共 {groups.length} 组
                        </div>
                    )}
                </div>

                <div className="mt-4 flex flex-col gap-2">
                    <Button size="sm" className="w-full" onClick={() => onChoose(true)}>
                        合并成一个文件（推荐）
                    </Button>
                    <Button variant="outline" size="sm" className="w-full" onClick={() => onChoose(false)}>
                        每个对象单独一个文件（会生成很多文件）
                    </Button>
                    <Button variant="ghost" size="sm" className="w-full" onClick={onCancel}>
                        取消
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
