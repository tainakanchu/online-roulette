/** 馬番 → 枠番（9 頭以上は外枠から 2 頭ずつ入る JRA 方式） */
export const frameNumber = (horseNumber: number, fieldSize: number): number => {
  if (fieldSize <= 8) return horseNumber;
  const base = Math.floor(fieldSize / 8);
  const extra = fieldSize % 8;
  let cumulative = 0;
  for (let frame = 1; frame <= 8; frame += 1) {
    cumulative += base + (frame > 8 - extra ? 1 : 0);
    if (horseNumber <= cumulative) return frame;
  }
  return 8;
};
