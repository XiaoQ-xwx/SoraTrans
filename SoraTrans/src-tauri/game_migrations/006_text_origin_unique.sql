-- 006: 给 text_origin 补业务唯一键
-- 重新扫描/重新提取依赖 "INSERT OR IGNORE INTO text_origin" 的幂等性，
-- 但 001 建表时 text_origin 只有自增主键，没有业务唯一键 —— IGNORE 实际等价于纯 INSERT，
-- 所以同一个项目重跑一次提取就会把全部文本行再插一遍（文本翻倍、译文错位）。
-- 这里补 (object_id, field_path) 唯一索引：一个对象的同一个字段路径只保留一行文本。
-- 老库若已有重复行，先收敛到 id 最小的那行（其译文行同步保留）。
DELETE FROM "text_translate"
WHERE "origin_id" NOT IN (
    SELECT MIN("id") FROM "text_origin" GROUP BY "object_id", "field_path"
);
DELETE FROM "text_origin"
WHERE "id" NOT IN (
    SELECT MIN("id") FROM "text_origin" GROUP BY "object_id", "field_path"
);
CREATE UNIQUE INDEX IF NOT EXISTS "ux_text_origin_object_field"
    ON "text_origin" ("object_id", "field_path");
