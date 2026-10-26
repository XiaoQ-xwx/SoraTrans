use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::ai::client::{self, AiConfig, AiPatternInput};
use crate::pojo::ai_result_info::AiResultInfo;
use crate::util::{
    db_manager::DbManager,
    repo::{ai_settings, app_settings, text_origin},
};

/// 识别取消标志：run_recognition 开始时复位，cancel_ai_recognition 命令置位
static AI_CANCELLED: AtomicBool = AtomicBool::new(false);

/// 是否已有识别任务在跑：防止两个任务并存时交错写库、并互相清除取消信号
static AI_RUNNING: AtomicBool = AtomicBool::new(false);

/// 单批送审的 pattern 数（推理型模型 token 消耗大，20 组一批更稳）
const BATCH_SIZE: usize = 20;
/// 单条样本送审时的截断长度
const SAMPLE_TRUNCATE: usize = 200;
/// 等待响应时轮询取消标志的间隔，即"取消"的响应延迟上限
const CANCEL_POLL_MS: u64 = 200;

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRunSummary {
    pub total_patterns: usize,
    pub updated: usize,
    pub failed_batches: usize,
    pub cancelled: bool,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiProgressPayload {
    pub done: usize,
    pub total: usize,
    pub failed_batches: usize,
    pub finished: bool,
    pub error: Option<String>,
}

pub fn cancel() {
    AI_CANCELLED.store(true, Ordering::SeqCst);
}

/// 运行守卫：无论正常结束还是 return Err，都会复位 AI_RUNNING
struct RunGuard;

impl Drop for RunGuard {
    fn drop(&mut self) {
        AI_RUNNING.store(false, Ordering::SeqCst);
    }
}

/// 对指定对象（None=当前游戏全库）的 pattern 分组执行 AI 语义识别，
/// 结果写回 text_pattern.ai_label / localizable。
///
/// 注意：标注按 pattern（结构签名）保存，因此同一 pattern 被多个对象共享时
/// 标注在各对象间通用——"按对象识别"只是限定本次送审的范围。
///
/// 单批失败重试一次后跳过并累计，不中断整体；识别只写 text_pattern 两列。
pub async fn run_recognition(
    manager: &DbManager,
    app: &AppHandle,
    object_id: Option<i64>,
) -> Result<AiRunSummary, String> {
    // 并发守卫：同一时刻只允许一个识别任务
    if AI_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("已有识别任务正在进行，请等待其结束".to_string());
    }
    let _guard = RunGuard;

    // 复位取消标志必须早于任何 await：否则用户在取数期间点"取消"会被随后复位吞掉
    AI_CANCELLED.store(false, Ordering::SeqCst);

    let settings = ai_settings::select_ai_settings(manager)
        .await?
        .ok_or_else(|| "尚未配置 AI 服务，请先在设置页完成配置".to_string())?;
    // 识别方式：llm（OpenAI 兼容 chat/completions，默认）/ jev（TypeSafe System One 决策模型）
    let provider = app_settings::get_setting(manager, "ai_provider".to_string())
        .await?
        .unwrap_or_else(|| "llm".to_string());

    let config = AiConfig {
        base_url: settings.base_url,
        api_key: settings.api_key,
        model: settings.model,
        provider,
    };

    // 整个任务复用同一个 HTTP 客户端，避免逐批重建连接池
    let client = client::new_client()?;

    let groups = text_origin::select_patterns_with_samples(manager, object_id).await?;
    let total = groups.len();

    let mut summary = AiRunSummary {
        total_patterns: total,
        ..Default::default()
    };

    if total == 0 {
        emit_progress(app, 0, 0, 0, true, None);
        return Ok(summary);
    }

    emit_progress(app, 0, total, 0, false, None);

    // done 表示已处理的 pattern 数（含失败批），与"已回写条数"updated 区分开，
    // 否则失败批会让进度看起来卡住
    let mut processed = 0usize;

    for batch in groups.chunks(BATCH_SIZE) {
        if AI_CANCELLED.load(Ordering::SeqCst) {
            summary.cancelled = true;
            break;
        }

        let inputs: Vec<AiPatternInput> = batch
            .iter()
            .map(|g| AiPatternInput {
                id: g.id,
                semantic: g.semantic.clone(),
                total: g.total,
                jp_count: g.jp_count,
                samples: g
                    .samples
                    .iter()
                    .take(text_origin::AI_SAMPLE_LIMIT)
                    .map(|s| truncate_chars(s, SAMPLE_TRUNCATE))
                    .collect(),
            })
            .collect();

        let batch_result = await_batch_cancellable(&client, &config, &inputs).await;

        // 取消发生在在途批次：丢弃该批结果，立即收尾
        if AI_CANCELLED.load(Ordering::SeqCst) {
            summary.cancelled = true;
            break;
        }

        match batch_result {
            // 只接受本批次送审过的 id：模型偶发返回越界 id 时，
            // 若直接回写会污染其它 pattern 的标注
            Ok(results) => {
                let accepted: Vec<AiResultInfo> = results
                    .into_iter()
                    .filter(|r| batch.iter().any(|g| g.id == r.id))
                    .collect();

                match text_origin::update_pattern_ai(manager, &accepted).await {
                    Ok(()) => summary.updated += accepted.len(),
                    Err(e) => {
                        // 数据库回写失败：已完成批次保持已提交，终止任务并上报
                        let msg = format!("{e}（已标注 {}/{} 组）", summary.updated, total);
                        summary.last_error = Some(msg.clone());
                        emit_progress(
                            app,
                            processed,
                            total,
                            summary.failed_batches,
                            true,
                            Some(msg.clone()),
                        );
                        return Err(msg);
                    }
                }
            }
            Err(e) => {
                summary.failed_batches += 1;
                summary.last_error = Some(e);
            }
        }

        processed += batch.len();
        emit_progress(app, processed, total, summary.failed_batches, false, None);
    }

    emit_progress(
        app,
        processed,
        total,
        summary.failed_batches,
        true,
        summary.last_error.clone(),
    );
    Ok(summary)
}

