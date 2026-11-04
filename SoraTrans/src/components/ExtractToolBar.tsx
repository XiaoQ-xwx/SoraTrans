import { FiPlay, FiRefreshCw } from "react-icons/fi";
import { PiPause } from "react-icons/pi";
import ScanStatus from "./ScanStatus";
import { useState } from "react";
import { useExtractProgressTable } from "@/utils/useExtractProgress";
import { gm } from "@/utils/GameDbManager";
import { manager } from "@/utils/DbManager";
import { assetApi } from "@/utils/AssetApi";
import { error } from "@tauri-apps/plugin-log";
import { XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";

export default function ExtractToolBar({ title, id }: { title: string, id: number | null }) {

    const [status, setStatus] = useState(0)
    const val = useExtractProgressTable((state) => state.val);
    const setVal = useExtractProgressTable((state) => state.setVal)
    const setIsFirstScan = useExtractProgressTable((state) => state.setIsFirstScan);
    const setTotal = useExtractProgressTable((state) => state.setTotal);
    const setScanned = useExtractProgressTable((state) => state.setScanned);
    const setTotalResult = useExtractProgressTable((state) => state.setTotalResult);
    const [isScanStart, setIsScanStart] = useState(false);
    const [isScanEnd, setIsScanEnd] = useState<boolean>(false);
    // 扫描/提取失败原因（例如 AssetWorker sidecar 没起来），必须让用户看见
    const [scanError, setScanError] = useState("");
    // 重新扫描的对比结果（重扫前后资源数/文本行数），让"有没有变化"一目了然
    const [rescanResult, setRescanResult] = useState<{
        filesBefore: number, filesAfter: number,
        linesBefore: number, linesAfter: number,
    } | null>(null);

    const handleScanBtn = async () => {
        if (!id) return;
        setStatus(1);
        setIsScanStart(true);
        try {
            // project_info.status：0=已导入 1=已补全 2=已扫描；>=2 说明扫描已完成，直接进入提取
            const info = await manager.selectProjectInfo(id);
            if ((info?.status ?? 0) < 2) {
                setIsFirstScan(true);
                await assetApi.scan(title)
                setIsScanEnd(true)
                await manager.updateProjectStatus(id, 2)
                await assetApi.extract()
                await manager.updateProjectStatus(id, 3)
            } else {
                const status = await gm.selectScanStatus();
                if (status && status.total > 0) {
                    const val = Math.ceil(status.scanned * 100.0 / status.total);
                    setVal(val);
                    setTotal(status.total ?? 0);
                    setScanned(status.scanned ?? 0);
                    setTotalResult(status.line ?? 0);
                }
                await assetApi.extract();
                await manager.updateProjectStatus(id, 3)
            }
        } catch (e) {
            // SSE 连接失败（后端未启动/扫描异常）时不能让按钮卡在"暂停"状态，
            // 复位状态并记录日志，避免 Uncaught (in promise)
            const message = e instanceof Error ? e.message : String(e);
            error(`扫描/提取任务失败: ${message}`)
            setScanError(message)
            setStatus(0)
            setIsScanEnd(false)
        } finally {
            setIsScanStart(false);
        }
    }
    // 重新扫描：忽略 project.status，强制重跑「扫描 → 提取」全流程
    // （普通「扫描」在已扫描过的工程上只会重新提取文本，不会重新扫资源）
    const handleRescanBtn = async () => {
        if (!id || isScanStart) return;
        setStatus(1);
        setIsScanStart(true);
        setIsScanEnd(false);
        setScanError("");
        setRescanResult(null);
        try {
            // 记录重扫前的规模，结束后对比，避免"点了没反应"的错觉
            const before = await gm.selectScanStatus().catch(() => null);

            setIsFirstScan(true);
            await assetApi.scan(title)
            setIsScanEnd(true)
            await manager.updateProjectStatus(id, 2)
            await assetApi.extract()
            await manager.updateProjectStatus(id, 3)

            const after = await gm.selectScanStatus().catch(() => null);
            setRescanResult({
                filesBefore: before?.total ?? 0,
                filesAfter: after?.total ?? 0,
                linesBefore: before?.line ?? 0,
                linesAfter: after?.line ?? 0,
            });
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            error(`重新扫描失败: ${message}`)
            setScanError(message)
            setStatus(0)
            setIsScanEnd(false)
        } finally {
            setIsScanStart(false);
        }
    }

    const handleStopBtn = async () => {
        setStatus(3);

        try {
            if (isScanEnd) {
                await assetApi.pauseExtract();
            } else {
                await assetApi.pauseScan();
            }
        } catch (e) {
            error(`暂停失败: ${e}`)
        }
    }
    const handleContinueBtn = async () => {
        setStatus(1);

        try {
            if (isScanEnd) {
                await assetApi.resumeExtract();
            } else {
                await assetApi.resumeScan();
            }
        } catch (e) {
            error(`恢复失败: ${e}`)
        }
    }

    return (
        <div className="w-full h-10 flex gap-4 items-center justify-between">
            <div className="w-full flex h-full  bg-white px-4 py-2 rounded-md items-center justify-between">
                <div className="flex gap-2 items-center truncate pr-2">
                    <span className="text-xs font-semibold select-none truncate" >{title}</span>
                    <ScanStatus status={val == 100 ? 2 : status} />
                </div>
                <div className="flex gap-2">
                    {
                        !isScanStart && id && (
                            <button onClick={handleRescanBtn} className="h-6 gap-1 px-2
                                flex items-center justify-center cursor-pointer
                                text-semibold rounded-sm text-black text-xs
                                border border-gray-400 hover:bg-gray-200">
                                <FiRefreshCw />
                                <span className="select-none">重新扫描</span>
                            </button>
                        )
                    }
                    {
                        isScanStart ? (
                            status != 3 ? (
                                <button onClick={handleStopBtn} className="w-14 h-6 gap-1
                                    flex items-center justify-center cursor-pointer 
                                    text-semibold rounded-sm text-black text-xs
                                    border border-gray-400 hover:bg-gray-200 ">
                                    <PiPause />
                                    <span className="select-none">暂停</span>
                                </button>
                            ) : (
                                <button onClick={handleContinueBtn} className="w-14 h-6 gap-1 
                                    flex items-center justify-center cursor-pointer 
                                    text-semibold rounded-sm text-white text-xs 
                                    bg-[#0067c0] hover:bg-[#0067c0]/70">
                                    <FiPlay />
                                    <span className="select-none">继续</span>
                                </button>
                            )
                        ) : (
                            <button onClick={handleScanBtn} className="w-14 h-6 gap-1 
                                flex items-center justify-center cursor-pointer 
                                text-semibold rounded-sm text-white text-xs 
                                bg-[#0067c0] hover:bg-[#0067c0]/70">
                                <FiPlay />
                                <span className="select-none">扫描</span>
                            </button>
                        )
                    }
                </div>
            </div>
            <Dialog
                open={!!rescanResult}
                onOpenChange={(next) => { if (!next) setRescanResult(null); }}
            >
                <DialogContent className="w-[360px] gap-0 rounded-2xl p-5">
                    <div className="flex items-center gap-3">
                        <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-blue-50">
                            <FiRefreshCw className="size-6 text-blue-600" />
                        </div>
                        <div className="flex min-w-0 flex-col gap-1">
                            <div className="text-sm leading-none font-semibold">重新扫描完成</div>
                            <div className="text-[9px] text-muted-foreground">
                                {rescanResult && rescanResult.filesAfter === rescanResult.filesBefore
                                    && rescanResult.linesAfter === rescanResult.linesBefore
                                    ? "资源与文本都没有变化（磁盘内容未变，重复扫描不会重复写入）"
                                    : "已按磁盘现状刷新资源与文本"}
                            </div>
                        </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-1.5 text-[10px]">
                        <div className="flex h-6 items-center justify-between rounded-sm border px-2">
                            <span className="text-[9px] text-neutral-400">资源文件</span>
                            <span className="font-mono text-neutral-600">
                                {rescanResult?.filesBefore} → {rescanResult?.filesAfter}
                            </span>
                        </div>
                        <div className="flex h-6 items-center justify-between rounded-sm border px-2">
                            <span className="text-[9px] text-neutral-400">文本行数</span>
                            <span className="font-mono text-neutral-600">
                                {rescanResult?.linesBefore} → {rescanResult?.linesAfter}
                            </span>
                        </div>
                    </div>
                    <div className="mt-4 border-t pt-3">
                        <Button size="sm" className="w-full" onClick={() => setRescanResult(null)}>
                            知道了
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
            <Dialog open={!!scanError} onOpenChange={(next) => { if (!next) setScanError(""); }}>
                <DialogContent className="w-[360px] gap-0 rounded-2xl p-5">
                    <div className="flex items-start gap-3">
                        <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-red-50">
                            <XCircle className="size-6 text-red-600" />
                        </div>
                        <div className="flex min-w-0 flex-col gap-1">
                            <div className="text-sm leading-none font-semibold">扫描/提取失败</div>
                            <div className="text-[9px] text-muted-foreground">
                                请确认 AssetWorker 服务已在 http://localhost:5089 运行
                            </div>
                        </div>
                    </div>
                    <div className="mt-4 max-h-24 overflow-y-auto break-all rounded-lg bg-red-50 p-2.5 text-[10px] text-red-600">
                        {scanError}
                    </div>
                    <div className="mt-4 border-t pt-3">
                        <Button size="sm" className="w-full" onClick={() => setScanError("")}>
                            确定
                        </Button>
                    </div>
                </DialogContent>
            </Dialog>
        </div>
    )
}