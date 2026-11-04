import { open, save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { join } from "@tauri-apps/api/path";
import { gm } from "./GameDbManager";
import { buildCsv, buildKvJson } from "./LocalizableFormat";
import type { ExportableText, TemplateUpdate } from "./LocalizableFormat";
import type { LocalizableTextInfo } from "@/model/JudgeInfo";

// 一键导出"所有可本地化文本"，支持两种排布：
//   拆分（默认）—— 每个资源对象一个文件，文件名取对象名，
//                  与手工流程的「汉化优化版2」目录一致（en.json / level0 / model_*Avatar.json ...）
//   合并       —— 全部写进一个文件
// 格式由调用方在应用内先选好（KV JSON / CSV），不再依赖资源管理器的文件类型下拉。

export type LocalizableExportFormat = "json" | "csv";

export interface ExportOptions {
    format: LocalizableExportFormat;
    // true = 每个资源对象一个文件；false = 合并成一个
    split: boolean;
    // 拆分模式下：同名对象是否合并到一个文件
    // undefined = 还没决定（导出前会检查重名，发现重名再问用户）
    mergeSameName?: boolean;
    // 只导出判定为可本地化的文本；false = 导出全部已提取文本
    onlyLocalizable: boolean;
}

/// 同名对象分组结果：name = 对象名，count = 有多少个不同对象用了这个名字
export interface DuplicateNameGroup {
    name: string;
    count: number;
}

/// 检查"按对象名拆分"时是否存在同名对象（Unity 里大量 UI 对象都叫 TextMeshProUGUI）
export function inspectDuplicateNames(list: LocalizableTextInfo[]): DuplicateNameGroup[] {
    const nameToObjects = new Map<string, Set<number>>();
    for (const item of list) {
        const name = safeFileName(item.object_name, item.object_id);
        const set = nameToObjects.get(name);
        if (set) {
            set.add(item.object_id);
        } else {
            nameToObjects.set(name, new Set([item.object_id]));
        }
    }
    const duplicates: DuplicateNameGroup[] = [];
    for (const [name, ids] of nameToObjects) {
        if (ids.size > 1) duplicates.push({ name, count: ids.size });
    }
    // 数量多的排前面，提示时更有说服力
    return duplicates.sort((a, b) => b.count - a.count);
}

export interface LocalizableExportResult {
    // 拆分模式是目录，合并模式是文件
    filePath: string;
    format: LocalizableExportFormat;
    split: boolean;
    // 可本地化文本条数
    textCount: number;
    // 实际导出的条目数（长文本按占位符片段计，KV JSON 会按原文去重）
    entryCount: number;
    // 涉及的文件数
    fileCount: number;
}

export async function exportLocalizable(
    title: string,
    options: ExportOptions,
    // 允许调用方预加载一次列表（重名检查与导出共用，避免两次全表查询）
    preloaded?: LocalizableTextInfo[],
): Promise<LocalizableExportResult | null> {
    const list = preloaded ?? await gm.selectExportTexts(options.onlyLocalizable);
    if (list.length === 0) {
        throw new Error(options.onlyLocalizable
            ? "没有可本地化的文本：请先执行「AI 判断可本地化」，或取消勾选「仅导出可本地化」"
            : "当前游戏还没有提取出任何文本");
    }

    return options.split
        ? await exportSplit(list, options.format, options.mergeSameName ?? true)
        : await exportMerged(list, title, options.format);
}

/// 按资源对象拆分成多个文件
async function exportSplit(
    list: LocalizableTextInfo[],
    format: LocalizableExportFormat,
    mergeSameName: boolean,
): Promise<LocalizableExportResult | null> {
    const dir = await open({
        title: "选择导出目录（每个资源对象生成一个文件）",
        directory: true,
        multiple: false,
    });
    if (!dir || Array.isArray(dir)) return null;

    // 分组策略由用户选：
    //   合并同名 —— 参照手工流程，所有 TextMeshProUGUI 汇总成一个文件
    //   不合并   —— 每个对象单独一个文件，同名加 _1/_2 后缀区分
    const groups = new Map<string, ExportableText[]>();
    if (mergeSameName) {
        for (const item of list) {
            const name = safeFileName(item.object_name, item.object_id);
            const group = groups.get(name);
            if (group) {
                group.push(item);
            } else {
                groups.set(name, [item]);
            }
        }
    } else {
        const used = new Set<string>();
        const byObject = new Map<number, { name: string, items: ExportableText[] }>();
        for (const item of list) {
            const bucket = byObject.get(item.object_id);
            if (bucket) {
                bucket.items.push(item);
            } else {
                byObject.set(item.object_id, { name: item.object_name, items: [item] });
            }
        }
        for (const [objectId, group] of byObject) {
            const base = safeFileName(group.name, objectId);
            groups.set(uniqueFileName(base, used), group.items);
        }
    }

    const templates: TemplateUpdate[] = [];
    let entryCount = 0;

    for (const [fileName, items] of groups) {
        if (format === "json") {
            const built = buildKvJson(items);
            await writeTextFile(await join(dir, `${fileName}.json`), JSON.stringify(built.data, null, 4));
            templates.push(...built.templates);
            entryCount += built.entryCount;
        } else {
            const built = buildCsv(items, false);
            await writeTextFile(await join(dir, `${fileName}.csv`), built.lines.join("\n"));
            templates.push(...built.templates);
            entryCount += built.entryCount;
        }
    }

    // 模板写不进去就不能算导出成功：否则这批文件导入回来拼不出长文本
    if (templates.length > 0) await gm.updateTextTemplatesStrict(templates);

    return {
        filePath: dir,
        format,
        split: true,
        textCount: list.length,
        entryCount,
        fileCount: groups.size,
    };
}

/// 合并成一个文件
async function exportMerged(
    list: LocalizableTextInfo[],
    title: string,
    format: LocalizableExportFormat,
): Promise<LocalizableExportResult | null> {
    const filePath = await save({
        title: "导出可本地化文本（合并）",
        defaultPath: `${title}_localizable.${format}`,
        filters: [
            format === "json"
                ? { name: "KV JSON", extensions: ["json"] }
                : { name: "CSV", extensions: ["csv"] },
        ],
    });
    if (!filePath) return null;

    const items: ExportableText[] = list;
    const fileCount = new Set(list.map((item) => item.object_id)).size;

    if (format === "json") {
        const { data, templates, entryCount } = buildKvJson(items);
        await writeTextFile(filePath, JSON.stringify(data, null, 4));
        if (templates.length > 0) await gm.updateTextTemplatesStrict(templates);
        return { filePath, format, split: false, textCount: list.length, entryCount, fileCount };
    }

    const { lines, templates, entryCount } = buildCsv(items, true);
    await writeTextFile(filePath, lines.join("\n"));
    if (templates.length > 0) await gm.updateTextTemplatesStrict(templates);
    return { filePath, format, split: false, textCount: list.length, entryCount, fileCount };
}

/// 同名对象不合并时，用 _1/_2 后缀区分
function uniqueFileName(base: string, used: Set<string>): string {
    let candidate = base;
    let index = 1;
    while (used.has(candidate.toLowerCase())) {
        candidate = `${base}_${index++}`;
    }
    used.add(candidate.toLowerCase());
    return candidate;
}

/// 文件名安全化：去掉 Windows 非法字符，保留可读性
function safeFileName(name: string, objectId: number): string {
    const cleaned = name
        .replace(/[\\/:*?"<>|]/g, "_")
        .replace(/[\r\n\t]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^\.+/, "")
        .slice(0, 120);
    return cleaned === "" ? `object_${objectId}` : cleaned;
}

