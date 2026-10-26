// 长文本"再提取"：按源语言选择正则，把【需要翻译的日文片段】挖出来替换为
// {0}/{1} 占位符，数字、标点、// 注释、编号等结构原样保留在模板中。
// 模板存进 text_origin.text_template；导出时长文本拆成扁平条目
// "id:{0}": "日文片段"，供翻译人员逐段翻译后回填。

// 超过该长度（字符数）的 origin_text 才触发再提取
export const LONG_TEXT_THRESHOLD = 100;

// 目前只接入日语；后续新增语言时在此追加正则即可
export type TemplateLanguage = "ja";

// 判断块内是否真的含日文"文字"（不能只有标点）。
// 注意必须排除 ・(U+30FB) 与 ー(U+30FC)：
// 它们落在片假名区段却只是符号，否则 '・・・' 会被当成日文句子抽出来
// （实测同一份导出文件里出现过 420 次 '・・・' 条目）。
const JP_CHAR_PATTERN = /[ぁ-ゖゝゞァ-ヺヽヾ㐀-䶿一-鿿]/;

// 变量/占位标记，如 {_NAME_}、{0}、{PLAYER}。
// 它们紧贴日文时会被并入片段，保证翻译时能看到变量位置；
// 否则 {_NAME_} 会被留在模板里，译文语序无从判断（实测丢失率 100%）。
const VAR_TOKEN_PATTERN = /\{[A-Za-z0-9_]+\}/g;

// 日文块 + 紧邻的变量标记
const JP_WITH_VAR_PATTERN =
    /(?:\{[A-Za-z0-9_]+\})?[぀-ヿ㐀-䶿一-鿿　-〿＀-￯]+(?:\{[A-Za-z0-9_]+\})?/g;

// 抽取字符串里出现的变量标记（保持顺序，用于导入时校验译文是否丢变量）
export function extractVarTokens(text: string): string[] {
    return text.match(VAR_TOKEN_PATTERN) ?? [];
}

const LANGUAGE_PATTERNS: Record<TemplateLanguage, RegExp> = {
    ja: JP_WITH_VAR_PATTERN,
};

// ============ 双语 CSV 表（TextAsset 配置表）============
// 这类文件（chara_0 / UI / actionlib …）整块是几十万字符的表格，
// 玩家可见的英文在 ENG / name_ENG / info_ENG 这些列里。
// 如果按上面的日文正则去挖，会碎成一堆表头词和注释（实测同一份 chara_0
// 抽出 2902 个碎片），完全没法用。所以按列取单元格：每个单元格一个占位符，
// 回填时按模板原位拼回，表格结构与其它列一个字都不动。

// 导出口径。工具不再让用户选：固定 "both" —— 表格里识别出的日文列和英文列
// 全部导出（英文配 {e*}、日文配 {j*}，一份模板同时表达两列，回填时一起替换）。
// 保留 eng/jap 两个分支只为将来需要时能切，正常流程不会走到。
export type CsvColumnMode = "eng" | "jap" | "both";

// 当前固定口径：多语言取舍交给后期工具，工具本身不做决策
export const DEFAULT_COLUMN_MODE: CsvColumnMode = "both";

// ============ 通用表格结构探测 ============
// 不靠列名猜。列名只当提示，真正判据是一列数据的形态：纯数字 / 短标识符 /
// 自然语言。这样换个游戏（表头叫 English、EN、或者压根没有表头）也能认出来。
// 起因：只按 /(.+_)?ENG$/ 匹配列名时，UI 表的 size_ENG（内容是 22 个 "24"）
// 会被当成待译列，混进一堆数字。

export type ColumnKind = "text" | "number" | "ident" | "empty";

export interface ColumnProfile {
    index: number;
    /** 表头文字（无表头时为空串） */
    name: string;
    kind: ColumnKind;
    nonEmpty: number;
    /** 含日文假名/汉字的行数 */
    japanese: number;
    /** 含 ASCII 字母的行数 */
    ascii: number;
    samples: string[];
}

