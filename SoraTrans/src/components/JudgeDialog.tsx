import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useJudgeProgress } from "@/utils/useJudgeProgress";
import { cancelJudge, runJudge, runReviewOnly } from "@/utils/JudgeRunner";
import { JUDGE_MODES, loadModelSetting, validateModelSetting } from "@/utils/AppSetting";
import type { JudgeMode, ModelSetting } from "@/utils/AppSetting";
import { useEffect, useState } from "react";
import { Sparkles } from "lucide-react";

// AI 可本地化判定弹窗：开始/继续/重新判定 + 实时进度
export default function JudgeDialog({ open, onOpenChange }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const running = useJudgeProgress((state) => state.running);
    const total = useJudgeProgress((state) => state.total);
    const judged = useJudgeProgress((state) => state.judged);
    const localizable = useJudgeProgress((state) => state.localizable);
    const failed = useJudgeProgress((state) => state.failed);
    const requests = useJudgeProgress((state) => state.requests);
    const estimatedTokens = useJudgeProgress((state) => state.estimatedTokens);
    const message = useJudgeProgress((state) => state.message);

    const [setting, setSetting] = useState<ModelSetting | null>(null);
    const [error, setError] = useState("");
    // 本次判定模式与是否启用 LLM 复审，打开弹窗时按配置初始化，可在弹窗里直接改
    const [mode, setMode] = useState<JudgeMode>("jev");
    const [review, setReview] = useState(false);
    // 手动「LLM 复审」的范围：low = 只复核低可信度的，all = 全部复核
    const [reviewScope, setReviewScope] = useState<"low" | "all">("low");


    useEffect(() => {
        if (!open) return;
        setError("");
        loadModelSetting()
            .then((value) => {
                setSetting(value);
                setMode(value.judge_mode);
                // 复审默认不启动：每次都从"未勾选"开始，必须手动勾选才会跑
                setReview(false);
            })
            .catch(() => setError("读取模型设置失败"));
    }, [open]);

    // 单独跑一次 LLM 复审：范围由 reviewScope 决定
    const handleReview = async () => {
        setError("");
        try {
            await runReviewOnly(reviewScope === "all");
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    };

    const handleStart = async (reset: boolean) => {
        setError("");
        try {
            await runJudge({ reset, review, mode });
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    };

    const percent = total > 0 ? Math.min(100, Math.round((judged * 100) / total)) : 0;
    // 配置不完整时直接提示，避免点了才在后台报错
    const invalid = setting ? validateModelSetting(setting) : null;

    return (
        <Dialog open={open} onOpenChange={(next) => { if (!running) onOpenChange(next); }}>
            <DialogContent showCloseButton={!running} className="w-[380px] gap-0 rounded-2xl p-5">
                <div className="flex items-center gap-3">
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-blue-50">
                        <Sparkles className="size-5 text-blue-600" />
                    </div>
                    <div className="flex min-w-0 flex-col gap-1">
                        <div className="text-sm leading-none font-semibold">AI 判断可本地化</div>
                        <div className="text-[9px] text-muted-foreground">
                            决策模型粗筛，低置信度条目交 LLM 复核
                        </div>
                    </div>
                </div>

                <div className="mt-4 flex flex-col gap-2">
                    <Progress value={percent} />
                    <div className="flex justify-between text-[9px] text-neutral-500">
                        <span>已判定 {judged} / {total}</span>
                        <span>{percent}%</span>
                    </div>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-1.5 text-[10px]">
                    <Stat label="可本地化" value={localizable} tone="text-emerald-600" />
                    <Stat label="判定失败" value={failed} tone="text-red-500" />
                    <Stat label="请求数" value={requests} tone="text-neutral-600" />
                    <Stat label="预估输入 token" value={estimatedTokens} tone="text-neutral-600" />
                </div>

                {
                    setting && (
                        <div className="mt-3 rounded-lg bg-muted/50 p-2 text-[9px] text-neutral-500 leading-relaxed">
                            <div>
                                决策模型：{mode === "jev" ? `${setting.jev_model}（Jev）` : `${setting.llm_model}（LLM）`}
                            </div>
                            <div>复审模型：{review ? `${setting.llm_model}（LLM）` : "不启用"}</div>
                            <div>阈值：≥{setting.threshold_high} 可本地化，≤{setting.threshold_low} 不可</div>
                        </div>
                    )
                }

                {
                    setting && (
                        <div className="mt-2 flex flex-col gap-1.5 rounded-lg border p-2">
                            <div className="flex items-center gap-2">
                                <span className="text-[10px] text-neutral-400 select-none">判定模式</span>
                                <select
                                    value={mode}
                                    disabled={running}
                                    onChange={(e) => setMode(e.target.value as JudgeMode)}
                                    className="h-6 flex-1 rounded-sm border px-1 text-[10px] outline-none focus:border-blue-400"
                                >
                                    {JUDGE_MODES.map((item) => (
                                        <option key={item.value} value={item.value}>{item.label}</option>
                                    ))}
                                </select>
                            </div>
                            <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-neutral-600 select-none">
                                <input
                                    type="checkbox"
                                    checked={review}
                                    disabled={running}
                                    onChange={(e) => setReview(e.target.checked)}
                                    className="size-3"
                                />
                                自动启用 LLM 复审
                                <span className="text-[8px] text-neutral-400">
                                    判定时遇到判不准（{setting.threshold_low}~{setting.threshold_high}）的条目自动交 LLM；
                                    也可以事后用「LLM 复审」按钮单独跑
                                </span>
                            </label>
                        </div>
                    )
                }

                {
                    // 优先展示真实错误，其次是判定结果消息；配置提示只在空闲且无消息时出现，
                    // 否则"配置不完整"会永久盖住"判定中断：401 ..."
                    (error || message || (invalid && !running)) && (
                        <div className="mt-3 max-h-24 overflow-y-auto break-all rounded-lg bg-muted/50 p-2 text-[9px] leading-relaxed text-neutral-600">
                            {error || message || invalid}
                        </div>
                    )
                }

                <div className="mt-4 flex flex-col gap-2 border-t pt-3">
                    {
                        running ? (
                            <Button variant="outline" size="sm" onClick={cancelJudge} className="w-full">
                                中止
                            </Button>
                        ) : (
                            <>
                                <div className="flex gap-2">
                                    <Button
                                        size="sm"
                                        className="flex-1"
                                        disabled={!!invalid}
                                        onClick={() => handleStart(false)}
                                    >
                                        继续判定
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="flex-1"
                                        disabled={!!invalid}
                                        onClick={() => handleStart(true)}
                                    >
                                        重新判定
                                    </Button>
                                </div>
                                <div className="flex gap-2">
                                    <select
                                        value={reviewScope}
                                        disabled={!!invalid}
                                        onChange={(e) => setReviewScope(e.target.value as "low" | "all")}
                                        className="h-8 flex-1 rounded-sm border px-2 text-[10px] outline-none focus:border-blue-400"
                                    >
                                        <option value="low">低可信度</option>
                                        <option value="all">全部复核</option>
                                    </select>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="flex-1"
                                        disabled={!!invalid}
                                        onClick={handleReview}
                                    >
                                        LLM 复审
                                    </Button>
                                </div>
                            </>
                        )
                    }
                </div>
            </DialogContent>
        </Dialog>
    );
}

function Stat({ label, value, tone }: { label: string, value: number, tone: string }) {
    return (
        <div className="flex items-center justify-between border rounded-sm px-2 h-6">
            <span className="text-[9px] text-neutral-400 select-none">{label}</span>
            <span className={`font-mono ${tone}`}>{value}</span>
        </div>
    );
}
