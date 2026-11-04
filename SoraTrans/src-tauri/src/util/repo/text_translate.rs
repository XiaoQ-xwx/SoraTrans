use crate::{
    pojo::{text_origin_info::TextOriginInfo, text_pair_info::TextPairInfo},
    util::db_manager::DbManager,
};

pub async fn insert_trans(manager: &DbManager, id: i64, val: String) -> Result<(), String> {
    let db = manager.game_db().await?;
    let mut conn = db.acquire().await.map_err(|e| e.to_string())?;

    let _result = sqlx::query(
        r#"
            INSERT INTO text_translate (origin_id,text)
            VALUES (?,?)
            ON CONFLICT(origin_id) DO UPDATE SET text = ?;
        "#
    )
        .bind(id)
        .bind(&val)
        .bind(&val)
        .fetch_all(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// 按"原文"批量回写译文（KV JSON 导入的主路径）
/// 用临时表 + INSERT...SELECT 在库内完成匹配：几十万行文本不必往返前端。
/// 返回真正写入（或被覆盖）的行数。
pub async fn insert_trans_by_text(
    manager: &DbManager,
    list: Vec<TextPairInfo>,
) -> Result<i64, String> {
    if list.is_empty() {
        return Ok(0);
    }

    let db = manager.game_db().await?;
    let mut tx = db.begin().await.map_err(|e| e.to_string())?;

    // 临时表按连接隔离，事务内创建/清空即可
    sqlx::query("CREATE TEMP TABLE IF NOT EXISTS import_trans (src TEXT PRIMARY KEY, dst TEXT NOT NULL);")
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    sqlx::query("DELETE FROM import_trans;")
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    for item in list {
        sqlx::query("INSERT OR REPLACE INTO import_trans (src, dst) VALUES (?, ?);")
            .bind(&item.src)
            .bind(&item.dst)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
    }

    // 同一条原文可能对应多条 text_origin（去重后命中多行），这里一次全写
    let result = sqlx::query(
        r#"
            INSERT INTO text_translate (origin_id, text)
            SELECT tor.id, t.dst
            FROM text_origin AS tor
            INNER JOIN import_trans AS t ON t.src = tor.text
            ON CONFLICT(origin_id) DO UPDATE SET text = excluded.text;
        "#,
    )
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;

    let affected = result.rows_affected() as i64;

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(affected)
}

pub async fn insert_batch_trans(manager: &DbManager,list: Vec<TextOriginInfo>) -> Result<(), String>{
    let db = manager.game_db().await?;
    let mut tx = db.begin().await.map_err(|e| e.to_string())?;

    for item in list {
        if item.trans_text == "" {
            continue;
        }
        let _result = sqlx::query(
            r#"
                INSERT INTO text_translate (origin_id,text)
                VALUES (?,?)
                ON CONFLICT(origin_id) DO UPDATE SET text = ?;
            "#
        ).bind(item.id)
        .bind(&item.trans_text)
        .bind(&item.trans_text)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
    }

    tx.commit().await.map_err(|e| e.to_string())?;

    Ok(())
}
