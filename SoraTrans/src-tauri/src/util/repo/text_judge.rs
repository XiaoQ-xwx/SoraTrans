use crate::{
    pojo::judge_info::{
        JudgeProgressInfo, JudgeTargetInfo, LocalizableTextInfo, ObjectJudgeStat, TextJudgeInfo,
    },
    util::db_manager::DbManager,
};

/// 分批拉取待判定的文本条目（按 id 游标翻页，避免一次性把整库文本读进内存）
/// only_unjudged = true 时只返回还没有判定结果的条目，便于中断后继续
pub async fn select_judge_targets(
    manager: &DbManager,
    after_id: i64,
    limit: i64,
    only_unjudged: bool,
) -> Result<Vec<JudgeTargetInfo>, String> {
    let db = manager.game_db().await?;
    let mut conn = db.acquire().await.map_err(|e| e.to_string())?;

    let result = sqlx::query_as::<_, JudgeTargetInfo>(
        r#"
            SELECT
                tor.id,
                tor.object_id,
                ao.name AS object_name,
                ao.type AS object_type,
                COALESCE(tp.semantic, '') AS semantic,
                tor.field_path,
                tor.text
            FROM text_origin AS tor
            INNER JOIN assets_object AS ao ON ao.id = tor.object_id
            LEFT JOIN text_pattern AS tp ON tp.id = tor.pattern_id
            LEFT JOIN text_judge AS tj ON tj.origin_id = tor.id
            WHERE tor.id > ?
              AND (? = 0 OR tj.origin_id IS NULL)
            ORDER BY tor.id
            LIMIT ?;
        "#,
    )
    .bind(after_id)
    .bind(if only_unjudged { 1 } else { 0 })
    .bind(limit)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;

    Ok(result)
}

/// 批量写入判定结果（origin_id 冲突时覆盖），一个事务提交
pub async fn insert_judge_results(
    manager: &DbManager,
    list: Vec<TextJudgeInfo>,
) -> Result<(), String> {
    if list.is_empty() {
        return Ok(());
    }

    let db = manager.game_db().await?;
    let mut tx = db.begin().await.map_err(|e| e.to_string())?;

    for item in list {
        sqlx::query(
            r#"
                INSERT INTO text_judge
                    (origin_id, object_id, localizable, confidence, source, checked_by_llm, reason, model)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(origin_id) DO UPDATE SET
                    object_id = excluded.object_id,
                    localizable = excluded.localizable,
                    confidence = excluded.confidence,
                    source = excluded.source,
                    checked_by_llm = excluded.checked_by_llm,
                    reason = excluded.reason,
                    model = excluded.model,
                    update_time = DATETIME('now', 'localtime');
            "#,
        )
        .bind(item.origin_id)
        .bind(item.object_id)
        .bind(item.localizable)
        .bind(item.confidence)
        .bind(&item.source)
        .bind(item.checked_by_llm)
        .bind(&item.reason)
        .bind(&item.model)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(())
}

/// 按文件聚合的可本地化统计，资源列表用来显示 "12/40"
pub async fn select_object_judge_stats(
    manager: &DbManager,
) -> Result<Vec<ObjectJudgeStat>, String> {
    let db = manager.game_db().await?;
    let mut conn = db.acquire().await.map_err(|e| e.to_string())?;

    // 以 text_origin 为主表：分母是文件真实文本条数，
    // JOIN 也顺带过滤掉重新提取后残留的孤儿判定行
    let result = sqlx::query_as::<_, ObjectJudgeStat>(
        r#"
            SELECT
                tor.object_id AS object_id,
                COUNT(*) AS total,
                COUNT(tj.origin_id) AS judged,
                SUM(CASE WHEN tj.localizable = 1 THEN 1 ELSE 0 END) AS localizable
            FROM text_origin AS tor
            LEFT JOIN text_judge AS tj ON tj.origin_id = tor.id
            GROUP BY tor.object_id;
        "#,
    )
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;

    Ok(result)
}

/// 判定进度：文本总数 / 已判定 / 其中可本地化
pub async fn select_judge_progress(manager: &DbManager) -> Result<JudgeProgressInfo, String> {
    let db = manager.game_db().await?;
    let mut conn = db.acquire().await.map_err(|e| e.to_string())?;

    // 计数都经过 text_origin JOIN，孤儿判定行不会让 judged 超过 total
    let result = sqlx::query_as::<_, JudgeProgressInfo>(
        r#"
            SELECT
                (SELECT COUNT(*) FROM text_origin) AS total,
                (SELECT COUNT(*) FROM text_judge AS tj
                    INNER JOIN text_origin AS tor ON tor.id = tj.origin_id) AS judged,
                (SELECT COUNT(*) FROM text_judge AS tj
                    INNER JOIN text_origin AS tor ON tor.id = tj.origin_id
                    WHERE tj.localizable = 1) AS localizable;
        "#,
    )
    .fetch_one(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;

    Ok(result)
}

/// 清空判定结果，供重新判定
pub async fn clear_judge_results(manager: &DbManager) -> Result<(), String> {
    let db = manager.game_db().await?;
    let mut conn = db.acquire().await.map_err(|e| e.to_string())?;

    sqlx::query("DELETE FROM text_judge;")
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// 拉取导出用文本：only_localizable = true 时只取判定为可本地化的，
/// false 时取全部已提取文本（判定没跑过也能直接导出）
pub async fn select_export_texts(
    manager: &DbManager,
    only_localizable: bool,
) -> Result<Vec<LocalizableTextInfo>, String> {
    let db = manager.game_db().await?;
    let mut conn = db.acquire().await.map_err(|e| e.to_string())?;

    let result = sqlx::query_as::<_, LocalizableTextInfo>(
        r#"
            SELECT
                tor.id,
                tor.object_id,
                ao.name AS object_name,
                COALESCE(tp.semantic, '') AS semantic,
                tor.text,
                tor.text_template,
                COALESCE(tt.text, '') AS trans_text
            FROM text_origin AS tor
            INNER JOIN assets_object AS ao ON ao.id = tor.object_id
            LEFT JOIN text_pattern AS tp ON tp.id = tor.pattern_id
            LEFT JOIN text_translate AS tt ON tt.origin_id = tor.id
            LEFT JOIN text_judge AS tj ON tj.origin_id = tor.id
            WHERE (? = 0 OR tj.localizable = 1)
            ORDER BY tor.object_id, tor.id;
        "#,
    )
    .bind(if only_localizable { 1 } else { 0 })
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;

    Ok(result)
}
