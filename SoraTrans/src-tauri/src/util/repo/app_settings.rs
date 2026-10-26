use crate::util::db_manager::DbManager;

/// 读取通用设置项（不存在返回 None）
pub async fn get_setting(manager: &DbManager, key: String) -> Result<Option<String>, String> {
    let db = manager.sora_db().await?;
    let mut conn = db.acquire().await.map_err(|e| e.to_string())?;

    let row: Option<(String,)> =
        sqlx::query_as("SELECT value FROM app_settings WHERE key = ?;")
            .bind(key)
            .fetch_optional(&mut *conn)
            .await
            .map_err(|e| e.to_string())?;

    Ok(row.map(|r| r.0))
}

/// 写入通用设置项（UPSERT）
pub async fn set_setting(manager: &DbManager, key: String, value: String) -> Result<(), String> {
    let db = manager.sora_db().await?;
    let mut conn = db.acquire().await.map_err(|e| e.to_string())?;

    sqlx::query(
        r#"
            INSERT INTO app_settings (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                update_time = DATETIME('now', 'localtime');
        "#,
    )
    .bind(key)
    .bind(value)
    .execute(&mut *conn)
    .await
    .map_err(|e| e.to_string())?;

    Ok(())
}
