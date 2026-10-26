use crate::pojo::ai_settings_info::AiSettingsInfo;
use crate::util::db_manager::DbManager;

/// 读取 AI 服务配置（未配置时返回 None）
pub async fn select_ai_settings(manager: &DbManager) -> Result<Option<AiSettingsInfo>, String> {
    let db = manager.sora_db().await?;
    let mut conn = db.acquire().await.map_err(|e| e.to_string())?;

    let result = sqlx::query_as::<_, AiSettingsInfo>(
        "SELECT base_url, api_key, model FROM ai_settings WHERE id = 1;",
    )
    .fetch_optional(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;

    Ok(result)
}

/// 保存 AI 服务配置：单行表 UPSERT 覆盖
pub async fn upsert_ai_settings(
    manager: &DbManager,
    base_url: String,
    api_key: String,
    model: String,
) -> Result<(), String> {
    let db = manager.sora_db().await?;
    let mut conn = db.acquire().await.map_err(|e| e.to_string())?;

    sqlx::query(
        r#"
            INSERT INTO ai_settings (id, base_url, api_key, model)
            VALUES (1, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                base_url = excluded.base_url,
                api_key = excluded.api_key,
                model = excluded.model,
                update_time = DATETIME('now', 'localtime');
        "#,
    )
    .bind(base_url)
    .bind(api_key)
    .bind(model)
    .execute(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;

    Ok(())
}
