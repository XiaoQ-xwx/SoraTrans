import { extractTextTemplate, LONG_TEXT_THRESHOLD } from "./TextTemplate";

// 可本地化文本的"导出/导入"格式层：纯函数，不依赖 Tauri，
// 便于用真实游戏数据做完整性回归测试。
//
// 支持两种格式：
//   1) KV JSON —— LinguaGacha 的 KVJSONFormat 语义：{"原文": "译文"}，
//      key 是原文（或长文本切出的片段），value 是已有译文（无译文时为空串）。
//      LinguaGacha 会把 value 非空且不等于 key 的条目视为"已处理"。
//   2) CSV —— "Key,Value" 两列，Key 为 {objectId}:{textId}（长文本 {objectId}:{textId}:{0}）,
//      Value 为原文片段。适合需要稳定键的翻译工具。

export interface ExportableText {
    id: number;
    object_id: number;
    text: string;
    text_template: string | null;
    trans_text: string;
}

export interface TemplateUpdate {
    id: number;
    text_template: string;
}

export interface KvJsonBuildResult {
    data: Record<string, string>;
    templates: TemplateUpdate[];
    // 实际产出的条目数（长文本按片段计）
    entryCount: number;
    // 因超长且无可提取片段而整条输出的条目数
    fallbackCount: number;
}

export interface CsvBuildResult {
    lines: string[];
    templates: TemplateUpdate[];
    entryCount: number;
}

/// 把可本地化文本构建成 LinguaGacha 的 KV JSON：{原文: 已有译文}
export function buildKvJson(items: ExportableText[]): KvJsonBuildResult {
    const data: Record<string, string> = Object.create(null) as Record<string, string>;
    const templates: TemplateUpdate[] = [];
    let entryCount = 0;
    let fallbackCount = 0;

    // 同一原文可能出现在多个文件里：合并成一条，优先保留已有译文
    const put = (src: string, dst: string) => {
        if (src === "") return;
        const exists = Object.prototype.hasOwnProperty.call(data, src);
        if (!exists) {
            data[src] = dst;
            entryCount++;
            return;
        }
        if (data[src] === "" && dst !== "") data[src] = dst;
    };

    for (const item of items) {
        if (item.text.length > LONG_TEXT_THRESHOLD) {
            const { template, placeholders } = extractTextTemplate(item.text, "ja");
            const tokens = Object.keys(placeholders);
            if (tokens.length > 0) {
                for (const token of tokens) put(placeholders[token], "");
                templates.push({ id: item.id, text_template: template });
                continue;
            }
            // 长文本但挖不出片段（纯符号/纯 ASCII 等）：整条输出，避免丢文本
            fallbackCount++;
        }
        put(item.text, item.trans_text ?? "");
    }

    return { data, templates, entryCount, fallbackCount };
}

/// 把 KV JSON 反序列化成 原文 -> 译文 映射，过滤空值与"译文等于原文"的未处理项
export function parseKvJson(raw: string): Map<string, string> {
    const trimmed = raw.replace(/^\uFEFF/, "").trim();
    if (trimmed === "") throw new Error("JSON 文件是空的");
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch (e) {
        throw new Error(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("JSON 结构不对：顶层必须是 {原文: 译文} 对象");
    }

    const map = new Map<string, string>();
    for (const [src, dst] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof dst !== "string") continue;
        if (dst === "") continue;
        if (dst === src) continue;
        map.set(src, dst);
    }
    return map;
}

export type LongTextRebuild =
    // 重建成功；filled 为缺译文、已按原文回填的片段数
    | { status: "ok", template: string, translated: string, filled: number }
    // 该长文本挖不出片段（纯符号/纯 ASCII 等），导出时按整条原文发的，
    // 由"按原文精确匹配"那条路径负责回写，这里不算失败
    | { status: "no_segments" };

/// 用"再提取模板 + 片段译文"重建长文本完整译文
export function rebuildLongText(
    originText: string,
    storedTemplate: string | null,
    lookup: Map<string, string>,
): LongTextRebuild {
    const { template, placeholders } = extractTextTemplate(originText, "ja");
    const finalTemplate = storedTemplate && storedTemplate.includes("{0}") ? storedTemplate : template;
    const tokens = Object.keys(placeholders);
    if (tokens.length === 0) return { status: "no_segments" };

    // 缺译文的片段直接回填原文：长文本动辄上千个片段，为了几个没翻的词把整条
    // 十万字的文本丢掉得不偿失；这也与 LinguaGacha 对未翻译条目的处理一致，
    // 游戏里表现为该处仍是原文，作者可据此判断要不要补翻
    let filled = 0;
    const translated = finalTemplate.replace(/\{\d+\}/g, (token) => {
        const src = placeholders[token];
        const dst = src === undefined ? undefined : lookup.get(src);
        if (dst === undefined) {
            filled++;
            return src ?? token;
        }
        return dst;
    });
    return { status: "ok", template: finalTemplate, translated, filled };
}

