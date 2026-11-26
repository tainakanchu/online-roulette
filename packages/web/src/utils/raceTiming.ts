// レースを実際の走破タイムで再生するときの、時間に関わる決まり。
// 割合（先頭の進み具合 0..1）で決めると、長い距離ほど同じ演出が何倍も長く続いてしまうので、
// ゴールまでの残り距離（m）と実時間（秒）で決める。three.js に依存しないので、ここでテストする。

/** 接戦のときにスローモーションにする、先頭からゴールまでの残り（m） */
export const SLOW_MOTION_REMAINING_METERS = 60;

/** スローモーションの再生速度 */
export const SLOW_MOTION_SCALE = 0.35;

/** 着順掲示板を映している間、まだゴールしていない後続の馬を早送りする倍率（画面には映らない） */
export const POST_FINISH_FAST_FORWARD = 8;

/** 勝ち馬のゴールから、何があっても確定させるまでの時間（実時間の秒。念のための上限） */
export const MAX_POST_FINISH_SECONDS = 30;

/** ニュースの VTR: 等速で見せる、スローの手前までの距離の上限（m）。最後の直線の長さくらい */
export const REPLAY_NORMAL_METERS = 400;
/** ニュースの VTR: 等速の部分を、実際の何倍の速さまで速めてよいか（これより速いとカメラが追いつけず、早回しに見える） */
export const REPLAY_MAX_SPEEDUP = 2.5;
/** ニュースの VTR: スローで見せる、ゴールの手前と先の距離（m）。手前は、ゴール線の真横のカメラに馬が入り始める所から */
export const REPLAY_SLOW_BEFORE_METERS = 6;
export const REPLAY_SLOW_AFTER_METERS = 20;

/** 接戦のスローモーションにするか */
export const isSlowMotion = (params: {
  winnerCrossed: boolean;
  remainingMeters: number;
  gapTop2: number;
  closeGap: number;
}): boolean =>
  !params.winnerCrossed &&
  params.remainingMeters < SLOW_MOTION_REMAINING_METERS &&
  params.gapTop2 < params.closeGap;

/**
 * 再生速度の目標。接戦ならスロー、ゴール後に着順掲示板を映している間は後続の馬を早送りする
 */
export const targetTimeScale = (params: {
  slowMotion: boolean;
  showingBoard: boolean;
  allFinished: boolean;
}): number => {
  if (params.slowMotion) return SLOW_MOTION_SCALE;
  if (params.showingBoard && !params.allFinished) return POST_FINISH_FAST_FORWARD;
  return 1;
};

export interface ReplayPlan {
  /** 再生を始めるレース内部時刻 */
  from: number;
  /** スローに切り替えるレース内部時刻 */
  slowFrom: number;
  /** 等速の部分で、実時間 1 秒あたりに進めるレース内部時刻 */
  normalRate: number;
  /** スローの部分で、実時間 1 秒あたりに進めるレース内部時刻 */
  slowRate: number;
}

/**
 * ニュースの VTR の再生範囲と速さ。全体が決まった秒数に収まるよう、等速の部分は実際の最大 REPLAY_MAX_SPEEDUP 倍で流し、
 * その速さで流せる分だけ（最長 REPLAY_NORMAL_METERS）ゴール前を映す。距離が変わっても、映る範囲はゴール前の同じ長さになる
 * @param finishTime 勝ち馬がゴールしたレース内部時刻
 * @param metersPerTime レース内部時刻 1 あたりに勝ち馬が進む距離（m）
 * @param normalSeconds 等速の部分にかける実時間（秒）
 * @param slowSeconds スローの部分にかける実時間（秒）
 * @param realRate 実際の速さで再生するときの、実時間 1 秒あたりのレース内部時刻
 */
export const planReplay = (params: {
  finishTime: number;
  metersPerTime: number;
  normalSeconds: number;
  slowSeconds: number;
  realRate: number;
}): ReplayPlan => {
  const perMeter = 1 / Math.max(1e-6, params.metersPerTime);
  const slowFrom = Math.max(0, params.finishTime - REPLAY_SLOW_BEFORE_METERS * perMeter);
  const span = Math.min(
    REPLAY_NORMAL_METERS * perMeter,
    Math.max(0.1, params.normalSeconds) * REPLAY_MAX_SPEEDUP * params.realRate
  );
  const from = Math.max(0, slowFrom - span);
  return {
    from,
    slowFrom,
    normalRate: (slowFrom - from) / Math.max(0.1, params.normalSeconds),
    slowRate: ((REPLAY_SLOW_BEFORE_METERS + REPLAY_SLOW_AFTER_METERS) * perMeter) / Math.max(0.1, params.slowSeconds),
  };
};

/**
 * 録画のビットレート。長いレースでも、ファイルの大きさがおおよそ maxBytes に収まるように下げる
 * （チャンクをメモリにためるので、大きすぎるとスマホのブラウザが落ちる）
 */
export const recordingBitsPerSecond = (
  expectedSeconds: number,
  maxBitsPerSecond = 8_000_000,
  maxBytes = 90 * 1024 * 1024,
  minBitsPerSecond = 2_500_000
): number => {
  const budget = (maxBytes * 8) / Math.max(1, expectedSeconds);
  return Math.round(Math.max(minBitsPerSecond, Math.min(maxBitsPerSecond, budget)));
};