export interface TableProfile {
    /** -1 表示没找到表头 */
    headerIndex: number;
    rowCount: number;
    columns: ColumnProfile[];
    /** 按数据形态推断出的可译列；用户可在界面上改 */
    suggested: { eng: number[]; jap: number[] };
}

// 占位符 token：单列 {0}、{1}…；both 模式 {e0}/{e1} 与 {j0}/{j1}
// 导入侧必须用同一个正则，否则拼不回去
export const PLACEHOLDER_TOKEN_PATTERN = /\{[ej]?\d+\}/g;

const JP_CHAR = /[\u3041-\u3096\u30a1-\u30fa\u3400-\u4dbf\u4e00-\u9fff]/;
const NUMBER_LIKE = /^-?\d+(?:\.\d+)?$/;
const IDENT_LIKE = /^[A-Za-z0-9_\-.:]+$/;
// 表头里出现这些词，说明是内容列而不是尺寸/编号列
const HEADER_HINT = /^(?:.+_)?(?:ENG|EN|JAP|JP|JA|JAPANESE|ENGLISH)$/i;

// 命令语法/路径片段（如 CHOICE(Heal me/3_lv2_1)）不是玩家可见文本，
// 是脚本参数，提取出来只会污染待译稿
const CSV_STRUCTURAL = /[()/\\]/;

function splitCsvLines(text: string): string[] {
    return text.includes("\r\n") ? text.split("\r\n") : text.split("\n");
}

/**
 * 判断这串文本是不是结构化表格，并给出每列的数据形态。
 * 判据全部来自数据本身（列数一致性 + 每列的内容形态），不依赖列名，
 * 所以换游戏也能用；列名只用于给建议列加权重。
 */
export function analyzeTable(origin: string): TableProfile | null {
    if (origin.length < 100 || !origin.includes(",")) return null;
    const lines = splitCsvLines(origin);
    if (lines.length < 5) return null;

    // 表格的判据：绝大多数行的列数一致，且列数 >= 3
    const widthCount = new Map<number, number>();
    for (const l of lines) {
        const w = l.split(",").length;
        widthCount.set(w, (widthCount.get(w) ?? 0) + 1);
    }
    let width = 0;
    let hits = 0;
    for (const [w, n] of widthCount) {
        if (n > hits) { hits = n; width = w; }
    }
    if (width < 3 || hits / lines.length < 0.8) return null;

    // 表头：前 20 行里含 ENG/JAP/EN/JP 之类字段名的那一行（没有就是 -1）
    let headerIndex = -1;
    for (let i = 0; i < Math.min(lines.length, 20); i++) {
        const cells = lines[i].split(",").map((c) => c.replace(/^\uFEFF/, "").trim());
        if (cells.some((c) => HEADER_HINT.test(c))) { headerIndex = i; break; }
    }

    const dataStart = headerIndex >= 0 ? headerIndex + 1 : 0;
    const headerCells = headerIndex >= 0
        ? lines[headerIndex].split(",").map((c) => c.replace(/^\uFEFF/, "").trim())
        : [];

    const columns: ColumnProfile[] = [];
    for (let c = 0; c < width; c++) {
        let nonEmpty = 0;
        let japanese = 0;
        let ascii = 0;
        let numeric = 0;
        let ident = 0;
        const samples: string[] = [];
        for (let i = dataStart; i < lines.length; i++) {
            const cells = lines[i].split(",");
            if (c >= cells.length) continue;
            const v = cells[c].replace(/^\uFEFF/, "").trim();
            if (!v) continue;
            nonEmpty++;
            if (JP_CHAR.test(v)) japanese++;
            if (/[A-Za-z]/.test(v)) ascii++;
            if (NUMBER_LIKE.test(v)) numeric++;
            if (IDENT_LIKE.test(v) && !v.includes(" ") && !JP_CHAR.test(v)) ident++;
            if (samples.length < 3) samples.push(v);
        }

        let kind: ColumnKind;
        if (nonEmpty === 0) kind = "empty";
        else if (numeric / nonEmpty >= 0.8) kind = "number";
        else if (ident / nonEmpty >= 0.8) kind = "ident";
        else kind = "text";

        columns.push({
            index: c,
            name: headerCells[c] ?? "",
            kind,
            nonEmpty,
            japanese,
            ascii,
            samples,
        });
    }

    return {
        headerIndex,
        rowCount: lines.length - dataStart,
        columns,
        suggested: suggestColumns(columns, headerIndex >= 0, lines.length - dataStart),
    };
}

