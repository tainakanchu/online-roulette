// レース中のカメラワーク（カット割り）の型。レースの進み具合（先頭の馬の 0..1）で、どのカットを映すかを決める。
// 同じ並びばかりだと見飽きるので、いくつかの型を用意し、レースごとに前回とは違う型を選ぶ。
// どの型にも、馬上の騎手の目線（ジョッキー視点）のカットを必ず入れる。

/** レース中のカット（RaceScene の撮り方と同じ名前） */
export type RaceShotName = "chase" | "side" | "jockey" | "aerial" | "rail" | "headon" | "stretch";

export interface CameraPlan {
  id: "cinema" | "broadcast" | "rider" | "drone";
  /** [このカットを映す最後の進み具合, カット]。進み具合の小さい順で、最後は 1 */
  cuts: Array<[until: number, shot: RaceShotName]>;
}

export const CAMERA_PLANS: CameraPlan[] = [
  // 映画風: 正面の地面すれすれ → 望遠の横移動 → ジョッキー視点 → ドローン → 内ラチ沿い → 超望遠の正面 → 真横のドリー
  {
    id: "cinema",
    cuts: [
      [0.12, "chase"],
      [0.26, "side"],
      [0.38, "jockey"],
      [0.5, "aerial"],
      [0.62, "rail"],
      [0.78, "headon"],
      [1, "stretch"],
    ],
  },
  // TV 中継風: スタンドからの望遠の横移動で長く追い、途中で一度だけ騎手の目線をはさみ、向こう正面をドローンで俯瞰し、直線は正面から
  {
    id: "broadcast",
    cuts: [
      [0.1, "chase"],
      [0.35, "side"],
      [0.45, "jockey"],
      [0.6, "aerial"],
      [0.8, "side"],
      [0.9, "headon"],
      [1, "stretch"],
    ],
  },
  // ジョッキー目線多め: 馬上の目線を何度もはさみ、内ラチ沿いの低いカメラで速さを見せる
  {
    id: "rider",
    cuts: [
      [0.08, "chase"],
      [0.3, "jockey"],
      [0.42, "rail"],
      [0.62, "jockey"],
      [0.8, "headon"],
      [0.9, "jockey"],
      [1, "stretch"],
    ],
  },
  // ドローン多め: スタートから空撮で馬群を追い、要所で横・騎手の目線・内ラチに降りる
  {
    id: "drone",
    cuts: [
      [0.12, "aerial"],
      [0.3, "side"],
      [0.42, "jockey"],
      [0.55, "aerial"],
      [0.7, "rail"],
      [0.85, "headon"],
      [1, "stretch"],
    ],
  },
];

/** 進み具合 fraction（0..1）で映すカット */
export const shotForFraction = (plan: CameraPlan, fraction: number): RaceShotName =>
  plan.cuts.find(([until]) => fraction < until)?.[1] ?? plan.cuts[plan.cuts.length - 1][1];

/**
 * 次のレースのカメラワークの型を選ぶ。前回と同じ型は選ばない
 * @param random 0 以上 1 未満の乱数（テストでは固定値を渡す）
 */
export const pickCameraPlan = (previous: CameraPlan["id"] | null, random: () => number = Math.random): CameraPlan => {
  const choices = CAMERA_PLANS.filter((plan) => plan.id !== previous);
  return choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))];
};

/**
 * カット割りの基準の距離（m）。この距離のレースを型の進み具合どおりに割ると、実際の速さ（約 16m/s）で
 * 1 カットが 5〜10 秒になる。これより長いレースは、中ほどのカットを繰り返して 1 カットの長さを保つ
 */
export const CAMERA_PLAN_REFERENCE_METERS = 800;
/** 最後のこの数のカットは、ゴールまでの残り距離で切り替える（直線の見せ方は距離によらず同じにする） */
const TAIL_CUTS = 2;

/**
 * 先頭が走った距離で映すカット。基準より長いレースでも 1 カットが長くなりすぎないよう、
 * 最初のカットはスタートから、最後の 2 カットはゴールまでの残りで決め、その間は中ほどのカットを繰り返す。
 * 基準以下の距離は、進み具合の割合で決める
 * @param runMeters 先頭が走った距離（m）
 * @param distanceMeters レースの距離（m）
 */
export const shotForDistance = (plan: CameraPlan, runMeters: number, distanceMeters: number): RaceShotName => {
  if (distanceMeters <= CAMERA_PLAN_REFERENCE_METERS) {
    return shotForFraction(plan, runMeters / Math.max(1, distanceMeters));
  }
  const cuts = plan.cuts;
  const lengths = cuts.map(([until], i) => (until - (i > 0 ? cuts[i - 1][0] : 0)) * CAMERA_PLAN_REFERENCE_METERS);
  if (runMeters < lengths[0]) return cuts[0][1];
  // ゴール前の数カット（残り距離で決める）
  const remaining = distanceMeters - runMeters;
  const tailStart = cuts.length - TAIL_CUTS;
  let left = lengths.slice(tailStart).reduce((a, b) => a + b, 0);
  if (remaining < left) {
    for (let j = tailStart; j < cuts.length; j += 1) {
      // left は、カット j が始まる地点のゴールまでの残り
      left -= lengths[j];
      if (remaining >= left) return cuts[j][1];
    }
    return cuts[cuts.length - 1][1];
  }
  // 中ほどのカットを、決まった長さで繰り返す
  const middle = cuts.slice(1, cuts.length - TAIL_CUTS);
  const middleLengths = lengths.slice(1, cuts.length - TAIL_CUTS);
  const cycle = middleLengths.reduce((a, b) => a + b, 0);
  let pos = (runMeters - lengths[0]) % cycle;
  for (let i = 0; i < middle.length; i += 1) {
    if (pos < middleLengths[i]) return middle[i][1];
    pos -= middleLengths[i];
  }
  return middle[middle.length - 1][1];
};
