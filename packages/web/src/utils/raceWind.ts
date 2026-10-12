import type { TrackGoing } from "./raceCourse";

// 競馬場に吹く風（向きと強さ）。旗のなびき・尻尾の流れ・芝や木の揺れに使い、出馬表にも出す。
// 見た目だけに使い、レース展開（タイム）には影響しない。
//
// 向きは競馬場の地図の方位ではなく、ゴール前の直線を基準にした角度で持つ（直線で追い風か向かい風かがすぐわかる）。
//   0° = ゴールへ向かって吹く（直線は追い風） / 90° = スタンドから内馬場へ吹く / 180° = 直線は向かい風

export interface RaceWind {
  /** 風が吹いていく向き。ゴール前の直線を走る向きを 0° とし、内馬場の側へ回る向きを正にとる（0..360） */
  directionDeg: number;
  /** 平均の風速（m/s） */
  speedMps: number;
}

/** 直線での風の受け方 */
export type StretchWind = "tailwind" | "headwind" | "crosswind";

/** 馬場状態ごとの風速の幅（m/s）。雨の日ほど風が強い */
const SPEED_RANGE: Record<TrackGoing, [number, number]> = {
  firm: [1, 3],
  good: [2, 4.5],
  yielding: [3.5, 6],
  soft: [5, 8],
};

/**
 * 風を決める
 * @param random 0 以上 1 未満の乱数（テストでは固定値を渡す）
 */
export const createRaceWind = (going: TrackGoing, random: () => number = Math.random): RaceWind => {
  const [min, max] = SPEED_RANGE[going];
  return {
    directionDeg: Math.round(random() * 360) % 360,
    speedMps: Math.round((min + (max - min) * random()) * 10) / 10,
  };
};

/**
 * 馬場状態が変わったときの風。向きはそのまま（同じ日の同じ競馬場なので急には変わらない）で、強さだけを決め直す
 */
export const changeWindForGoing = (wind: RaceWind, going: TrackGoing, random: () => number = Math.random): RaceWind => {
  const [min, max] = SPEED_RANGE[going];
  return { directionDeg: wind.directionDeg, speedMps: Math.round((min + (max - min) * random()) * 10) / 10 };
};

/** 直線で追い風・向かい風・横風のどれか。前後の成分が横の成分より大きければ追い風か向かい風 */
export const stretchWind = (wind: RaceWind): StretchWind => {
  const rad = (wind.directionDeg * Math.PI) / 180;
  const along = Math.cos(rad);
  const across = Math.sin(rad);
  const isCross = Math.abs(across) > Math.abs(along);
  if (isCross) return "crosswind";
  return along > 0 ? "tailwind" : "headwind";
};
