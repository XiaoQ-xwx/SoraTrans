import { useEffect, useState } from 'react';
import './Launcher.css'
import TitleBar from "./components/TitleBar";
import { gm } from './utils/GameDbManager';
import FileTree, { FileTreeItem } from './components/FileTree';
import TextTable from './components/ui/text-table';
import { useTextOriginStore } from './model/TextOrigin';
import { useAssetObjectStore } from './model/AssetObjectInfo';
import TextToolBar from './components/TextToolBar';
import { listen } from '@tauri-apps/api/event';
import { AiProgress } from './model/AiSettings';

function ViewText() {

    const title = useTextOriginStore((state)=>state.title)
    // "仅显示可本地化"过滤开关（TextToolBar 切换），变化时重载 pattern 树
    const localizableOnly = useTextOriginStore((state) => state.localizableOnly)
    const [patternTree, setPatternTree] = useState<FileTreeItem[]>([]);

    const getPatternTree = async (objId: number) => {
        const tree = await gm.selectPatternTree(objId)
        setPatternTree(tree ?? [])
    }

    const getObjId = () => Number(new URLSearchParams(window.location.search).get("objId"));

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const id = Number(params.get("objId"));
        const title = String(params.get("title"));
        useAssetObjectStore.getState().setId(id);
        useTextOriginStore.getState().setTitle(title);
        useTextOriginStore.getState().setInitTitle(title);
        gm.selectTextAll(id)
    }, [])

    // pattern 树：过滤条件变化时重载（首次加载也在本 effect 完成）
    useEffect(() => {
        const id = getObjId();
        if (!id) return;
        getPatternTree(id)
    }, [localizableOnly])

    // AI 识别结束后自动刷新 pattern 树，展示新标注（识别中的进度由 TextToolBar 呈现）
    useEffect(() => {
        const un = listen<AiProgress>("ai-recognition-progress", (event) => {
            if (!event.payload.finished) return;
            const id = getObjId();
            if (id) getPatternTree(id)
        })
        return () => { un.then(fn => fn()) }
    }, [])

    return (
        <div className="flex flex-col h-screen w-screen " onContextMenu={(e) => e.preventDefault()}>
            <TitleBar className='pl-2 pr-4 h-[30px]' title={title} />
            <main className="flex flex-1 w-screen overflow-y-hidden bg-[#f0f1f3] overflow-hidden">
                <div className='px-2 flex flex-1 py-2 gap-2'>
                    <div className='w-[25%] bg-white rounded-sm'>
                        <FileTree
                            fileTree={patternTree}
                            type="pattern"
                            emptyTitle={localizableOnly ? "暂无可本地化文本" : undefined}
                            emptyDesc={localizableOnly ? "请先点击右侧 AI 识别" : undefined}
                        />
                    </div>
                    <div className='w-[50%] bg-white rounded-sm py-2'>
                        <TextTable/>
                    </div>
                    <div className='w-[25%] bg-white rounded-sm'>
                        <TextToolBar/>
                    </div>
                </div>
            </main>
        </div>
    );
}

export default ViewText;
