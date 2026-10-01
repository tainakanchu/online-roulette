import {
  activityScore,
  buildPickTracks,
  computeRating,
  formScore,
  marksFromProbabilities,
  oddsFromProbability,
  popularityRanks,
  progressAt,
  recentFinishes,
  runningStyleFor,
  simulateHorseRace,
  strengthFromRating,
  styleMultiplier,
  summarizeGitHubEvents,
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
      { timestamp: 3, distance: "mile", order: ["A", "B", "C"] },
      { timestamp: 2, distance: "mile", order: ["B", "C"] },
      { timestamp: 1, distance: "sprint", order: ["C", "A", "B"] },
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

  describe("simulateHorseRace", () => {
    const styles = ["front", "stalker", "closer", "deep"] as const;

    it("勝ち馬はちょうど target 歩でゴールし、他は target 未満", () => {
      const race = simulateHorseRace({
        strengths: [1, 1, 1, 1],
        styles: [...styles],
        target: 20,
        random: seeded(1),
      });
      expect(race.finalProgress[race.winner]).toBe(20);
      race.finalProgress.forEach((p, i) => {
        if (i !== race.winner) expect(p).toBeLessThan(20);
      });
      expect(race.picks[race.picks.length - 1]).toBe(race.winner);
      expect(race.picks).toHaveLength(race.finalProgress.reduce((a, b) => a + b, 0));
    });

    it("着順は全馬を 1 回ずつ含み、歩数の降順", () => {
      const race = simulateHorseRace({
        strengths: [1, 1, 1, 1],
        styles: [...styles],
        target: 15,
        random: seeded(7),
      });
      expect([...race.order].sort()).toEqual([0, 1, 2, 3]);
      expect(race.order[0]).toBe(race.winner);
      for (let i = 1; i < race.order.length - 1; i += 1) {
        expect(race.finalProgress[race.order[i]]).toBeGreaterThanOrEqual(
          race.finalProgress[race.order[i + 1]]
        );
      }
    });

    it("同じ乱数なら同じ結果", () => {
      const run = () =>
        simulateHorseRace({
          strengths: [1, 1.05, 0.95],
          styles: ["front", "closer", "deep"],
          target: 24,
          random: seeded(42),
        });
      expect(run()).toEqual(run());
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
      for (let t = 0; t < 3000; t += 1) {
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

  describe("progressAt", () => {
    const race = simulateHorseRace({
      strengths: [1, 1, 1],
      styles: ["stalker", "stalker", "stalker"],
      target: 10,
      random: seeded(3),
    });
    const tracks = buildPickTracks(race, 3);
    const total = race.picks.length;

    it("最後の抽選時点で勝ち馬はちょうど target", () => {
      expect(progressAt(tracks[race.winner], total, total)).toBeCloseTo(10);
    });

    it("時間とともに単調増加する", () => {
      for (const track of tracks) {
        let prev = -1;
        for (let x = 0; x <= total + 5; x += 0.25) {
          const p = progressAt(track, x, total);
          expect(p).toBeGreaterThanOrEqual(prev);
          prev = p;
        }
      }
    });

    it("前進回数と整合する", () => {
      tracks.forEach((track, horse) => {
        expect(Math.floor(progressAt(track, total, total) + 1e-9)).toBe(
          race.finalProgress[horse]
        );
      });
    });
  });
});
