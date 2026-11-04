use crate::{pojo::app_setting_info::AppSettingInfo, util::db_manager::DbManager};

/// 读取全部应用级设置
pub async fn select_app_settings(manager: &DbManager) -> Result<Vec<AppSettingInfo>, String> {
    let db = manager.sora_db().await?;
    let mut conn = db.acquire().await.map_err(|e| e.to_string())?;

    let result = sqlx::query_as::<_, AppSettingInfo>("SELECT key, value FROM app_setting;")
        .fetch_all(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;

    Ok(result)
}

/// 批量写入应用级设置（key 冲突时覆盖）
pub async fn save_app_settings(
    manager: &DbManager,
    list: Vec<AppSettingInfo>,
) -> Result<(), String> {
    if list.is_empty() {
        return Ok(());
    }

    let db = manager.sora_db().await?;
    let mut tx = db.begin().await.map_err(|e| e.to_string())?;

    for item in list {
        sqlx::query(
            r#"
                INSERT INTO app_setting (key, value)
                VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    update_time = DATETIME('now', 'localtime');
            "#,
        )
        .bind(&item.key)
        .bind(&item.value)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(())
}
