-- AI 可本地化判定结果（文本条目级）
-- 判定主体是 text_origin 的一条文本。object_id 冗余存一份只为快速聚合，
-- 统计时仍以 text_origin.object_id 为准（assets_object 被重建表后冗余列会过期）。
-- 刻意不加外键：game_migrations/003_font_and_object_constraints.sql 用
-- "DELETE + 按原 id 写回" 的方式重建 text_origin，带外键（哪怕 CASCADE）
-- 会让那次迁移把判定数据一起毁掉；孤儿行靠 JOIN 自然失效即可。
CREATE TABLE IF NOT EXISTS "text_judge" (
	"origin_id"	INTEGER NOT NULL PRIMARY KEY,
	"object_id"	INTEGER NOT NULL,
	"localizable"	INTEGER NOT NULL DEFAULT 0,
	"confidence"	REAL,
	"source"	TEXT NOT NULL DEFAULT 'jev',
	"checked_by_llm"	INTEGER NOT NULL DEFAULT 0,
	"reason"	TEXT,
	"model"	TEXT,
	"create_time"	TEXT NOT NULL DEFAULT (DATETIME('now', 'localtime')),
	"update_time"	TEXT NOT NULL DEFAULT (DATETIME('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS "idx_text_judge_object_id" ON "text_judge" ("object_id");
