import {
  activityScore,
  clampDistance,
  computeRating,
  distanceCategory,
  formScore,
  marksFromProbabilities,
  oddsFromProbability,
  parseDistance,
  popularityRanks,
  positionAt,
  raceTarget,
  runningPositionAt,
  recentFinishes,
  runningStyleFor,
  simulateHorseRace,
  strengthFromRating,
  styleMultiplier,
  summarizeGitHubEvents,
  winnerTime,
  type RaceRecord,
} from "../src/horseRace";

// 再現性のある疑似乱数（mulberry32）
const seeded = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe("horseRace", () => {
  describe("recentFinishes / formScore", () => {
    const history: RaceRecord[] = [
      { timestamp: 3, distance: 1600, order: ["A", "B", "C"] },
      { timestamp: 2, distance: 1600, order: ["B", "C"] },
      { timestamp: 1, distance: 1200, order: ["C", "A", "B"] },
    ];

    it("新しい順に着順と頭数を返す", () => {
      expect(recentFinishes("A", history)).toEqual([
        { position: 1, fieldSize: 3 },
        { position: 2, fieldSize: 3 },
      ]);
      expect(recentFinishes("Z", history)).toEqual([]);
    });

    it("limit で件数を絞る", () => {
      expect(recentFinishes("B", history, 2)).toHaveLength(2);
    });

    it("出走歴なしは null、全勝は 1、全敗は 0", () => {
      expect(formScore([])).toBeNull();
      expect(formScore([{ position: 1, fieldSize: 5 }])).toBe(1);
      expect(formScore([{ position: 5, fieldSize: 5 }])).toBe(0);
    });

    it("直近の着順ほど重く評価する", () => {
      const improving = formScore([
        { position: 1, fieldSize: 5 },
        { position: 5, fieldSize: 5 },
      ]);
      const declining = formScore([
        { position: 5, fieldSize: 5 },
        { position: 1, fieldSize: 5 },
      ]);
      expect(improving!).toBeGreaterThan(declining!);
    });
  });

  describe("GitHub 調教データ", () => {
    const now = Date.parse("2026-10-01T00:00:00Z");
    const daysAgo = (d: number) => new Date(now - d * 86400000).toISOString();

    it("直近 14 日のイベントだけを種類別に集計する", () => {
      const activity = summarizeGitHubEvents(
        [
          { type: "PushEvent", created_at: daysAgo(1), payload: { size: 3 } },
          { type: "PushEvent", created_at: daysAgo(2), payload: {} },
          { type: "PullRequestEvent", created_at: daysAgo(3), payload: { action: "opened" } },
          { type: "PullRequestEvent", created_at: daysAgo(3), payload: { action: "closed" } },
          { type: "PullRequestReviewEvent", created_at: daysAgo(4) },
          { type: "IssuesEvent", created_at: daysAgo(5), payload: { action: "opened" } },
          { type: "PushEvent", created_at: daysAgo(30), payload: { size: 50 } },
          { type: "WatchEvent", created_at: daysAgo(1) },
        ],
        now
      );
      expect(activity).toEqual({ commits: 4, pullRequests: 1, reviews: 1, issues: 1 });
    });

    it("activityScore は 0..1 に収まり、活動が多いほど高い", () => {
      const none = activityScore({ commits: 0, pullRequests: 0, reviews: 0, issues: 0 });
      const some = activityScore({ commits: 5, pullRequests: 1, reviews: 0, issues: 0 });
      const lots = activityScore({ commits: 500, pullRequests: 50, reviews: 50, issues: 50 });
      expect(none).toBe(0);
      expect(some).toBeGreaterThan(none);
      expect(lots).toBe(1);
    });
  });

  describe("能力値", () => {
    it("データがなければ平均の 70", () => {
      expect(computeRating(null, null)).toBe(70);
    });

    it("近走と調教を合成して 40..100 に収める", () => {
      expect(computeRating(1, 1)).toBe(100);
      expect(computeRating(0, 0)).toBe(40);
      expect(computeRating(1, null)).toBe(100);
      expect(computeRating(null, 0)).toBe(40);
    });

    it("能力値 70 の強さは 1、差は小さめ", () => {
      expect(strengthFromRating(70)).toBe(1);
      expect(strengthFromRating(100)).toBeLessThan(1.15);
      expect(strengthFromRating(40)).toBeGreaterThan(0.85);
    });
  });

  describe("脚質", () => {
    it("同じ名前なら同じ脚質", () => {
      expect(runningStyleFor("ディープ")).toBe(runningStyleFor("ディープ"));
    });

    it("逃げは序盤、追込は終盤に強い", () => {
      expect(styleMultiplier("front", 0)).toBeGreaterThan(styleMultiplier("front", 1));
      expect(styleMultiplier("deep", 1)).toBeGreaterThan(styleMultiplier("deep", 0));
    });
  });

  describe("距離", () => {
    it("100m 刻みで 1000〜3600m に丸める", () => {
      expect(clampDistance(1234)).toBe(1200);
      expect(clampDistance(500)).toBe(1000);
      expect(clampDistance(5000)).toBe(3600);
    });

    it("SMILE 区分で分類する", () => {
      expect(distanceCategory(1200)).toBe("sprint");
      expect(distanceCategory(1600)).toBe("mile");
      expect(distanceCategory(2000)).toBe("intermediate");
      expect(distanceCategory(2400)).toBe("long");
      expect(distanceCategory(3000)).toBe("extended");
    });

    it("旧バージョンの距離 ID や文字列も読める", () => {
      expect(parseDistance("sprint")).toBe(1200);
      expect(parseDistance("long")).toBe(2400);
      expect(parseDistance("3000")).toBe(3000);
      expect(parseDistance(2450)).toBe(2500);
      expect(parseDistance("abc")).toBeNull();
      expect(parseDistance(null)).toBeNull();
    });

    it("長い距離ほどゴールまでの単位が大きい", () => {
      expect(raceTarget(1600)).toBe(36);
      expect(raceTarget(3200)).toBe(72);
    });
  });

  describe("simulateHorseRace", () => {
    const styles = ["front", "stalker", "closer", "deep"] as const;
    const run = (seed: number, target = 20) =>
      simulateHorseRace({
        strengths: [1, 1, 1, 1],
        styles: [...styles],
        target,
        random: seeded(seed),
      });

    it("着順はゴール時刻順で、勝ち馬が最初にゴールする", () => {
      const race = run(1);
      expect([...race.order].sort()).toEqual([0, 1, 2, 3]);
      expect(race.order[0]).toBe(race.winner);
      const times = race.order.map((i) => race.finishTimes[i]);
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      // 勝ち馬のゴール時点で、他馬はまだゴール手前
      const t = winnerTime(race);
      expect(positionAt(race, race.winner, t)).toBeCloseTo(20, 2);
      race.order.slice(1).forEach((i) => {
        expect(positionAt(race, i, t)).toBeLessThan(20);
      });
    });

    it("位置は時間とともに単調に増え、急に跳ばない（なめらか）", () => {
      const race = run(7);
      for (const samples of race.samples) {
        for (let k = 1; k < samples.length; k += 1) {
          expect(samples[k]).toBeGreaterThanOrEqual(samples[k - 1]);
        }
        // スピード（1 刻みあたりの変化）の変化量が小さい
        for (let k = 2; k < samples.length; k += 1) {
          const v1 = samples[k - 1] - samples[k - 2];
          const v2 = samples[k] - samples[k - 1];
          expect(Math.abs(v2 - v1)).toBeLessThan(0.02);
        }
      }
    });

    it("ゲートからは止まった状態で出て、加速していく", () => {
      const race = run(3);
      for (const samples of race.samples) {
        expect(samples[0]).toBe(0);
        expect(samples[1] - samples[0]).toBeLessThan(0.01);
      }
    });

    it("同じ乱数なら同じ結果", () => {
      expect(run(42, 24)).toEqual(run(42, 24));
    });

    it("馬がいなければ勝ち馬なし", () => {
      const race = simulateHorseRace({ strengths: [], styles: [], target: 10 });
      expect(race.winner).toBe(-1);
      expect(race.order).toEqual([]);
    });

    it("能力値が高い馬は勝ちやすいが、低い馬も勝てる", () => {
      const random = seeded(99);
      const strengths = [strengthFromRating(100), 1, 1, strengthFromRating(40)];
      const wins = [0, 0, 0, 0];
      for (let t = 0; t < 2000; t += 1) {
        const race = simulateHorseRace({
          strengths,
          styles: ["stalker", "stalker", "stalker", "stalker"],
          target: 36,
          random,
        });
        wins[race.winner] += 1;
      }
      expect(wins[0]).toBeGreaterThan(wins[1]);
      expect(wins[3]).toBeLessThan(wins[2]);
      expect(wins[3]).toBeGreaterThan(0);
    });

    it("脚質による有利不利はほぼない", () => {
      const random = seeded(5);
      const wins: Record<string, number> = { front: 0, stalker: 0, closer: 0, deep: 0 };
      const trials = 3000;
      for (let t = 0; t < trials; t += 1) {
        const race = simulateHorseRace({
          strengths: [1, 1, 1, 1],
          styles: [...styles],
          target: 36,
          random,
        });
        wins[styles[race.winner]] += 1;
      }
      for (const style of styles) {
        expect(wins[style] / trials).toBeGreaterThan(0.17);
        expect(wins[style] / trials).toBeLessThan(0.33);
      }
    });
  });

  describe("positionAt", () => {
    const race = simulateHorseRace({
      strengths: [1, 1, 1],
      styles: ["stalker", "stalker", "stalker"],
      target: 10,
      random: seeded(3),
    });

    it("サンプル点を通り、間はなめらかにつなぐ", () => {
      const k = 12;
      const [a, b] = [race.samples[0][k], race.samples[0][k + 1]];
      expect(positionAt(race, 0, k * race.dt)).toBeCloseTo(a, 10);
      const mid = positionAt(race, 0, (k + 0.5) * race.dt);
      expect(mid).toBeGreaterThanOrEqual(a);
      expect(mid).toBeLessThanOrEqual(b);
    });

    it("刻みの継ぎ目でもスピードが段にならない", () => {
      const eps = 1e-4;
      for (const k of [10, 20, 30]) {
        const t = k * race.dt;
        const before = (positionAt(race, 1, t) - positionAt(race, 1, t - eps)) / eps;
        const after = (positionAt(race, 1, t + eps) - positionAt(race, 1, t)) / eps;
        expect(Math.abs(after - before)).toBeLessThan(0.01);
      }
    });

    it("記録の終わり以降も止まらずに進む", () => {
      const end = race.samples[0].length * race.dt;
      expect(positionAt(race, 0, end + 5)).toBeGreaterThan(positionAt(race, 0, end));
    });
  });

  describe("runningPositionAt", () => {
    const target = 30;
    const race = simulateHorseRace({
      strengths: [1, 1, 1, 1, 1, 1],
      styles: ["front", "stalker", "closer", "deep", "stalker", "closer"],
      target,
      random: seeded(11),
    });

    it("勝ち馬のゴール時刻と着順は positionAt と同じ", () => {
      const first = winnerTime(race);
      expect(runningPositionAt(race, race.winner, first)).toBeCloseTo(target, 3);
      race.order.slice(1).forEach((i) => {
        expect(runningPositionAt(race, i, first)).toBeLessThan(target);
      });
      // 描画上のゴール順
      const crossing = race.order.map((i) => {
        let t = 0;
        while (runningPositionAt(race, i, t) < target) t += 0.01;
        return t;
      });
      expect([...crossing].sort((a, b) => a - b)).toEqual(crossing);
    });

    it("スタート後は止まらずに一定以上のスピードで進む", () => {
      const dt = 0.05;
      const pace = target / winnerTime(race);
      race.order.forEach((i) => {
        for (let t = 2; t < race.finishTimes[i]; t += dt) {
          const speed = (runningPositionAt(race, i, t + dt) - runningPositionAt(race, i, t)) / dt;
          expect(speed).toBeGreaterThan(pace * 0.3);
        }
      });
    });

    it("発走時はゲート位置から動き出す", () => {
      expect(runningPositionAt(race, 0, 0)).toBe(0);
    });
  });

  describe("オッズ・印・人気", () => {
    it("控除率 20%、最低 1.1 倍", () => {
      expect(oddsFromProbability(0.5)).toBe(1.6);
      expect(oddsFromProbability(0.1)).toBe(8);
      expect(oddsFromProbability(0.99)).toBe(1.1);
    });

    it("勝率の高い順に ◎○▲△△ を付ける（最下位には付けない）", () => {
      expect(marksFromProbabilities([0.1, 0.4, 0.2, 0.3])).toEqual(["", "◎", "▲", "○"]);
    });

    it("人気順を返す", () => {
      expect(popularityRanks([0.1, 0.4, 0.2, 0.3])).toEqual([4, 1, 3, 2]);
    });
  });
});
