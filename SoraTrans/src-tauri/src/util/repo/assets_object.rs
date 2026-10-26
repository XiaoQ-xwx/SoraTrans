use crate::{pojo::asset_object_info::AssetObjectInfo, util::db_manager::DbManager};

pub async fn select_distinct_types(
    manager: &DbManager,
    id: i64,
) -> Result<Vec<String>, String> {
    let db = manager.game_db().await?;
    let mut conn = db.acquire().await.map_err(|e| e.to_string())?;

    // id = 0 时不按 asset_id 过滤（展示全部）
    let sql = if id == 0 {
        "SELECT DISTINCT type FROM assets_object ORDER BY type"
    } else {
        "SELECT DISTINCT type FROM assets_object WHERE asset_id = ? ORDER BY type"
    };

    let mut query = sqlx::query_scalar::<_, String>(sql);
    if id != 0 {
        query = query.bind(id);
    }
    let result = query
        .fetch_all(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;

    Ok(result)
}

/// 对象列表 + AI 可本地化行数。
/// 用一次聚合子查询 LEFT JOIN，避免对 13 万对象逐行做相关子查询。
const OBJECT_LIST_BASE: &str = r#"
    SELECT assets_object.id, assets_object.name, assets_object.type, assets_object.path_id,
           assets_object.size, assets_object.line_count,
           COALESCE(agg.cnt, 0) AS localizable_lines
    FROM assets_object
    LEFT JOIN (
        SELECT t.object_id AS oid, COUNT(*) AS cnt
        FROM text_origin AS t
        JOIN text_pattern AS p ON p.id = t.pattern_id
        WHERE p.localizable = 1
        GROUP BY t.object_id
    ) AS agg ON agg.oid = assets_object.id
"#;

pub async fn select_asset_object_list(
    manager: &DbManager,
    id: i64,
    sort: Option<String>,
    types: Option<Vec<String>>,
    localizable_only: Option<bool>,
) -> Result<Vec<AssetObjectInfo>, String> {
    let db = manager.game_db().await?;
    let mut conn = db.acquire().await.map_err(|e| e.to_string())?;

    // 类型过滤：None = 不过滤（展示全部）；Some(非空) = IN 过滤；Some(空) = 什么都不展示
    let type_clause = match &types {
        Some(ts) if !ts.is_empty() => {
            let placeholders: Vec<&str> = ts.iter().map(|_| "?").collect();
            format!("AND type IN ({})", placeholders.join(","))
        }
        Some(_) => "AND 1=0".to_string(),
        None => String::new(),
    };

    // id = 0 时不按 asset_id 过滤（展示全部）
    let asset_clause = if id == 0 {
        String::new()
    } else {
        "AND asset_id = ?".to_string()
    };

    // 只看"有可本地化文本"的对象（AI 识别后才有效；未识别时结果为空）
    let ai_clause = if localizable_only.unwrap_or(false) {
        "AND agg.cnt > 0"
    } else {
        ""
    };

    let sql = format!(
        r#"
            {}
            WHERE 1=1
            {}
            {}
            {}
            {}
        "#,
        OBJECT_LIST_BASE,
        asset_clause,
        type_clause,
        ai_clause,
        sort.unwrap_or_default()
    );

    let mut query = sqlx::query_as::<_, AssetObjectInfo>(&sql);
    if id != 0 {
        query = query.bind(id);
    }
    if let Some(ts) = &types {
        for t in ts {
            query = query.bind(t);
        }
    }
    let result = query
        .fetch_all(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;

    Ok(result)
}

pub async fn search_asset_obj_by_name(
    manager: &DbManager,
    id: i64,
    val: String,
    sort: Option<String>,
    types: Option<Vec<String>>,
    localizable_only: Option<bool>,
) -> Result<Vec<AssetObjectInfo>, String> {
    let db = manager.game_db().await?;
    let mut conn = db.acquire().await.map_err(|e| e.to_string())?;

    let type_clause = match &types {
        Some(ts) if !ts.is_empty() => {
            let placeholders: Vec<&str> = ts.iter().map(|_| "?").collect();
            format!("AND assets_object.type IN ({})", placeholders.join(","))
        }
        Some(_) => "AND 1=0".to_string(),
        None => String::new(),
    };

    // id = 0 时不按 asset_id 过滤（展示全部）
    let asset_clause = if id == 0 {
        String::new()
    } else {
        "AND assets_object.asset_id = ?".to_string()
    };

    let ai_clause = if localizable_only.unwrap_or(false) {
        "AND agg.cnt > 0"
    } else {
        ""
    };

    let sql = format!(
        r#"
            {}
            WHERE 1=1
            {}
            AND (
                assets_object.name LIKE '%{}%'
                OR EXISTS (
                    SELECT 1
                    FROM text_origin
                    WHERE text_origin.object_id = assets_object.id
                    AND text_origin.text LIKE '%{}%'
                )
            )
            {}
            {}
            {};  
        "#,
        OBJECT_LIST_BASE,
        asset_clause,
        val,
        val,
        type_clause,
        ai_clause,
        sort.unwrap_or_default()
    );

    let mut query = sqlx::query_as::<_, AssetObjectInfo>(&sql);
    if id != 0 {
        query = query.bind(id);
    }
    if let Some(ts) = &types {
        for t in ts {
            query = query.bind(t);
        }
    }
    let result = query
        .fetch_all(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;

    Ok(result)
}
