import { error, info } from '@tauri-apps/plugin-log';
import * as path from '@tauri-apps/api/path';
import AssetInfo from '@/model/AssetInfo';
import { FileTreeItem, useFileTreeStore } from '@/components/FileTree';
import AssetObjectInfo, { useAssetObjectStore } from '@/model/AssetObjectInfo';
import { TextOrigin, useTextOriginStore } from '@/model/TextOrigin';
import type { JudgeProgressInfo, JudgeTargetInfo, LocalizableTextInfo, ObjectJudgeStat, TextJudgeInfo } from '@/model/JudgeInfo';
import { invoke } from '@tauri-apps/api/core';

enum AssetObjSortMethod {
    NameUp = "ORDER BY name ASC",
    NameDown = "ORDER BY name DESC",
    TypeUp = "ORDER BY type ASC",
    TypeDown = "ORDER BY type DESC",
    PathIdUp = "ORDER BY path_id ASC",
    PathIdDown = "ORDER BY path_id DESC",
    SizeUp = "ORDER BY size ASC",
    SizeDown = "ORDER BY size DESC",
    LineUp = "ORDER BY line_count ASC",
    LineDown = "ORDER BY line_count DESC",
    ModDown = "ORDER BY mod DESC"
}

enum TextOriginSortMethod {
    IdUp = "ORDER BY tor.id ASC",
    IdDown = "ORDER BY tor.id DESC",
    OriginUp = "ORDER BY tor.text ASC",
    OriginDown = "ORDER BY tor.text DESC",
    TransUp = "ORDER BY tt.text ASC",
    TransDown = "ORDER BY tt.text DESC"
}

class GameDbManager {

    async init(id: number): Promise<string> {
        try {
            await invoke("init_game_info",{id: id});
            const appPath = await path.appDataDir();
            const dbPath = await path.join(appPath, 'game', `game${id}.db`);
            return dbPath
        } catch (e) {
            // init_game_info 现在会把 open_game 的错误透传上来，
            // 用 error 级别记录，避免被后续"Game 数据库尚未初始化"掩盖真正原因
            error(`Game 数据库初始化失败:${e}`)
            return ""
        }
    }

    async selectScanStatus(): Promise<ScanStatus | null> {
        try {
            const status = await invoke<ScanStatus>("select_scan_status")
            return status
        } catch (error) {
            info(`查询扫描状态失败:${error}`)
            return null
        }
    }

    async selectAssetList(): Promise<void> {
        try {

            const res = await invoke<AssetInfo[]>("select_asset_list")
            const fileTreeMap = new Map<string, FileTreeItem>();

            for (const info of res) {
                if (info.parent_bundle_name) {
                    let fileItem = fileTreeMap.get(info.parent_bundle_name);

                    if (!fileItem) {
                        fileItem = {
                            id: 0,
                            name: info.parent_bundle_name,
                            line: 0,
                            items: []
                        };

                        fileTreeMap.set(info.parent_bundle_name, fileItem);
                    }

                    fileItem.line += info.line_count;

                    (fileItem as { name: string; items: FileTreeItem[] }).items.push({ id: info.id, name: info.name, line: info.line_count });
                } else {
                    if (!fileTreeMap.has(info.name)) {
                        fileTreeMap.set(info.name, {
                            id: info.id,
                            name: info.name,
                            line: info.line_count
                        });
                    }
                }
            }

            useFileTreeStore.getState().setList([...fileTreeMap.values()])
        } catch (error) {
            return;
        }
    }

    async selectDistinctTypes(id: number): Promise<string[]> {
        try {
            return await invoke<string[]>("select_distinct_types", { id: id })
        } catch (error) {
            return []
        }
    }

    async selectAssetObjectList(id: number, sort?: AssetObjSortMethod | null, types?: string[]): Promise<void> {
        try {
            if (sort == AssetObjSortMethod.ModDown) {
                // ModDown 是前端本地排序，先查出数据再按修改状态排序
                const res = await invoke<AssetObjectInfo[]>("select_asset_object_list",{id:id,sort:null,types})
                useAssetObjectStore.getState().setAssetObjList(res);
                useAssetObjectStore.getState().sortListByMod()
            } else {
                const res = await invoke<AssetObjectInfo[]>("select_asset_object_list",{id:id,sort:sort,types})
                useAssetObjectStore.getState().setAssetObjList(res);
            }

        } catch (error) {
            return;
        }
    }

