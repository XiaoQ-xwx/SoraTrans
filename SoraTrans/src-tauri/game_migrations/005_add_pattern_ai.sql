-- AI 语义识别结果：ai_label 为分类名，localizable 标记该组文本是否可本地化。
-- NULL 表示尚未识别；重新识别直接覆盖。
-- 重新提取时 pattern 行通过 INSERT OR IGNORE 复用、不会重建，AI 标注得以保留。
ALTER TABLE "text_pattern" ADD COLUMN "ai_label" TEXT;
ALTER TABLE "text_pattern" ADD COLUMN "localizable" INTEGER;
