import type { JudgeTargetInfo, TextJudgeInfo } from "@/model/JudgeInfo";
import { gm } from "./GameDbManager";
import { loadModelSetting, modeUsesJev, validateModelSetting } from "./AppSetting";
import type { JudgeMode, ModelSetting } from "./AppSetting";
import { judgeBatchByJev, JEV_MAX_QUESTIONS } from "./JevClient";
import type { JudgeQuestionItem } from "./JevClient";
import { judgeBatchByLlm, reviewBatchByLlm, LLM_BATCH_SIZE } from "./LlmClient";
import type { LlmReviewItem } from "./LlmClient";
import { useJudgeProgress } from "./useJudgeProgress";

// 判定流水线：Jev 决策模型粗筛 -> 低置信度条目交 LLM 复核 -> 结果入库
// 只配 Jev 时走阈值直出；只配 LLM 时全量交 LLM。
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
/// reset  = true 时先清空历史结果重新判定
/// review = 本次是否启用 LLM 复审（不传则用配置里的默认值）
/// mode   = 本次判定模式（不传则用配置里的默认值）
export async function runJudge(options: { reset?: boolean; review?: boolean; mode?: JudgeMode } = {}): Promise<void> {
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
            llm_review: options.review ?? loaded.llm_review,
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

/// 单独跑一次 LLM 复审。scopeAll = false 只处理"判不准"（置信度落在阈值区间）的条目，
/// true 则把全部已判定、还没复核过的条目都交给 LLM 过一遍。
export async function runReviewOnly(scopeAll: boolean): Promise<void> {
    if (running) return;
    running = true;
    cancelled = false;

    useJudgeProgress.getState().start();

    try {
        const setting = await loadModelSetting();
        if (!setting.llm_base_url.trim() || !setting.llm_api_key.trim()) {
            useJudgeProgress.getState().finish("请先在设置页填写 LLM 接口地址与 API Key");
            return;
        }

        const errors: string[] = [];
        let reviewed = 0;

        // 候选总数用于进度显示（复用判定弹窗的进度条与计数）
        const reviewTotal = await gm.countReviewTargets(setting.threshold_low, setting.threshold_high, scopeAll);
        useJudgeProgress.getState().setCounts({ total: reviewTotal, judged: 0, localizable: 0 });
        if (reviewTotal === 0) {
            useJudgeProgress.getState().finish(
                scopeAll ? "没有需要复审的条目（已判定的都已复核过）" : "没有需要复审的条目（低可信度的都已复核过）"
            );
            return;
        }

        // 最多跑两轮：失败的批次不会写库（checked_by_llm 仍为 0），
        // 第二轮会自动把它们重新捞回来；整轮一条都没写就提前结束
        for (let pass = 0; pass < MAX_PASSES && !cancelled; pass++) {
            let cursor = 0;
            let writtenInPass = 0;

            while (!cancelled) {
                const targets = await gm.selectReviewTargets(
                    cursor,
                    setting.threshold_low,
                    setting.threshold_high,
                    scopeAll,
                    FETCH_BATCH,
                );
                if (targets.length === 0) break;
                cursor = targets[targets.length - 1].id;

                const groups = chunk(targets, LLM_BATCH_SIZE);
                await runPool(groups, Math.max(1, setting.concurrency), async (group) => {
                    const items: LlmReviewItem[] = group.map((target) => ({
                        key: String(target.id),
                        text: target.text,
                        context: describeTarget(target),
                    }));
                    useJudgeProgress.getState().addRequest(1);
                    try {
                        const reviewedMap = await reviewBatchByLlm(items, setting);
                        useJudgeProgress.getState().addTokens(estimateTokens(items));
                        const results: TextJudgeInfo[] = [];
                        for (const target of group) {
                            const result = reviewedMap.get(String(target.id));
                            if (!result) continue;
                            results.push(buildJudge(
                                target,
                                result.localizable,
                                target.confidence,
                                "llm",
                                1,
                                result.reason,
                                setting.llm_model,
                            ));
                        }
                        if (results.length > 0) {
                            await gm.insertJudgeResults(results);
                            reviewed += results.length;
                            writtenInPass += results.length;
                        }
                        useJudgeProgress.getState().setCounts({ judged: reviewed });
                        useJudgeProgress.getState().setMessage(`复审中…已复审 ${reviewed} 条`);
                    } catch (e) {
                        // 失败批次不写库，checked_by_llm 保持 0，下一轮或下次点击会重来
                        errors.push(errorText("LLM 复审", e));
                    }
                });
            }

            if (writtenInPass === 0) break;
        }

        useJudgeProgress.getState().bumpVersion();
        // 复审会改标签与可本地化数，结束后用库里的真实值刷新弹窗计数
        // （否则进度数字停在"已复审 N/N、可本地化 0"）
        const finalProgress = await gm.selectJudgeProgress();
        useJudgeProgress.getState().setCounts({
            total: finalProgress.total,
            judged: finalProgress.judged,
            localizable: finalProgress.localizable,
        });

        const errorHint = errors.length > 0 ? `；最后错误：${errors[errors.length - 1]}` : "";
        useJudgeProgress.getState().finish(
            reviewed === 0
                ? `没有需要复审的条目${errorHint}`
                : `复审完成：共复核 ${reviewed} 条（已判定 ${finalProgress.judged}/${finalProgress.total}，可本地化 ${finalProgress.localizable}）${errorHint}`
        );
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        useJudgeProgress.getState().finish(`复审中断：${message}`);
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
    // 决策阶段的"可本地化可能性"，用于复审失败时按 0.5 兜底
    const scores = new Map<number, number>();
    const needReview: JudgeTargetInfo[] = [];

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
                        needReview.push(target);
                        continue;
                    }
                    scores.set(target.id, probability);
                    if (probability >= setting.threshold_high) {
                        decided.set(target.id, buildJudge(target, 1, probability, "jev", 0, null, setting.jev_model));
                    } else if (probability <= setting.threshold_low) {
                        decided.set(target.id, buildJudge(target, 0, probability, "jev", 0, null, setting.jev_model));
                    } else {
                        needReview.push(target);
                    }
                }
            } catch (e) {
                errors.push(errorText("Jev", e));
                for (const target of group) needReview.push(target);
            }
        });
    } else {
        // ---- 决策引擎：LLM（每请求 10 条）----
        const groups = chunk(targets, LLM_BATCH_SIZE);
        await runPool(groups, Math.max(1, setting.concurrency), async (group) => {
            const items: LlmReviewItem[] = group.map((target) => ({
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
                        needReview.push(target);
                        continue;
                    }
                    scores.set(target.id, result.score);
                    // 注意：这是「决策」不是「复审」，checked_by_llm 必须保持 0，
                    // 否则 LLM 决策模式下事后点「LLM 复审」会一条都捞不到
                    if (result.score >= setting.threshold_high) {
                        decided.set(target.id, buildJudge(target, 1, result.score, "llm", 0, result.reason, setting.llm_model));
                    } else if (result.score <= setting.threshold_low) {
                        decided.set(target.id, buildJudge(target, 0, result.score, "llm", 0, result.reason, setting.llm_model));
                    } else {
                        needReview.push(target);
                    }
                }
            } catch (e) {
                errors.push(errorText("LLM", e));
                for (const target of group) needReview.push(target);
            }
        });
    }

    // ---- 复审环节（jev_llm / llm_llm 才有）----
    if (setting.llm_review && needReview.length > 0) {
        const groups = chunk(needReview, LLM_BATCH_SIZE);
        await runPool(groups, Math.max(1, setting.concurrency), async (group) => {
            const items: LlmReviewItem[] = group.map((target) => ({
                key: String(target.id),
                text: target.text,
                context: describeTarget(target),
            }));
            store.addRequest(1);
            try {
                const reviewed = await reviewBatchByLlm(items, setting);
                store.addTokens(estimateTokens(items));
                const missing = group.filter((target) => !reviewed.has(String(target.id)));
                if (missing.length > 0) errors.push(`LLM 复审漏答 ${missing.length} 条文本`);
                for (const target of group) {
                    const result = reviewed.get(String(target.id));
                    if (!result) continue;
                    decided.set(target.id, buildJudge(
                        target,
                        result.localizable,
                        scores.get(target.id) ?? null,
                        "llm",
                        1,
                        result.reason,
                        setting.llm_model,
                    ));
                }
            } catch (e) {
                errors.push(errorText("LLM 复审", e));
            }
        });
    }

    for (const target of targets) {
        if (decided.has(target.id)) continue;
        const score = scores.get(target.id);
        if (score !== undefined) {
            // 没有复审（或复审失败）时的兜底：0.5 折中阈值，仍保留原始分数作为置信度
            decided.set(target.id, buildJudge(
                target,
                score >= 0.5 ? 1 : 0,
                score,
                modeUsesJev(mode) ? "jev" : "llm",
                0,
                "未复核，按 0.5 阈值兜底",
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
    checkedByLlm: number,
    reason: string | null,
    model: string,
): TextJudgeInfo {
    return {
        origin_id: target.id,
        object_id: target.object_id,
        localizable,
        confidence,
        source,
        checked_by_llm: checkedByLlm,
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