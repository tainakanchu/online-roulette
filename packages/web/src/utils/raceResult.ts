import type { TrackGoing, TrackSurface } from "./raceCourse";

// ターフビジョンに出す走破タイムと着差。レースの内部時間を、距離・コース・馬場から決めた実際らしい時計に換算する。

/** 馬場が渋るほど芝は時計がかかり、ダートは締まって少し速くなる */
const GOING_SPEED: Record<TrackSurface, Record<TrackGoing, number>> = {
  turf: { firm: 1, good: 0.99, yielding: 0.977, soft: 0.962 },
  dirt: { firm: 1, good: 1.004, yielding: 1.008, soft: 1.01 },
};

/**
 * 勝ち時計（秒）。芝の良馬場で 1600m ≒ 1:33.6、2400m ≒ 2:23.7 くらいになるよう、
 * 距離が延びるほど平均速度が落ちる直線で近似する
 * @param jitter -1..1 のゆらぎ（レースごとに ±0.6% ほど時計を変える）
 */
export const winningTimeSeconds = (
  meters: number,
  surface: TrackSurface,
  going: TrackGoing,
  jitter = 0
): number => {
  const turfSpeed = 17.9 - 0.5 * (meters / 1000);
  const surfaceSpeed = surface === "dirt" ? turfSpeed * 0.965 : turfSpeed;
  const speed = surfaceSpeed * GOING_SPEED[surface][going] * (1 + 0.006 * jitter);
  return meters / speed;
};

/** 走破タイムの表示（例: 1:33.5、59.8） */
export const formatRaceTime = (seconds: number): string => {
  const tenths = Math.round(Math.max(0, seconds) * 10);
  const minutes = Math.floor(tenths / 600);
  const rest = (tenths - minutes * 600) / 10;
  if (minutes === 0) return rest.toFixed(1);
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
};

/** 中継映像の左上の時計（例: 1.05 = 1 分 05 秒） */
export const formatRaceClock = (seconds: number): string => {
  const whole = Math.floor(Math.max(0, seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}.${String(whole - minutes * 60).padStart(2, "0")}`;
};

export interface MarginLabels {
  nose: string;
  head: string;
  neck: string;
  /** 10 馬身を超える差 */
  distance: string;
}

/** 着差（馬身）の表示。ハナ・アタマ・クビ、1/2 〜 3 1/2 は 1/4 刻み、それより大きいと 1 馬身刻み */
export const marginLabel = (lengths: number, labels: MarginLabels): string => {
  if (lengths < 0.05) return labels.nose;
  if (lengths < 0.12) return labels.head;
  if (lengths < 0.25) return labels.neck;
  if (lengths > 10.5) return labels.distance;
  if (lengths >= 3.75) return String(Math.round(lengths));
  const quarters = Math.max(2, Math.round(lengths * 4));
  // 2 馬身を超えると 1/2 刻みで表す
  const rounded = lengths > 2.25 ? Math.round(lengths * 2) * 2 : quarters;
  const whole = Math.floor(rounded / 4);
  const fraction = ["", "1/4", "1/2", "3/4"][rounded % 4];
  if (whole === 0) return fraction;
  return fraction ? `${whole} ${fraction}` : String(whole);
};