/// 等待单批结果，同时轮询取消标志。
/// 仅靠批次边界检查取消是无效的——已发出的请求可能阻塞到超时（最长 120s），
/// 这里在等待期间轮询，取消时丢弃在途请求，响应延迟上限为 CANCEL_POLL_MS。
async fn await_batch_cancellable(
    client: &tauri_plugin_http::reqwest::Client,
    config: &AiConfig,
    inputs: &[AiPatternInput],
) -> Result<Vec<AiResultInfo>, String> {
    let fut = attempt_batch(client, config, inputs);
    tokio::pin!(fut);

    loop {
        tokio::select! {
            r = &mut fut => return r,
            _ = tokio::time::sleep(Duration::from_millis(CANCEL_POLL_MS)) => {
                if AI_CANCELLED.load(Ordering::SeqCst) {
                    return Err("已取消".to_string());
                }
            }
        }
    }
}

/// 单批识别。普通失败重试一次；429 限流或 5xx 网关错误则退避重试，最多 4 次。
/// 实测该网关连续批量请求时既会返回 429，也会在短时间内连续 503
/// （Service Unavailable），两种都必须退避重试，否则整批无谓失败。
async fn attempt_batch(
    client: &tauri_plugin_http::reqwest::Client,
    config: &AiConfig,
    inputs: &[AiPatternInput],
) -> Result<Vec<AiResultInfo>, String> {
    let mut last_err = String::new();

    for attempt in 0..4 {
        match call_model(client, config, inputs).await {
            Ok(r) => return Ok(r),
            Err(e) => {
                if AI_CANCELLED.load(Ordering::SeqCst) {
                    return Err(format!("已取消（第 {} 次尝试失败: {e}）", attempt + 1));
                }
                let retryable = ["429", "500", "502", "503", "504"]
                    .iter()
                    .any(|code| e.contains(code));
                last_err = e;
                // 可恢复错误：最长退避 10s / 25s / 45s；普通错误：只重试一次
                let can_retry = if retryable { attempt < 3 } else { attempt == 0 };
                if can_retry {
                    let wait = if retryable {
                        [10u64, 25, 45][attempt.min(2)]
                    } else {
                        1
                    };
                    tokio::time::sleep(Duration::from_secs(wait)).await;
                    continue;
                }
                break;
            }
        }
    }

    Err(format!("识别失败（已重试）: {last_err}"))
}

/// 按 provider 选择请求形态：JEV 走 /systemone 决策接口，其余走 OpenAI 兼容 chat/completions
async fn call_model(
    client: &tauri_plugin_http::reqwest::Client,
    config: &AiConfig,
    inputs: &[AiPatternInput],
) -> Result<Vec<AiResultInfo>, String> {
    if config.is_jev() {
        client::recognize_batch_jev(client, config, inputs).await
    } else {
        client::recognize_batch(client, config, inputs).await
    }
}

fn emit_progress(
    app: &AppHandle,
    done: usize,
    total: usize,
    failed_batches: usize,
    finished: bool,
    error: Option<String>,
) {
    let _ = app.emit(
        "ai-recognition-progress",
        AiProgressPayload {
            done,
            total,
            failed_batches,
            finished,
            error,
        },
    );
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let head: String = s.chars().take(max).collect();
        format!("{head}...")
    }
}
