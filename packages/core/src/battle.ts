import { cryptoRandom } from "./roulette";

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