/// 构建 CSV。
/// withObjectPrefix = true（合并导出）：Key 跨文件唯一，形如 {objectId}:{textId}；
/// withObjectPrefix = false（按对象拆分）：文件本身已隔离，Key 直接用 {textId}，
/// 与旧版单文件导出格式一致，喂回「导入译文」也能直接解析。
export function buildCsv(items: ExportableText[], withObjectPrefix = true): CsvBuildResult {
    const lines: string[] = ["Key,Value"];
    const templates: TemplateUpdate[] = [];
    let entryCount = 0;

    const keyOf = (item: ExportableText, token?: string) => {
        const head = withObjectPrefix ? `${item.object_id}:${item.id}` : `${item.id}`;
        return token === undefined ? head : `${head}:${token}`;
    };

    for (const item of items) {
        if (item.text.length > LONG_TEXT_THRESHOLD) {
            const { template, placeholders } = extractTextTemplate(item.text, "ja");
            const tokens = Object.keys(placeholders);
            if (tokens.length > 0) {
                for (const token of tokens) {
                    lines.push(`${csvEscape(keyOf(item, token))},${csvEscape(placeholders[token])}`);
                    entryCount++;
                }
                templates.push({ id: item.id, text_template: template });
                continue;
            }
        }
        lines.push(`${csvEscape(keyOf(item))},${csvEscape(item.text)}`);
        entryCount++;
    }

    return { lines, templates, entryCount };
}

export interface CsvKeyParts {
    objectId: number | null;
    textId: number;
    token: string | null;
}

/// 解析 CSV Key，兼容带/不带文件前缀与占位符后缀
export function parseCsvKey(key: string): CsvKeyParts | null {
    const longMatch = /^(?:(\d+):)?(\d+):(\{\d+\})$/.exec(key);
    if (longMatch) {
        return {
            objectId: longMatch[1] === undefined ? null : Number(longMatch[1]),
            textId: Number(longMatch[2]),
            token: longMatch[3],
        };
    }
    const plainMatch = /^(?:(\d+):)?(\d+)$/.exec(key);
    if (plainMatch) {
        return {
            objectId: plainMatch[1] === undefined ? null : Number(plainMatch[1]),
            textId: Number(plainMatch[2]),
            token: null,
        };
    }
    return null;
}

/// 解析 CSV 为 [键, 值] 行，支持引号包裹的多行字段与 "" 转义引号
export function parseCsv(raw: string): [string, string][] {
    const rows: [string, string][] = [];
    let field = "";
    let row: string[] = [];
    let inQuotes = false;
    let i = raw.startsWith("\uFEFF") ? 1 : 0;

    const pushField = () => { row.push(field); field = ""; };
    const pushRow = () => {
        if (row.length > 1 || row[0] !== "") {
            if (row.length !== 2) {
                throw new Error(`CSV 格式错误：每行应为 键,值 两列，实际 ${row.length} 列`);
            }
            rows.push([row[0], row[1]]);
        }
        row = [];
    };

    while (i < raw.length) {
        const c = raw[i];
        if (inQuotes) {
            if (c === '"') {
                if (raw[i + 1] === '"') { field += '"'; i += 2; continue; }
                inQuotes = false; i++; continue;
            }
            field += c; i++; continue;
        }
        if (c === '"') { inQuotes = true; i++; continue; }
        if (c === ",") { pushField(); i++; continue; }
        if (c === "\n" || c === "\r") {
            pushField(); pushRow();
            if (c === "\r" && raw[i + 1] === "\n") i++;
            i++; continue;
        }
        field += c; i++;
    }
    pushField(); pushRow();

    if (inQuotes) throw new Error("CSV 格式错误：存在未闭合的引号");
    return rows;
}

/// CSV 字段转义：含逗号/引号/换行时用双引号包裹，内部引号双写
export function csvEscape(s: string): string {
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
