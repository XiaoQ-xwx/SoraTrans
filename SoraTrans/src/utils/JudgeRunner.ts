import type { JudgeTargetInfo, TextJudgeInfo } from "@/model/JudgeInfo";
import { gm } from "./GameDbManager";
import { loadModelSetting, modeUsesJev, validateModelSetting } from "./AppSetting";
import type { JudgeMode, ModelSetting } from "./AppSetting";
import { judgeBatchByJev, JEV_MAX_QUESTIONS } from "./JevClient";
import type { JudgeQuestionItem } from "./JevClient";
import { judgeBatchByLlm, LLM_BATCH_SIZE } from "./LlmClient";
import type { LlmJudgeItem } from "./LlmClient";
import { useJudgeProgress } from "./useJudgeProgress";

// 判定流水线：选定的决策模型（Jev / LLM）输出"可本地化可能性"，按阈值分档入库。
// 概率落在 (low, high) 区间的条目按 0.5 兜底判定，并保留原始分数作为置信度。
// 每批按 id 游标增量拉取，中断后再次运行会从"未判定"处继续。

/// 每次从库里拉多少条待判定文本
const FETCH_BATCH = 64;
/// 跑几轮：首轮失败/漏判的条目在第二轮（only_unjudged 只取未判定项）再试一次
const MAX_PASSES = 2;

// 模块级状态：同一时间只允许一个判定任务
let running = false;
let cancelled = false;

export function cancelJudge(): void {
    if (!running) return;
    cancelled = true;
    useJudgeProgress.getState().setMessage("正在中止…");
}

/// 开始/继续判定。
/// reset = true 时先清空历史结果重新判定
/// mode  = 本次判定模式（不传则用配置里的默认值）
export async function runJudge(options: { reset?: boolean; mode?: JudgeMode } = {}): Promise<void> {
    // 先抢占用位再 await：否则双击「继续判定」会并发起两个任务，
    // 两边游标都从 0 开始，结果互相覆盖、API 被重复计费
    if (running) return;
    running = true;
    cancelled = false;

    useJudgeProgress.getState().start();

    try {
        const loaded = await loadModelSetting();
        const setting: ModelSetting = {
            ...loaded,
            judge_mode: options.mode ?? loaded.judge_mode,
        };
        const invalid = validateModelSetting(setting);
        if (invalid) {
            useJudgeProgress.getState().finish(invalid);
            return;
        }

        if (options.reset) {
            await gm.clearJudgeResults();
        }

        const initial = await gm.selectJudgeProgress();
        useJudgeProgress.getState().setCounts({
            total: initial.total,
            judged: initial.judged,
            localizable: initial.localizable,
        });
        if (initial.total === 0) {
            useJudgeProgress.getState().finish("当前游戏还没有提取出任何文本，请先执行扫描/提取");
            return;
        }

        // 进度用本地累加，避免每批都全表 COUNT、并反复触发资源列表全量刷新
        let writtenJudged = 0;
        let writtenLocalizable = 0;
        const errors: string[] = [];

        for (let pass = 0; pass < MAX_PASSES && !cancelled; pass++) {
            let cursor = 0;
            let writtenInPass = 0;

            while (!cancelled) {
                const targets = await gm.selectJudgeTargets(cursor, FETCH_BATCH, true);
                if (targets.length === 0) break;
                cursor = targets[targets.length - 1].id;

                const results = await judgeTargets(targets, setting, errors);
                if (results.length === 0) continue;

                await gm.insertJudgeResults(results);
                writtenInPass += results.length;
                writtenJudged += results.length;
                writtenLocalizable += results.filter((item) => item.localizable === 1).length;

                useJudgeProgress.getState().setCounts({
                    judged: initial.judged + writtenJudged,
                    localizable: initial.localizable + writtenLocalizable,
                });
            }

            // 本轮一条都没写进去，再跑一轮也只会空转
            if (writtenInPass === 0) break;
        }

        // 结束时查一次库拿准确值（覆盖写会让本地累加偏大）
        const finalProgress = await gm.selectJudgeProgress();
        useJudgeProgress.getState().setCounts({
            total: finalProgress.total,
            judged: finalProgress.judged,
            localizable: finalProgress.localizable,
        });
        useJudgeProgress.getState().bumpVersion();

        const pending = Math.max(0, finalProgress.total - finalProgress.judged);
        useJudgeProgress.getState().setFailed(pending);
        const errorHint = errors.length > 0 ? `；最后错误：${errors[errors.length - 1]}` : "";

        if (cancelled) {
            useJudgeProgress.getState().finish(
                `已中止：已判定 ${finalProgress.judged}/${finalProgress.total} 条，其中可本地化 ${finalProgress.localizable} 条${errorHint}`
            );
        } else {
            useJudgeProgress.getState().finish(
                `判定完成：共 ${finalProgress.total} 条，可本地化 ${finalProgress.localizable} 条` +
                (pending > 0 ? `，${pending} 条未判定（可再次继续）` : "") +
                errorHint
            );
        }
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        useJudgeProgress.getState().finish(`判定中断：${message}`);
        throw e;
    } finally {
        running = false;
        cancelled = false;
    }
}

