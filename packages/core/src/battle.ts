import { cryptoRandom } from "./roulette";

// crypto.getRandomValues は 1 回あたり 65,536 バイト = Uint32Array 16,384 要素が上限
export const MAX_RANDOM_CHUNK = 16384;

const UINT32_RANGE = 0xffffffff + 1;

export type RandomFiller = (target: Uint32Array) => void;

export const cryptoFillRandom: RandomFiller = (target) => {
  crypto.getRandomValues(target);
};

interface DrawBattleCountsOptions {
  optionCount: number;
  drawCount: number;
  fillRandom?: RandomFiller;
  chunkSize?: number;
  /** counts は集計中の実体を渡すので、保持せずその場で読むこと */
  onProgress?: (processed: number, counts: readonly number[]) => void;
}

// 数列を実体化せずチャンク単位で集計するため、消費メモリは drawCount に依存しない
export const drawBattleCounts = ({
  optionCount,
  drawCount,
  fillRandom = cryptoFillRandom,
  chunkSize = MAX_RANDOM_CHUNK,
  onProgress,
}: DrawBattleCountsOptions): number[] => {
  if (optionCount <= 0) return [];
  const counts = new Array<number>(optionCount).fill(0);
  if (drawCount <= 0) return counts;

  const size = Math.max(1, Math.min(chunkSize, drawCount));
  const buffer = new Uint32Array(size);
  let processed = 0;

  while (processed < drawCount) {
    const length = Math.min(size, drawCount - processed);
    const chunk = length === size ? buffer : buffer.subarray(0, length);
    fillRandom(chunk);
    for (let i = 0; i < length; i += 1) {
      counts[Math.floor((chunk[i] / UINT32_RANGE) * optionCount)] += 1;
    }
    processed += length;
    onProgress?.(processed, counts);
  }

  return counts;
};

export const drawBattleSequence = (
  optionCount: number,
  drawCount: number,
  random: () => number = cryptoRandom
): number[] => {
  if (optionCount <= 0 || drawCount <= 0) return [];
  const sequence: number[] = new Array(drawCount);
  for (let i = 0; i < drawCount; i += 1) {
    sequence[i] = Math.floor(random() * optionCount);
  }
  return sequence;
};

export const tallyBattle = (
  optionCount: number,
  draws: number[]
): number[] => {
  const counts = new Array<number>(optionCount).fill(0);
  for (const idx of draws) {
    if (idx >= 0 && idx < optionCount) {
      counts[idx] += 1;
    }
  }
  return counts;
};
