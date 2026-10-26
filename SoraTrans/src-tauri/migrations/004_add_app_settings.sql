-- 通用应用设置（键值表）：保存导出格式等偏好，避免散落在 localStorage
CREATE TABLE IF NOT EXISTS "app_settings" (
	"key"	TEXT NOT NULL,
	"value"	TEXT NOT NULL,
	"update_time"	TEXT NOT NULL DEFAULT (DATETIME('now', 'localtime')),
	PRIMARY KEY("key")
);
