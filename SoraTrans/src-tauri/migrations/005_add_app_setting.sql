-- 应用级键值设置（模型 API 配置等），全局唯一，不属于单个游戏
CREATE TABLE IF NOT EXISTS "app_setting" (
	"key"	TEXT NOT NULL PRIMARY KEY,
	"value"	TEXT NOT NULL,
	"update_time"	TEXT NOT NULL DEFAULT (DATETIME('now', 'localtime'))
);
