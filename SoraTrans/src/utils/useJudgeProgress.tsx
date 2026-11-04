import { create } from "zustand";

/// AI 可本地化判定的进度状态，供判定弹窗与资源列表共享
export interface JudgeProgressState {
    running: boolean;
    // 库内文本总数
    total: number;
    // 已判定条数
    judged: number;
    // 其中可本地化条数
    localizable: number;
    // 结束时仍未判定的条数（total - judged）
    failed: number;
    // 已发出的模型请求数
    requests: number;
    // 预估消耗的输入 token（按 字符数/4 粗估）
    estimatedTokens: number;
    message: string;
    finished: boolean;
    // 结果写库后自增，资源列表据此刷新"可本地化"列
    version: number;
    start: () => void;
    setCounts: (counts: { total?: number, judged?: number, localizable?: number }) => void;
    setFailed: (n: number) => void;
    addRequest: (n: number) => void;
    addTokens: (n: number) => void;
    setMessage: (message: string) => void;
    finish: (message: string) => void;
    bumpVersion: () => void;
}

export const useJudgeProgress = create<JudgeProgressState>((set) => ({
    running: false,
    total: 0,
    judged: 0,
    localizable: 0,
    failed: 0,
    requests: 0,
    estimatedTokens: 0,
    message: "",
    finished: false,
    version: 0,
    start: () => set({
        running: true,
        failed: 0,
        requests: 0,
        estimatedTokens: 0,
        message: "正在判定…",
        finished: false,
    }),
    setCounts: (counts) => set((state) => ({
        total: counts.total ?? state.total,
        judged: counts.judged ?? state.judged,
        localizable: counts.localizable ?? state.localizable,
    })),
    setFailed: (n) => set({ failed: n }),
    addRequest: (n) => set((state) => ({ requests: state.requests + n })),
    addTokens: (n) => set((state) => ({ estimatedTokens: state.estimatedTokens + n })),
    setMessage: (message) => set({ message }),
    finish: (message) => set({ running: false, finished: true, message }),
    bumpVersion: () => set((state) => ({ version: state.version + 1 })),
}));