    async selectPatternTree(id: number) {
        try {
            const resList = await invoke<{ id: number, semantic: string, count: number }[]>("select_pattern_tree",{id:id})
            const rootMap = new Map<string, FileTreeItem>();
            for (let res of resList) {
                let parts = res.semantic.split(".");
                this.insertTreeNode(rootMap, parts, res)
            }
            return Array.from(rootMap.values());
        } catch (error) {
            console.error(`获取树失败，${error}`)
        }
    }

    async selectTextAll(objId: number, sort?: TextOriginSortMethod | null) {
        try {
            const res = await invoke<TextOrigin[]>("select_text_all",{id:objId,sort:sort})
            useTextOriginStore.getState().setList(res)
        } catch (error) {
            console.log(`${error}`)
        }
    }

    async selectTextByPatternId(patternId: number, sort?: TextOriginSortMethod | null) {
        try {
            const objId = useAssetObjectStore.getState().id
            const res = await invoke<TextOrigin[]>("select_text_by_pattern_id",{patternId: patternId,objectId: objId,sort: sort})

            useTextOriginStore.getState().setList(res)
        } catch (error) {
            console.log(`${error}`)
        }
    }

    private insertTreeNode(
        map: Map<string, FileTreeItem>,
        parts: string[],
        res: {
            id: number;
            semantic: string;
            count: number;
        },
        depth = 0,
        isLast = false
    ) {
        if (depth >= parts.length) {
            return;
        }

        if (depth === parts.length - 1) {
            isLast = true
        }

        const name = parts[depth];

        let node = map.get(name);

        if (!node) {
            if (!isLast) {
                node = {
                    id: 0,
                    name: name,
                    line: 0,
                    items: []
                }
            } else {
                node = {
                    id: 0,
                    name: name,
                    line: 0
                }
            }
            map.set(name, node)
        }

        node.line += res.count;

        if (depth === parts.length - 1) {
            node.id = res.id;
            return;
        }

        const childMap = new Map<string, FileTreeItem>();

        let newNode = node as { id: number; name: string; line: number; items: FileTreeItem[] }

        // 把现有 children 转成 Map，方便查找
        for (const child of newNode.items ?? []) {
            childMap.set(child.name, child);
        }

        this.insertTreeNode(
            childMap,
            parts,
            res,
            depth + 1,
            isLast
        );

        newNode.items = Array.from(childMap.values());
    }

    async searchAssetObjByName(id: number, val: string, sort?: AssetObjSortMethod | null, types?: string[]): Promise<void> {
        try {
            // ModDown 是前端本地排序，后端不识别，用 null 查询后再本地排序
            const querySort = sort == AssetObjSortMethod.ModDown ? null : sort
            const res = await invoke<AssetObjectInfo[]>("search_asset_obj_by_name",{id:id,val:val,sort:querySort,types})

            useAssetObjectStore.getState().setAssetObjList(res);
            if (sort == AssetObjSortMethod.ModDown) {
                useAssetObjectStore.getState().sortListByMod()
            }
        } catch (error) {
            return;
        }
    }

    async searchText(id: number, val: string, sort?: TextOriginSortMethod | null): Promise<void> {
        try {
            const res = await invoke<TextOrigin[]>("search_text",{id:id,val: val, sort:sort})
            useTextOriginStore.getState().setList(res)
        } catch (error) {
            return;
        }
    }

    async searchTextWithPatternId(patternId: number, val: string, sort?: TextOriginSortMethod | null): Promise<void> {
        try {
            const objId = useAssetObjectStore.getState().id
            const res = await invoke<TextOrigin[]>("search_text_with_pattern_id",{patternId: patternId,objectId: objId,val: val,sort: sort})
            
            useTextOriginStore.getState().setList(res)
        } catch (error) {
            return;
        }
    }

