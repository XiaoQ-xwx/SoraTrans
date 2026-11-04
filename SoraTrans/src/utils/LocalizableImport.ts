import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { gm } from "./GameDbManager";
import { parseCsv, parseCsvKey, parseKvJson, rebuildLongText } from "./LocalizableFormat";
import { LONG_TEXT_THRESHOLD } from "./TextTemplate";
import type { TextOrigin } from "@/model/TextOrigin";

// 跨文件导入译文，支持一次选多个文件（配合"按对象拆分"的多文件导出）：
//   .json —— KV JSON（{"原文": "译文"}），由 LinguaGacha 等工具翻译后产出，
//            短文本按原文精确匹配回写；长文本按再提取模板把片段拼回整条
//   .csv  —— "Key,Value"，Key 为 {textId} / {objectId}:{textId}（长文本再带 :{占位符}），
//            直接按 id 精确回写
// 多个文件的条目先各自合并，再一次性写库，避免每个文件都跑一遍全量匹配。

export interface LocalizableImportResult {
    // 实际读取的文件数
    fileCount: number;
    // 解析出的有效条目数（各文件求和）
    pairCount: number;
    // 实际写入/覆盖的文本行数
    writtenCount: number;
    // 长文本重建成功条数
    rebuiltCount: number;
    // 缺译文的片段数：已按原文回填写库，游戏里这几处仍是原文
    filledCount: number;
    // CSV 长文本因缺片段而未重建的条数（KV JSON 走原文回填，不会产生）
    missingCount: number;
}

export async function importLocalizableTranslations(): Promise<LocalizableImportResult | null> {
    const picked = await open({
        multiple: true,
        directory: false,
        title: "选择译文文件（可多选，或框选一个目录里的 JSON/CSV）",
        filters: [{ name: "译文文件", extensions: ["json", "csv"] }],
    });
    if (!picked) return null;
    const paths = Array.isArray(picked) ? picked : [picked];
    if (paths.length === 0) return null;

    // 两类来源先各自合并
    const kvLookup = new Map<string, string>();
    const csvNormal = new Map<number, string>();
    const csvParts = new Map<number, Record<string, string>>();
    let pairCount = 0;
    let fileCount = 0;

    for (const path of paths) {
        const raw = await readTextFile(path);
        if (path.toLowerCase().endsWith(".csv")) {
            pairCount += collectCsv(raw, csvNormal, csvParts);
        } else {
            const lookup = parseKvJson(raw);
            for (const [src, dst] of lookup) kvLookup.set(src, dst);
            pairCount += lookup.size;
        }
        fileCount++;
    }

    let writtenCount = 0;
    let rebuiltCount = 0;
    let filledCount = 0;
    let missingCount = 0;
    const templates: { id: number, text_template: string }[] = [];

    // ---- KV JSON：短文本按原文匹配 + 长文本按模板重建 ----
    if (kvLookup.size > 0) {
        const pairs = Array.from(kvLookup, ([src, dst]) => ({ src, dst }));
        writtenCount += await gm.importTransByText(pairs);

        const longRows = await gm.selectLongTexts(LONG_TEXT_THRESHOLD);
        const updates: TextOrigin[] = [];
        for (const row of longRows) {
            const result = rebuildLongText(row.origin_text, row.text_template ?? null, kvLookup);
            if (result.status === "no_segments") continue;
            updates.push({ ...row, text_template: result.template, trans_text: result.translated });
            templates.push({ id: row.id, text_template: result.template });
            rebuiltCount++;
            filledCount += result.filled;
        }
        if (updates.length > 0) await gm.insertBatchTransSimple(updates);
        writtenCount += updates.length;
    }

    // ---- CSV：按 id 精确回写 + 长文本按模板重建 ----
    if (csvParts.size > 0) {
        const existing = await gm.selectTextTemplates([...csvParts.keys()]);
        for (const [textId, bucket] of csvParts) {
            const template = existing.get(textId);
            if (!template) {
                missingCount++;
                continue;
            }
            let complete = true;
            const translated = template.replace(/\{\d+\}/g, (token) => {
                const value = bucket[token];
                if (value === undefined) {
                    complete = false;
                    return token;
                }
                return value;
            });
            if (!complete) {
                missingCount++;
                continue;
            }
            csvNormal.set(textId, translated);
            rebuiltCount++;
        }
    }

    if (csvNormal.size > 0) {
        const updates: TextOrigin[] = Array.from(csvNormal, ([id, trans_text]) => ({
            id,
            origin_text: "",
            text_template: null,
            trans_text,
        }));
        await gm.insertBatchTransSimple(updates);
        writtenCount += updates.length;
    }

    if (templates.length > 0) await gm.updateTextTemplatesStrict(templates);

    return { fileCount, pairCount, writtenCount, rebuiltCount, filledCount, missingCount };
}

/// 把一份 CSV 的内容并入聚合表，返回该文件的有效行数
function collectCsv(
    raw: string,
    normal: Map<number, string>,
    parts: Map<number, Record<string, string>>,
): number {
    const rows = parseCsv(raw);
    if (rows.length > 0 && rows[0][0] === "Key" && rows[0][1] === "Value") {
        rows.shift();
    }
    let count = 0;
    for (const [key, value] of rows) {
        const parsed = parseCsvKey(key);
        if (!parsed) {
            throw new Error(`无法识别的键 "${key}"，应为 {id}、{objId}:{id} 或 {objId}:{id}:{占位符}`);
        }
        if (parsed.token) {
            const bucket = parts.get(parsed.textId) ?? {};
            bucket[parsed.token] = value;
            parts.set(parsed.textId, bucket);
        } else {
            normal.set(parsed.textId, value);
        }
        count++;
    }
    return count;
}
