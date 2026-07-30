import { drawBattleCounts, drawBattleSequence } from "@tainakanchu/roulette-core";

// 進捗投稿はメイン側の UI 更新頻度に合わせて間引く
const PROGRESS_INTERVAL_MS = 33;

export interface BattleWorkerRequest {
  optionCount: number;
  drawCount: number;
  /** 従来レンジは抽選順どおりの演出をするため、index 列そのものを返す */
  wantSequence: boolean;
}

export type BattleWorkerResponse =
  | { type: "sequence"; sequence: number[] }
  | { type: "progress"; processed: number; counts: number[] }
  | { type: "done"; counts: number[] };

// このモジュールは Worker スコープで動くため、self を Worker の口として扱う
const ctx = self as unknown as {
  postMessage: (message: BattleWorkerResponse) => void;
  addEventListener: (
    type: "message",
    listener: (e: MessageEvent<BattleWorkerRequest>) => void,
  ) => void;
};

ctx.addEventListener("message", (e) => {
  const { optionCount, drawCount, wantSequence } = e.data;

  if (wantSequence) {
    ctx.postMessage({
      type: "sequence",
      sequence: drawBattleSequence(optionCount, drawCount),
    });
    return;
  }

  let lastPost = 0;
  const counts = drawBattleCounts({
    optionCount,
    drawCount,
    onProgress: (processed, current) => {
      const now = performance.now();
      if (now - lastPost < PROGRESS_INTERVAL_MS) return;
      lastPost = now;
      ctx.postMessage({ type: "progress", processed, counts: [...current] });
    },
  });

  ctx.postMessage({ type: "done", counts });
});