    async insertTrans(originId: number, val: string) {
        try {
            const objId = useAssetObjectStore.getState().id
            await invoke("insert_trans",{objectId: objId,originId:originId,val:val})
        } catch (error) {
            return;
        }
    }

    async insertBatchTrans(list: TextOrigin[]) {
        try {
            const objId = useAssetObjectStore.getState().id
            await invoke("insert_batch_trans",{objectId: objId,list:list})
        } catch (error) {
            return;
        }
    }

    // 批量回写再提取生成的占位符模板到 text_origin.text_template
    async updateTextTemplates(list: { id: number, text_template: string }[]) {
        try {
            await invoke("update_text_templates", { list })
        } catch (e) {
            error(`更新 text_template 失败:${e}`)
        }
    }

    // 同上，但失败直接上抛：导出可本地化文本时模板写不进去，
    // 这份 CSV import 回来就会报"缺少再提取模板"，必须让用户看到
    async updateTextTemplatesStrict(list: { id: number, text_template: string }[]): Promise<void> {
        await invoke("update_text_templates", { list })
    }

    // 按 id 批量查询再提取模板，返回 id -> template；查询失败直接抛出，
    // 让导入流程整体报错，避免缺模板时静默生成错误译文
    async selectTextTemplates(ids: number[]): Promise<Map<number, string>> {
        const res = await invoke<{ id: number, text_template: string }[]>(
            "select_text_templates",
            { ids }
        );
        return new Map(res.map(item => [item.id, item.text_template]));
    }

    // ============ AI 可本地化判定 ============
    // 判定相关命令不吞异常：判定流程需要把"游戏库未初始化/写库失败"
    // 等真实原因抛到界面，而不是静默中断

    // 游标分批拉取待判定文本；onlyUnjudged = true 时只取还没有判定结果的条目
    async selectJudgeTargets(afterId: number, limit: number, onlyUnjudged: boolean): Promise<JudgeTargetInfo[]> {
        return await invoke<JudgeTargetInfo[]>("select_judge_targets", { afterId, limit, onlyUnjudged })
    }

    // 批量回写判定结果
    async insertJudgeResults(list: TextJudgeInfo[]): Promise<void> {
        await invoke("insert_judge_results", { list })
    }

    // 按文件聚合的可本地化统计，资源列表展示 "可本地化数/已判定数"
    async selectObjectJudgeStats(): Promise<ObjectJudgeStat[]> {
        return await invoke<ObjectJudgeStat[]>("select_object_judge_stats")
    }

    // 判定进度
    async selectJudgeProgress(): Promise<JudgeProgressInfo> {
        return await invoke<JudgeProgressInfo>("select_judge_progress")
    }

    // 清空判定结果，供重新判定
    async clearJudgeResults(): Promise<void> {
        await invoke("clear_judge_results")
    }

    // 拉取导出用文本（一键导出）；onlyLocalizable=true 时只取判定为可本地化的
    async selectExportTexts(onlyLocalizable: boolean): Promise<LocalizableTextInfo[]> {
        return await invoke<LocalizableTextInfo[]>("select_export_texts", { onlyLocalizable })
    }

    // ============ 译文导入 ============

    // 拉取超过指定长度的文本行，导入时按再提取模板逐段重建
    async selectLongTexts(minLen: number): Promise<TextOrigin[]> {
        return await invoke<TextOrigin[]>("select_long_texts", { minLen })
    }

    // 按"原文"批量回写译文，返回实际写入的文本行数
    async importTransByText(list: { src: string, dst: string }[]): Promise<number> {
        return await invoke<number>("import_trans_by_text", { list })
    }

    // 静默批量写译文（不触发 setMod 事件，跨文件导入用）
    async insertBatchTransSimple(list: TextOrigin[]): Promise<void> {
        await invoke("insert_batch_trans_simple", { list })
    }
}

const gm: GameDbManager = new GameDbManager();

export { gm }
export type { GameDbManager }
export { AssetObjSortMethod, TextOriginSortMethod }