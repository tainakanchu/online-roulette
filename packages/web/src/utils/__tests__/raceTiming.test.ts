import {
  displayPositionAt,
  raceTarget,
  simulateHorseRace,
  strengthFromRating,
  winnerTime,
  type RunningStyle,
} from "@tainakanchu/roulette-core";
import { CAMERA_PLANS, CAMERA_PLAN_REFERENCE_METERS, shotForDistance, shotForFraction } from "../raceCamera";
import { winningTimeSeconds } from "../raceResult";
import {
  isSlowMotion,
  MAX_POST_FINISH_SECONDS,
  planReplay,
  POST_FINISH_FAST_FORWARD,
  recordingBitsPerSecond,
  REPLAY_MAX_SPEEDUP,
  REPLAY_NORMAL_METERS,
  REPLAY_SLOW_AFTER_METERS,
  REPLAY_SLOW_BEFORE_METERS,
  SLOW_MOTION_REMAINING_METERS,
  SLOW_MOTION_SCALE,
  targetTimeScale,
} from "../raceTiming";

// 再現性のある疑似乱数（mulberry32）
const seeded = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const STYLES: RunningStyle[] = ["front", "stalker", "closer", "deep"];

/** 実際の走破タイムで再生したときの、レース内部時刻 1 あたりの実時間（RaceScene と同じ換算） */
const secondsPerUnit = (race: ReturnType<typeof simulateHorseRace>, meters: number) =>
  winningTimeSeconds(meters, "dirt", "soft") / winnerTime(race);

describe("接戦のスローモーション", () => {
  it("ゴールまでの残りが一定の距離を切ってから、1・2 着が接戦のときだけ", () => {
    const base = { winnerCrossed: false, gapTop2: 0.1, closeGap: 0.3 };
    expect(isSlowMotion({ ...base, remainingMeters: SLOW_MOTION_REMAINING_METERS + 1 })).toBe(false);
    expect(isSlowMotion({ ...base, remainingMeters: SLOW_MOTION_REMAINING_METERS - 1 })).toBe(true);
    expect(isSlowMotion({ ...base, remainingMeters: 10, gapTop2: 0.5 })).toBe(false);
    expect(isSlowMotion({ ...base, remainingMeters: 10, winnerCrossed: true })).toBe(false);
  });

  it("距離が長くても、スローは実時間で十数秒以内に収まる（割合で決めると 3200m で 40 秒になっていた）", () => {
    for (const meters of [1200, 2400, 3200, 3600]) {
      // 勝ち馬の平均の速さで、スローの区間を走りきるのにかかる実時間
      const speed = meters / winningTimeSeconds(meters, "dirt", "soft");
      const slowSeconds = SLOW_MOTION_REMAINING_METERS / speed / SLOW_MOTION_SCALE;
      expect(slowSeconds).toBeLessThan(15);
    }
  });
});

describe("ゴール後の確定", () => {
  it("着順掲示板を映している間だけ、まだ走っている後続を早送りする", () => {
    expect(targetTimeScale({ slowMotion: false, showingBoard: true, allFinished: false })).toBe(
      POST_FINISH_FAST_FORWARD
    );
    expect(targetTimeScale({ slowMotion: false, showingBoard: true, allFinished: true })).toBe(1);
    expect(targetTimeScale({ slowMotion: false, showingBoard: false, allFinished: false })).toBe(1);
    expect(targetTimeScale({ slowMotion: true, showingBoard: false, allFinished: false })).toBe(SLOW_MOTION_SCALE);
  });

  it("18 頭立て 3200m でも、早送りすれば上限の時間までに全馬がゴールする（後ろの馬が走っているうちに確定しない）", () => {
    const random = seeded(11);
    const meters = 3200;
    const n = 18;
    const target = raceTarget(meters);
    let worst = 0;
    for (let k = 0; k < 60; k += 1) {
      const race = simulateHorseRace({
        strengths: Array.from({ length: n }, (_, i) => strengthFromRating(40 + (60 * i) / (n - 1))),
        styles: Array.from({ length: n }, (_, i) => STYLES[i % STYLES.length]),
        target,
        random,
      });
      // 画面に描く位置で、しんがりがゴール線を越える時刻
      const first = winnerTime(race);
      let t = first;
      const unfinished = () => Array.from({ length: n }, (_, i) => displayPositionAt(race, i, t)).some((p) => p < target);
      while (unfinished() && t < first * 3) t += 0.05;
      worst = Math.max(worst, (t - first) * secondsPerUnit(race, meters));
    }
    // 勝ち馬のゴール後、掲示板に切り替わるまで（ゴールの瞬間のカットと上位 5 頭の入線、約 8 秒）は等速、その後は早送り
    const beforeBoard = 8;
    const realSeconds = beforeBoard + Math.max(0, worst - beforeBoard) / POST_FINISH_FAST_FORWARD;
    expect(realSeconds).toBeLessThan(MAX_POST_FINISH_SECONDS);
  });
});