/**
 * 按数据形态推断可译列：
 *  - 日文列 = 文本列里含日文比例较高的
 *  - 英文列 = 文本列里几乎不含日文、但有 ASCII 字母的
 * 数字列和标识符列天然被排除（这就是 size_ENG 不会再混进来的原因）。
 * 表头名命中 ENG/JAP 的列，只要不是数字列/空列就纳入，作为提示加权。
 */
function suggestColumns(
    columns: ColumnProfile[],
    hasHeader: boolean,
    rowCount: number
): { eng: number[]; jap: number[] } {
    // 稀疏列（只零星几行有值）通常是注释/备注，不是正文，不纳入建议
    const denseFrom = Math.max(3, rowCount * 0.1);
    const text = columns.filter((c) => c.kind === "text" && c.nonEmpty >= denseFrom);
    const jap = text
        .filter((c) => c.japanese >= Math.max(1, c.nonEmpty * 0.15))
        .map((c) => c.index);
    const eng = text
        .filter((c) => c.japanese === 0 && c.ascii >= Math.max(1, c.nonEmpty * 0.3))
        .map((c) => c.index);

    if (hasHeader) {
        for (const c of columns) {
            if (c.kind === "number" || c.kind === "empty") continue;
            if (/^(?:.+_)?(?:ENG|EN|ENGLISH)$/i.test(c.name) && !eng.includes(c.index)) eng.push(c.index);
            if (/^(?:.+_)?(?:JAP|JP|JA|JAPANESE)$/i.test(c.name) && !jap.includes(c.index)) jap.push(c.index);
        }
    }
    return { eng: eng.sort((a, b) => a - b), jap: jap.sort((a, b) => a - b) };
}

/**
 * 若 origin 是"带 ENG 列的双语 CSV 表"，返回按单元格拆好的模板；
 * 不是这种结构时返回 null，交由日文正则那条路径处理。
 */
/** 按显式列组挖占位符。prefix: "" 单列 / "e" 英文 / "j" 日文 */
function buildTemplateFromColumns(
    origin: string,
    profile: TableProfile,
    groups: { cols: number[]; prefix: "" | "e" | "j" }[]
): TextTemplateExtractResult | null {
    const lines = splitCsvLines(origin);
    const eol = origin.includes("\r\n") ? "\r\n" : "\n";
    const start = profile.headerIndex >= 0 ? profile.headerIndex + 1 : 0;
    const counters: Record<string, number> = { "": 0, e: 0, j: 0 };
    const tokenByContent = new Map<string, string>();

    const outLines = lines.map((line, li) => {
        if (li < start) return line;
        const cells = line.split(",");
        for (const g of groups) {
            for (const c of g.cols) {
                if (c >= cells.length) continue;
                const value = cells[c].replace(/^\uFEFF/, "").trim();
                if (!value) continue;
                // 命令语法/路径片段（CHOICE(Heal me/xxx)）是脚本参数，不是玩家可见文本
                if (CSV_STRUCTURAL.test(value) && !JP_CHAR.test(value)) continue;
                // 同一内容在英文列和日文列各占一个 token，故 key 要带前缀
                const key = `${g.prefix}|${value}`;
                let token = tokenByContent.get(key);
                if (token === undefined) {
                    token = `{${g.prefix}${counters[g.prefix]++}}`;
                    tokenByContent.set(key, token);
                }
                cells[c] = cells[c].replace(value, token);
            }
        }
        return cells.join(",");
    });

    if (tokenByContent.size === 0) return null;

    const placeholders: Record<string, string> = {};
    for (const [key, token] of tokenByContent) placeholders[token] = key.slice(key.indexOf("|") + 1);
    return { template: outLines.join(eol), placeholders };
}

