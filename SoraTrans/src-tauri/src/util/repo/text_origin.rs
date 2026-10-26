use std::collections::HashMap;

/// 每个 pattern 送去 AI 识别的样本条数上限。
/// service 层构造请求时同样引用本常量，避免两处魔法数漂移。
pub const AI_SAMPLE_LIMIT: usize = 10;

use crate::{
    pojo::{
        ai_result_info::AiResultInfo,
        export_text_info::{ExportTextInfo, IdPairInfo, TextPairInfo},
        pattern_samples_info::PatternSamplesInfo,
        pattern_tree_info::PatternTreeInfo,
        text_origin_info::TextOriginInfo,
        text_template_info::TextTemplateInfo,
    },
    util::db_manager::DbManager,
};

pub async fn select_pattern_tree(
    manager: &DbManager,
    id: i64,
) -> Result<Vec<PatternTreeInfo>, String> {
    let db = manager.game_db().await?;
    let mut conn = db.acquire().await.map_err(|e| e.to_string())?;

    let result = sqlx::query_as::<_, PatternTreeInfo>(
        r#"
            SELECT
                text_pattern.id,
                text_pattern.semantic,
                text_pattern.ai_label AS ai_label,
                text_pattern.localizable AS localizable,
                COUNT(text_origin.id) AS count
            FROM text_pattern
            INNER JOIN text_origin
                ON text_origin.pattern_id = text_pattern.id
            WHERE text_origin.object_id = ?
            GROUP BY
                text_pattern.id,
                text_pattern.semantic;
        "#,
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;

    Ok(result)
}

pub async fn select_text_all(
    manager: &DbManager,
    id: i64,
    sort: Option<String>,
) -> Result<Vec<TextOriginInfo>, String> {
    let db = manager.game_db().await?;
    let mut conn = db.acquire().await.map_err(|e| e.to_string())?;

    let sql = format!(
        r#"
            SELECT tor.id,tor.text as origin_text,tor.text_template,tt.text as trans_text FROM text_origin as tor
            LEFT JOIN text_translate as tt
            ON tt.origin_id = tor.id
            WHERE tor.object_id = ?
            {}
        "#,
        sort.unwrap_or_default()
    );

    let result = sqlx::query_as::<_, TextOriginInfo>(&sql)
        .bind(id)
        .fetch_all(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;

    Ok(result)
}

pub async fn select_text_by_pattern_id(
    manager: &DbManager,
    pattern_id: i64,
    obj_id: i64,
    sort: Option<String>,
) -> Result<Vec<TextOriginInfo>, String> {
    let db = manager.game_db().await?;
    let mut conn = db.acquire().await.map_err(|e| e.to_string())?;

    let sql = format!(
        r#"
            SELECT tor.id,tor.text as origin_text,tor.text_template,tt.text as trans_text FROM text_origin as tor
            LEFT JOIN text_translate as tt
            ON tt.origin_id = tor.id
            WHERE tor.object_id = ?
            AND tor.pattern_id = ?
            {}
        "#,
        sort.unwrap_or_default()
    );

    let result = sqlx::query_as::<_, TextOriginInfo>(&sql)
        .bind(obj_id)
        .bind(pattern_id)
        .fetch_all(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;

    Ok(result)
}

pub async fn search_text(
    manager: &DbManager,
    id: i64,
    val: String,
    sort: Option<String>,
) -> Result<Vec<TextOriginInfo>, String> {
    let db = manager.game_db().await?;
    let mut conn = db.acquire().await.map_err(|e| e.to_string())?;

    let sql = format!(
        r#"
            SELECT tor.id,tor.text as origin_text,tor.text_template,tt.text as trans_text FROM text_origin as tor
            LEFT JOIN text_translate as tt
            ON tt.origin_id = tor.id
            WHERE object_id = ?
            AND tor.text LIKE '%{}%'
            OR tt.text LIKE '%{}%'
            {}    
        "#,
        val,
        val,
        sort.unwrap_or_default()
    );

    let result = sqlx::query_as::<_, TextOriginInfo>(&sql)
        .bind(id)
        .fetch_all(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;

    Ok(result)
}

pub async fn search_text_with_pattern_id(
    manager: &DbManager,
    pattern_id: i64,
    obj_id: i64,
    val: String,
    sort: Option<String>,
) -> Result<Vec<TextOriginInfo>, String> {
    let db = manager.game_db().await?;
    let mut conn = db.acquire().await.map_err(|e| e.to_string())?;

    let sql = format!(
        r#"
            SELECT tor.id,tor.text as origin_text,tor.text_template,tt.text as trans_text FROM text_origin as tor
            LEFT JOIN text_translate as tt
            ON tt.origin_id = tor.id
            WHERE tor.object_id = ?
            AND tor.pattern_id = ?
            AND tor.text LIKE '%{}%'
            OR tt.text LIKE '%{}%'
            {}
        "#,
        val,
        val,
        sort.unwrap_or_default()
    );

    let result = sqlx::query_as::<_, TextOriginInfo>(&sql)
        .bind(obj_id)
        .bind(pattern_id)
        .fetch_all(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;

    Ok(result)
}

/// 按 id 批量查询再提取模板，供导入长文本译文时回填占位符
pub async fn select_text_templates(
    manager: &DbManager,
    ids: Vec<i64>,
) -> Result<Vec<TextTemplateInfo>, String> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }

    let db = manager.game_db().await?;
    let mut conn = db.acquire().await.map_err(|e| e.to_string())?;

    let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        r#"
            SELECT id, text_template
            FROM text_origin
            WHERE id IN ({})
            AND text_template IS NOT NULL;
        "#,
        placeholders
    );

    let mut query = sqlx::query_as::<_, TextTemplateInfo>(&sql);
    for id in &ids {
        query = query.bind(id);
    }

    let result = query
        .fetch_all(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;

    Ok(result)
}

/// 批量回写再提取生成的占位符模板到 text_origin.text_template
pub async fn update_text_templates(
    manager: &DbManager,
    list: Vec<TextTemplateInfo>,
) -> Result<(), String> {
    let db = manager.game_db().await?;
    let mut tx = db.begin().await.map_err(|e| e.to_string())?;

    for item in list {
        sqlx::query(
            r#"
                UPDATE text_origin
                SET text_template = ?
                WHERE id = ?;
            "#,
        )
        .bind(&item.text_template)
        .bind(item.id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(())
}

/// 供 AI 识别取数：按 pattern 分组返回结构路径与样本（去重、每组最多 10 条）。
/// object_id 传 Some 时仅统计该对象的 pattern（查看文本页按对象识别），None 为全库。
pub async fn select_patterns_with_samples(
    manager: &DbManager,
    object_id: Option<i64>,
) -> Result<Vec<PatternSamplesInfo>, String> {
    let db = manager.game_db().await?;
    let mut conn = db.acquire().await.map_err(|e| e.to_string())?;

    // 只取每个 pattern 的前 AI_SAMPLE_LIMIT 条去重样本：
    // 大游戏全库可能有几十万行，全量读进内存既慢又占内存（取消响应也会被拖长），
    // 这里用窗口函数在 SQL 层截断；同时又避免了每个 pattern 单独查询的 N 次往返
    // 样本排序决定判定质量，曾经按 text 字典序取前 10 条 ——
    // 大分组的字典序前几条几乎全是 "0"/"1"/"_Color" 这类标识符，
    // 于是整组（哪怕含上千行日文）被判成"数字·占位符"。
    // 现在的排序：含非 ASCII（日文/汉字）的优先 → 长文本优先 → 字典序兜底；
    // 同时用窗口函数带上该组的总行数与含日文行数，供模型判断是否为混合分组。
    let sql = match object_id {
        Some(_) => {
            r#"
                SELECT id, semantic, text, total, jp_count FROM (
                    SELECT d.id, d.semantic, d.text,
                           COUNT(*) OVER (PARTITION BY d.id) AS total,
                           SUM(CASE WHEN d.text GLOB '*[^ -~]*' THEN 1 ELSE 0 END)
                               OVER (PARTITION BY d.id) AS jp_count,
                           ROW_NUMBER() OVER (
                               PARTITION BY d.id
                               ORDER BY (d.text GLOB '*[^ -~]*') DESC, LENGTH(d.text) DESC, d.text
                           ) AS rn
                    FROM (
                        SELECT DISTINCT p.id AS id, p.semantic AS semantic, t.text AS text
                        FROM text_pattern AS p
                        JOIN text_origin AS t ON t.pattern_id = p.id
                        WHERE t.object_id = ?
                    ) AS d
                ) WHERE rn <= ?
                ORDER BY id;
            "#
        }
        None => {
            r#"
                SELECT id, semantic, text, total, jp_count FROM (
                    SELECT d.id, d.semantic, d.text,
                           COUNT(*) OVER (PARTITION BY d.id) AS total,
                           SUM(CASE WHEN d.text GLOB '*[^ -~]*' THEN 1 ELSE 0 END)
                               OVER (PARTITION BY d.id) AS jp_count,
                           ROW_NUMBER() OVER (
                               PARTITION BY d.id
                               ORDER BY (d.text GLOB '*[^ -~]*') DESC, LENGTH(d.text) DESC, d.text
                           ) AS rn
                    FROM (
                        SELECT DISTINCT p.id AS id, p.semantic AS semantic, t.text AS text
                        FROM text_pattern AS p
                        JOIN text_origin AS t ON t.pattern_id = p.id
                    ) AS d
                ) WHERE rn <= ?
                ORDER BY id;
            "#
        }
    };

    let mut query = sqlx::query_as::<_, (i64, String, String, i64, i64)>(sql);
    if let Some(id) = object_id {
        query = query.bind(id);
    }
    let rows = query
        .bind(AI_SAMPLE_LIMIT as i64)
        .fetch_all(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;

    let mut groups: Vec<PatternSamplesInfo> = Vec::new();
    let mut index: HashMap<i64, usize> = HashMap::new();

    for (id, semantic, text, total, jp_count) in rows {
        let pos = match index.get(&id) {
            Some(&pos) => pos,
            None => {
                groups.push(PatternSamplesInfo {
                    id,
                    semantic,
                    total,
                    jp_count,
                    samples: Vec::new(),
                });
                index.insert(id, groups.len() - 1);
                groups.len() - 1
            }
        };
        let group = &mut groups[pos];
        // 同组样本去重：重复文本不增加判定信息，只增加请求体积
        if group.samples.contains(&text) {
            continue;
        }
        // 每组最多 AI_SAMPLE_LIMIT 条样本（SQL 已截断，这里是二重保险）
        if group.samples.len() >= AI_SAMPLE_LIMIT {
            continue;
        }
        group.samples.push(text);
    }

    Ok(groups)
}

/// 导出用：取全库文本行（id + 原文 + 已有译文）。
/// localizable_only=true 时只取 AI 判定可本地化的分组，用于把噪声挡在翻译流程之外。
pub async fn select_export_texts(
    manager: &DbManager,
    localizable_only: bool,
) -> Result<Vec<ExportTextInfo>, String> {
    let db = manager.game_db().await?;
    let mut conn = db.acquire().await.map_err(|e| e.to_string())?;

    let rows = sqlx::query_as::<_, ExportTextInfo>(
        r#"
            SELECT tor.id AS id, tor.text AS origin_text, tt.text AS trans_text,
                   tor.text_template AS text_template,
                   ao.name AS asset_name
            FROM text_origin AS tor
            JOIN text_pattern AS p ON p.id = tor.pattern_id
            JOIN assets_object AS ao ON ao.id = tor.object_id
            LEFT JOIN text_translate AS tt ON tt.origin_id = tor.id
            WHERE (? = 0 OR p.localizable = 1)
              AND tor.text <> ''
            ORDER BY tor.id;
        "#,
    )
    .bind(if localizable_only { 1 } else { 0 })
    .fetch_all(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows)
}

/// 以原文为键导入译文（LinguaGacha KV-JSON 回填）。
/// 同一原文命中所有对应行；AI 判定为噪声（localizable=0）的行一律跳过。
/// 返回实际写入的行数。
pub async fn import_trans_by_text(
    manager: &DbManager,
    list: &[TextPairInfo],
) -> Result<u64, String> {
    let db = manager.game_db().await?;
    let mut tx = db.begin().await.map_err(|e| e.to_string())?;
    let mut total: u64 = 0;

    for item in list {
        if item.trans_text.trim().is_empty() {
            continue;
        }
        let res = sqlx::query(
            r#"
                INSERT INTO text_translate (origin_id, text)
                SELECT tor.id, ? FROM text_origin AS tor
                JOIN text_pattern AS p ON p.id = tor.pattern_id
                WHERE tor.text = ? AND (p.localizable IS NULL OR p.localizable = 1)
                ON CONFLICT(origin_id) DO UPDATE SET text = excluded.text;
            "#,
        )
        .bind(&item.trans_text)
        .bind(&item.origin_text)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

        total += res.rows_affected();
    }

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(total)
}

/// 以 id 为键导入译文（SoraTrans 自有 CSV 回填），同样跳过 AI 判定的噪声行
pub async fn import_trans_by_id(manager: &DbManager, list: &[IdPairInfo]) -> Result<u64, String> {
    let db = manager.game_db().await?;
    let mut tx = db.begin().await.map_err(|e| e.to_string())?;
    let mut total: u64 = 0;

    for item in list {
        if item.trans_text.trim().is_empty() {
            continue;
        }
        let res = sqlx::query(
            r#"
                INSERT INTO text_translate (origin_id, text)
                SELECT tor.id, ? FROM text_origin AS tor
                JOIN text_pattern AS p ON p.id = tor.pattern_id
                WHERE tor.id = ? AND (p.localizable IS NULL OR p.localizable = 1)
                ON CONFLICT(origin_id) DO UPDATE SET text = excluded.text;
            "#,
        )
        .bind(&item.trans_text)
        .bind(item.id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

        total += res.rows_affected();
    }

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(total)
}

/// 批量回写 AI 识别结果到 text_pattern.ai_label / localizable（单事务）
pub async fn update_pattern_ai(
    manager: &DbManager,
    results: &[AiResultInfo],
) -> Result<(), String> {
    if results.is_empty() {
        return Ok(());
    }

    let db = manager.game_db().await?;
    let mut tx = db.begin().await.map_err(|e| e.to_string())?;

    for item in results {
        sqlx::query(
            r#"
                UPDATE text_pattern
                SET ai_label = ?, localizable = ?
                WHERE id = ?;
            "#,
        )
        .bind(&item.label)
        .bind(if item.localizable { 1 } else { 0 })
        .bind(item.id)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(())
}