describe("ニュースの VTR", () => {
  it("決まった秒数に収まり、等速の部分も実際の速さの数倍までにとどめる（速すぎるとカメラが追いつけない）", () => {
    for (const meters of [1000, 1600, 3200, 3600]) {
      const race = simulateHorseRace({
        strengths: [1, 1, 1, 1, 1, 1],
        styles: [...STYLES, ...STYLES].slice(0, 6),
        target: raceTarget(meters),
        random: seeded(meters),
      });
      const finish = winnerTime(race);
      const metersPerTime = meters / finish;
      const realRate = 1 / secondsPerUnit(race, meters);
      for (const normalSeconds of [4, 6, 20]) {
        const slowSeconds = 5.3;
        const plan = planReplay({ finishTime: finish, metersPerTime, normalSeconds, slowSeconds, realRate });
        // 等速の部分とスローの部分が、それぞれ決めた秒数で終わる
        expect((plan.slowFrom - plan.from) / plan.normalRate).toBeCloseTo(normalSeconds, 5);
        expect(
          ((REPLAY_SLOW_BEFORE_METERS + REPLAY_SLOW_AFTER_METERS) / metersPerTime) / plan.slowRate
        ).toBeCloseTo(slowSeconds, 5);
        // 等速の部分は実際の速さの REPLAY_MAX_SPEEDUP 倍まで、スローは実際より遅い
        expect(plan.normalRate).toBeLessThanOrEqual(realRate * REPLAY_MAX_SPEEDUP + 1e-9);
        expect(plan.slowRate).toBeLessThan(realRate);
        // 映す範囲は最長でも最後の直線の長さまで。4 秒あれば 100m 以上は映る
        const shownMeters = (plan.slowFrom - plan.from) * metersPerTime;
        expect(shownMeters).toBeLessThanOrEqual(REPLAY_NORMAL_METERS + 1e-6);
        expect(shownMeters).toBeGreaterThan(100);
      }
    }
  });
});

describe("距離で決めるカット割り", () => {
  it("基準の距離以下は、進み具合の割合で決める（従来どおり）", () => {
    for (const plan of CAMERA_PLANS) {
      for (const meters of [500, CAMERA_PLAN_REFERENCE_METERS]) {
        for (let run = 0; run < meters; run += 37) {
          expect(shotForDistance(plan, run, meters)).toBe(shotForFraction(plan, run / meters));
        }
      }
    }
  });

  it("長いレースでも、1 カットが基準の距離の 1 カットより長く続かない", () => {
    for (const plan of CAMERA_PLANS) {
      const longest = Math.max(
        ...plan.cuts.map(([until], i) => (until - (i > 0 ? plan.cuts[i - 1][0] : 0)) * CAMERA_PLAN_REFERENCE_METERS)
      );
      for (const meters of [1000, 1600, 2400, 3200, 3600]) {
        let current = shotForDistance(plan, 0, meters);
        let since = 0;
        for (let run = 1; run <= meters; run += 1) {
          const shot = shotForDistance(plan, run, meters);
          if (shot !== current) {
            current = shot;
            since = run;
          }
          // 同じカットが続く（同名のカットが連続する場合はつながって見えるので 2 カット分まで許す）
          expect(run - since).toBeLessThanOrEqual(longest * 2 + 1);
        }
      }
    }
  });

  it("長いレースでも、始まりとゴール前のカットは基準の距離のときと同じ", () => {
    for (const plan of CAMERA_PLANS) {
      const last = plan.cuts[plan.cuts.length - 1][1];
      expect(shotForDistance(plan, 0, 3200)).toBe(plan.cuts[0][1]);
      expect(shotForDistance(plan, 3199, 3200)).toBe(last);
      expect(shotForDistance(plan, 3199, 3200)).toBe(shotForFraction(plan, 799 / 800));
    }
  });
});

describe("録画のビットレート", () => {
  it("短いレースは上限の 8Mbps、長いレースはファイルの大きさが約 90MB に収まるよう下げる", () => {
    expect(recordingBitsPerSecond(60)).toBe(8_000_000);
    const long = recordingBitsPerSecond(300);
    expect(long).toBeLessThan(8_000_000);
    expect((long * 300) / 8 / 1024 / 1024).toBeLessThanOrEqual(90.01);
  });

  it("画質が落ちすぎないよう、下限より下げない", () => {
    expect(recordingBitsPerSecond(100_000)).toBe(2_500_000);
  });
});