/// 判定一批文本，返回可入库的结果。errors 用于把首个真实错误透出到界面
async function judgeTargets(
    targets: JudgeTargetInfo[],
    setting: ModelSetting,
    errors: string[],
): Promise<TextJudgeInfo[]> {
    const store = useJudgeProgress.getState();
    const mode = setting.judge_mode;
    const decided = new Map<number, TextJudgeInfo>();
    // 决策模型给出的"可本地化可能性"，用于落在阈值区间时按 0.5 兜底
    const scores = new Map<number, number>();

    if (modeUsesJev(mode)) {
        // ---- 决策引擎：Jev（每请求最多 8 题）----
        const groups = chunk(targets, JEV_MAX_QUESTIONS);
        await runPool(groups, Math.max(1, setting.concurrency), async (group) => {
            const items: JudgeQuestionItem[] = group.map((target) => ({
                key: String(target.id),
                text: target.text,
                context: describeTarget(target),
            }));
            store.addRequest(1);
            try {
                const answers = await judgeBatchByJev(items, setting);
                store.addTokens(estimateTokens(items));
                for (const target of group) {
                    const probability = answers.get(String(target.id));
                    if (probability === undefined) {
                        continue;
                    }
                    scores.set(target.id, probability);
                    if (probability >= setting.threshold_high) {
                        decided.set(target.id, buildJudge(target, 1, probability, "jev", null, setting.jev_model));
                    } else if (probability <= setting.threshold_low) {
                        decided.set(target.id, buildJudge(target, 0, probability, "jev", null, setting.jev_model));
                    }
                }
            } catch (e) {
                errors.push(errorText("Jev", e));
            }
        });
    } else {
        // ---- 决策引擎：LLM（每请求 10 条）----
        const groups = chunk(targets, LLM_BATCH_SIZE);
        await runPool(groups, Math.max(1, setting.concurrency), async (group) => {
            const items: LlmJudgeItem[] = group.map((target) => ({
                key: String(target.id),
                text: target.text,
                context: describeTarget(target),
            }));
            store.addRequest(1);
            try {
                const judged = await judgeBatchByLlm(items, setting);
                store.addTokens(estimateTokens(items));
                const missing = group.filter((target) => !judged.has(String(target.id)));
                if (missing.length > 0) errors.push(`LLM 漏答 ${missing.length} 条文本`);
                for (const target of group) {
                    const result = judged.get(String(target.id));
                    if (!result) {
                        continue;
                    }
                    scores.set(target.id, result.score);
                    // 决策路径统一写 checked_by_llm = 0，与历史数据保持一致
                    if (result.score >= setting.threshold_high) {
                        decided.set(target.id, buildJudge(target, 1, result.score, "llm", result.reason, setting.llm_model));
                    } else if (result.score <= setting.threshold_low) {
                        decided.set(target.id, buildJudge(target, 0, result.score, "llm", result.reason, setting.llm_model));
                    }
                }
            } catch (e) {
                errors.push(errorText("LLM", e));
            }
        });
    }

    for (const target of targets) {
        if (decided.has(target.id)) continue;
        const score = scores.get(target.id);
        if (score !== undefined) {
            // 概率落在阈值区间的兜底：按 0.5 折中，仍保留原始分数作为置信度
            decided.set(target.id, buildJudge(
                target,
                score >= 0.5 ? 1 : 0,
                score,
                modeUsesJev(mode) ? "jev" : "llm",
                "置信度落在阈值区间，按 0.5 兜底",
                modeUsesJev(mode) ? setting.jev_model : setting.llm_model,
            ));
        }
    }

    return Array.from(decided.values());
}

function buildJudge(
    target: JudgeTargetInfo,
    localizable: number,
    confidence: number | null,
    source: string,
    reason: string | null,
    model: string,
): TextJudgeInfo {
    return {
        origin_id: target.id,
        object_id: target.object_id,
        localizable,
        confidence,
        source,
        // 列保留在库里（兼容历史数据），当前判定路径不再产生"已复核"的条目
        checked_by_llm: 0,
        reason,
        model,
    };
}

function describeTarget(target: JudgeTargetInfo): string {
    const semantic = target.semantic || "未知字段";
    return `${target.object_name}（${target.object_type}）/${semantic}/${target.field_path}`;
}

function errorText(scene: string, e: unknown): string {
    return `${scene}：${e instanceof Error ? e.message : String(e)}`;
}

/// 粗略估算输入 token：按 4 字符 ≈ 1 token，另加固定的提示开销
function estimateTokens(items: { text: string, context: string }[]): number {
    let total = 0;
    for (const item of items) {
        total += Math.ceil((item.text.length + item.context.length + 80) / 4);
    }
    return total;
}

function chunk<T>(list: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let i = 0; i < list.length; i += size) {
        result.push(list.slice(i, i + size));
    }
    return result;
}

/// 简单并发池：最多 concurrency 个任务同时在跑
async function runPool<T>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<void>,
): Promise<void> {
    let next = 0;
    const size = Math.min(concurrency, items.length);
    const runners: Promise<void>[] = [];
    for (let i = 0; i < size; i++) {
        runners.push((async () => {
            while (true) {
                const index = next++;
                if (index >= items.length) return;
                if (cancelled) return;
                await worker(items[index]);
            }
        })());
    }
    await Promise.all(runners);
}