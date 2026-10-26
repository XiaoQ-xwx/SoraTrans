-- AI 识别服务配置（OpenAI 兼容接口），单行表：id 固定为 1，UPSERT 覆盖更新。
-- api_key 仅保存在本机数据库，设置页有明文存储提示。
CREATE TABLE IF NOT EXISTS "ai_settings" (
	"id"	INTEGER NOT NULL,
	"base_url"	TEXT NOT NULL,
	"api_key"	TEXT NOT NULL DEFAULT '',
	"model"	TEXT NOT NULL,
	"update_time"	TEXT NOT NULL DEFAULT (DATETIME('now', 'localtime')),
	PRIMARY KEY("id"),
	CHECK ("id" = 1)
);