/**
 * 把结构化表格按列拆成模板。
 * mode: eng / jap / both（both 时英文列配 {e*}、日文列配 {j*}）
 * profile 可由调用方传入（用户在界面上手动改过列之后必须传入，保证导出导入一致）。
 */
export function extractCsvTemplate(
    origin: string,
    mode: CsvColumnMode = DEFAULT_COLUMN_MODE,
    profile?: TableProfile
): TextTemplateExtractResult | null {
    const tbl = profile ?? analyzeTable(origin);
    if (!tbl) return null;

    const groups: { cols: number[]; prefix: "" | "e" | "j" }[] = [];
    if (mode === "both") {
        if (tbl.suggested.eng.length > 0) groups.push({ cols: tbl.suggested.eng, prefix: "e" });
        if (tbl.suggested.jap.length > 0) groups.push({ cols: tbl.suggested.jap, prefix: "j" });
    } else if (mode === "eng" && tbl.suggested.eng.length > 0) {
        groups.push({ cols: tbl.suggested.eng, prefix: "" });
    } else if (mode === "jap" && tbl.suggested.jap.length > 0) {
        groups.push({ cols: tbl.suggested.jap, prefix: "" });
    }
    if (groups.length === 0) return null;
    return buildTemplateFromColumns(origin, tbl, groups);
}

/**
 * 这串文本是不是"带 ENG 列的双语 CSV 表"。
 * 产线 A（结构化表格）靠它识别：这类内容由结构决定必然要翻译，
 * 不需要也不应该参与 AI 按 pattern 的语义判定。
 */
export function isCsvTableText(origin: string): boolean {
    const profile = analyzeTable(origin);
    if (!profile) return false;
    return profile.suggested.eng.length > 0 || profile.suggested.jap.length > 0;
}

/**
 * 统一入口：先判断是不是双语 CSV 表，是就按列拆，否则走日文片段正则。
 * 导出和导入必须都走这个函数，否则模板与占位符编号会错位。
 */
export function extractTemplateAuto(
    origin: string,
    language: TemplateLanguage = "ja",
    mode: CsvColumnMode = DEFAULT_COLUMN_MODE,
    profile?: TableProfile
): TextTemplateExtractResult {
    // 先按用户选的口径取列；该表没有这种列时（例如 chara_0 只有 ENG、没有 JAP）
    // 退回日文片段正则，保证永远有产出而不是整块漏掉
    const csv = extractCsvTemplate(origin, mode, profile);
    if (csv) return csv;
    return extractTextTemplate(origin, language);
}

export interface TextTemplateExtractResult {
    // 日文片段被替换为占位符后的模板，如：0:{0},,// 8:{1},,
    template: string;
    // 占位符 -> 被挖出的日文片段，长文本条目导出时直接作为该条目的值
    placeholders: Record<string, string>;
}

/**
 * 用指定语言的正则把原文中的待翻译片段替换为占位符。
 * 占位符按首次出现顺序编号；相同片段复用同一占位符，
 * 保证同一条原文重复导出时结果稳定一致。
 */
export function extractTextTemplate(
    origin: string,
    language: TemplateLanguage = "ja"
): TextTemplateExtractResult {
    const pattern = LANGUAGE_PATTERNS[language];
    const regex = new RegExp(pattern.source, pattern.flags);
    const tokenByContent = new Map<string, string>();
    let index = 0;

    const template = origin.replace(regex, (matched) => {
        // 纯标点/全角符号块不含假名或汉字，不视为待翻译内容
        if (!JP_CHAR_PATTERN.test(matched)) {
            return matched;
        }
        let token = tokenByContent.get(matched);
        if (token === undefined) {
            token = `{${index++}}`;
            tokenByContent.set(matched, token);
        }
        return token;
    });

    const placeholders: Record<string, string> = {};
    for (const [content, token] of tokenByContent) {
        placeholders[token] = content;
    }

    return { template, placeholders };
}
