import { cryptoRandom } from "./roulette";

// ===== 競馬モードのロジック =====
// 抽選で当たった馬が 1 歩進み、最初に target 歩に到達した馬が勝ち。
// 能力値（近走成績 + GitHub の調教データ）で当たりやすさを「少しだけ」重みづけする。

export type RaceDistanceId = "sprint" | "mile" | "long";

export interface RaceDistance {
  id: RaceDistanceId;
  meters: number;
  /** ゴールまでに必要な歩数（大きいほど実力が結果に出やすい） */
  target: number;
}

export const RACE_DISTANCES: Record<RaceDistanceId, RaceDistance> = {
  sprint: { id: "sprint", meters: 1200, target: 24 },
  mile: { id: "mile", meters: 1600, target: 36 },
  long: { id: "long", meters: 2400, target: 54 },
};

export const isRaceDistanceId = (value: unknown): value is RaceDistanceId =>
  value === "sprint" || value === "mile" || value === "long";

export const MAX_HORSES = 18;

/** 脚質: 逃げ / 先行 / 差し / 追込 */
export type RunningStyle = "front" | "stalker" | "closer" | "deep";

export interface RaceRecord {
  timestamp: number;
  distance: RaceDistanceId;
  /** 着順（1着から順に馬名） */
  order: string[];
}

export interface Finish {
  position: number;
  fieldSize: number;
}

export interface GitHubActivity {
  commits: number;
  pullRequests: number;
  reviews: number;
  issues: number;
}

// ----- 近走成績 -----

/** 履歴（新しい順）から指定馬の近走着順を取り出す */
export const recentFinishes = (
  name: string,
  history: RaceRecord[],
  limit = 5
): Finish[] => {
  const finishes: Finish[] = [];
  for (const record of history) {
    const idx = record.order.indexOf(name);
    if (idx < 0) continue;
    finishes.push({ position: idx + 1, fieldSize: record.order.length });
    if (finishes.length >= limit) break;
  }
  return finishes;
};

const RECENCY_WEIGHTS = [1, 0.8, 0.6, 0.45, 0.35];

/** 近走の着順を 0..1 に正規化（1 = 毎回 1 着）。出走歴がなければ null */
export const formScore = (finishes: Finish[]): number | null => {
  if (finishes.length === 0) return null;
  let sum = 0;
  let weightSum = 0;
  finishes.forEach((finish, i) => {
    const weight = RECENCY_WEIGHTS[i] ?? RECENCY_WEIGHTS[RECENCY_WEIGHTS.length - 1];
    const score =
      finish.fieldSize <= 1
        ? 1
        : 1 - (finish.position - 1) / (finish.fieldSize - 1);
    sum += score * weight;
    weightSum += weight;
  });
  return sum / weightSum;
};

// ----- GitHub 調教データ -----

/** 調教ポイント（PR は重め、コミットは軽め） */
export const activityPoints = (activity: GitHubActivity): number =>
  activity.commits +
  activity.pullRequests * 4 +
  activity.reviews * 2 +
  activity.issues;

const ACTIVITY_SATURATION_POINTS = 80;

/** 調教ポイントを 0..1 に正規化（対数スケール、80pt で頭打ち） */
export const activityScore = (activity: GitHubActivity): number => {
  const points = Math.max(0, activityPoints(activity));
  return Math.min(1, Math.log1p(points) / Math.log1p(ACTIVITY_SATURATION_POINTS));
};

interface GitHubEventLike {
  type?: string;
  created_at?: string;
  payload?: {
    action?: string;
    size?: number;
    distinct_size?: number;
    commits?: unknown[];
    pull_request?: { merged?: boolean };
  };
}

/** GitHub の public events から直近 days 日分の活動量を集計する */
export const summarizeGitHubEvents = (
  events: GitHubEventLike[],
  now: number,
  days = 14
): GitHubActivity => {
  const since = now - days * 24 * 60 * 60 * 1000;
  const activity: GitHubActivity = {
    commits: 0,
    pullRequests: 0,
    reviews: 0,
    issues: 0,
  };
  for (const event of events) {
    const created = event.created_at ? Date.parse(event.created_at) : NaN;
    if (Number.isNaN(created) || created < since) continue;
    const payload = event.payload ?? {};
    switch (event.type) {
      case "PushEvent":
        activity.commits += Math.max(
          1,
          payload.distinct_size ?? payload.size ?? payload.commits?.length ?? 1
        );
        break;
      case "PullRequestEvent":
        if (payload.action === "opened") activity.pullRequests += 1;
        break;
      case "PullRequestReviewEvent":
        activity.reviews += 1;
        break;
      case "IssuesEvent":
        if (payload.action === "opened") activity.issues += 1;
        break;
      default:
        break;
    }
  }
  return activity;
};

// ----- 能力値 -----

/**
 * 近走成績と調教データから能力値（40..100）を出す。
 * どちらも無ければ平均値の 70。
 */
export const computeRating = (
  form: number | null,
  activity: number | null
): number => {
  let combined: number;
  if (form !== null && activity !== null) {
    combined = form * 0.6 + activity * 0.4;
  } else if (form !== null) {
    combined = form;
  } else if (activity !== null) {
    combined = activity;
  } else {
    combined = 0.5;
  }
  return Math.round(40 + 60 * combined);
};

/**
 * 能力値 → 当たりやすさ。
 * 「少し効かせる」ために ±8% 程度の差にとどめる。
 */
export const STRENGTH_SPREAD = 0.08;
export const strengthFromRating = (rating: number): number =>
  1 + (STRENGTH_SPREAD * (rating - 70)) / 30;

// ----- 脚質 -----

const hashString = (value: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const STYLES: RunningStyle[] = ["front", "stalker", "closer", "deep"];

/** 馬名から脚質を決める（同じ名前ならいつも同じ脚質） */
export const runningStyleFor = (name: string): RunningStyle =>
  STYLES[hashString(name) % STYLES.length];

/** 馬名から決まる見た目用の値（毛色など） */
export const nameHash = hashString;

const STYLE_SLOPES: Record<RunningStyle, number> = {
  front: -0.6,
  stalker: -0.24,
  closer: 0.24,
  deep: 0.6,
};
/**
 * 勝ち負けは終盤の伸びで決まりやすいので、倍率が 1 になる点を中盤やや後ろに置くと
 * どの脚質もほぼ同じ勝率になる（シミュレーションで調整済み）。
 */
const STYLE_PIVOT = 0.55;

/**
 * レース展開（phase: 0=スタート, 1=ゴール）に応じた脚質ごとの倍率。
 * 逃げは序盤に飛ばして失速、追込は終盤に伸びる。勝率はほぼ同じで展開の妙だけが生まれる。
 */
export const styleMultiplier = (style: RunningStyle, phase: number): number => {
  const p = Math.min(1, Math.max(0, phase));
  return 1 + STYLE_SLOPES[style] * (p - STYLE_PIVOT);
};

// ----- レース本体 -----

export interface RaceSimulationInput {
  strengths: number[];
  styles: RunningStyle[];
  target: number;
  random?: () => number;
}

export interface RaceSimulation {
  /** 抽選で前進した馬の index の列（最後の要素が勝ち馬） */
  picks: number[];
  winner: number;
  /** 着順（馬 index） */
  order: number[];
  /** 勝ち馬ゴール時点の各馬の歩数 */
  finalProgress: number[];
  target: number;
}

const pickWeighted = (weights: number[], random: () => number): number => {
  let total = 0;
  for (const w of weights) total += w;
  let r = random() * total;
  for (let i = 0; i < weights.length; i += 1) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1;
};

export const simulateHorseRace = ({
  strengths,
  styles,
  target,
  random = cryptoRandom,
}: RaceSimulationInput): RaceSimulation => {
  const n = strengths.length;
  const progress = new Array<number>(n).fill(0);
  const picks: number[] = [];
  if (n === 0 || target <= 0) {
    return { picks, winner: -1, order: [], finalProgress: progress, target };
  }

  let leader = 0;
  let winner = -1;
  const weights = new Array<number>(n);
  // 安全弁（理論上 n * target 回以内に必ず決着する）
  const maxDraws = n * target;
  for (let draw = 0; draw < maxDraws; draw += 1) {
    const phase = leader / target;
    for (let i = 0; i < n; i += 1) {
      weights[i] = strengths[i] * styleMultiplier(styles[i] ?? "stalker", phase);
    }
    const pick = pickWeighted(weights, random);
    progress[pick] += 1;
    picks.push(pick);
    if (progress[pick] > leader) leader = progress[pick];
    if (progress[pick] >= target) {
      winner = pick;
      break;
    }
  }

  // 2 着以下は勝ち馬ゴール時点の位置（描画と同じ progressAt）順
  const tracks = buildPickTracks({ picks }, n);
  const at = progress.map((_, i) => progressAt(tracks[i], picks.length, picks.length));
  const order = progress
    .map((_, i) => i)
    .filter((i) => i !== winner)
    .sort((a, b) => at[b] - at[a] || a - b);

  return {
    picks,
    winner,
    order: [winner, ...order],
    finalProgress: progress,
    target,
  };
};

/** モンテカルロで各馬の勝率を見積もる（オッズ・印に使う） */
export const estimateWinProbabilities = (
  strengths: number[],
  styles: RunningStyle[],
  target: number,
  trials = 1500,
  random: () => number = Math.random
): number[] => {
  const n = strengths.length;
  if (n === 0) return [];
  const wins = new Array<number>(n).fill(0.5); // 0 勝でもオッズが無限にならないよう補正
  for (let t = 0; t < trials; t += 1) {
    const { winner } = simulateHorseRace({ strengths, styles, target, random });
    if (winner >= 0) wins[winner] += 1;
  }
  const total = wins.reduce((a, b) => a + b, 0);
  return wins.map((w) => w / total);
};

/** 控除率 20% の単勝オッズ（最低 1.1 倍） */
export const oddsFromProbability = (probability: number): number => {
  if (probability <= 0) return 999.9;
  const odds = Math.floor((0.8 / probability) * 10) / 10;
  return Math.min(999.9, Math.max(1.1, odds));
};

const MARKS = ["◎", "○", "▲", "△", "△"];

/** 勝率の高い順に予想印を付ける */
export const marksFromProbabilities = (probabilities: number[]): string[] => {
  const ranked = probabilities
    .map((p, i) => ({ p, i }))
    .sort((a, b) => b.p - a.p || a.i - b.i);
  const marks = new Array<string>(probabilities.length).fill("");
  ranked.forEach(({ i }, rank) => {
    if (rank < MARKS.length && rank < probabilities.length - 1) {
      marks[i] = MARKS[rank];
    }
  });
  return marks;
};

/** 人気順（1 = 1 番人気） */
export const popularityRanks = (probabilities: number[]): number[] => {
  const ranked = probabilities
    .map((p, i) => ({ p, i }))
    .sort((a, b) => b.p - a.p || a.i - b.i);
  const ranks = new Array<number>(probabilities.length).fill(0);
  ranked.forEach(({ i }, rank) => {
    ranks[i] = rank + 1;
  });
  return ranks;
};

// ----- 描画用: 抽選列 → 滑らかな位置 -----

/** 馬ごとに「何回目の抽選で前進したか」の列を作る */
export const buildPickTracks = (
  race: Pick<RaceSimulation, "picks">,
  horseCount: number
): number[][] => {
  const tracks: number[][] = Array.from({ length: horseCount }, () => []);
  race.picks.forEach((horse, drawIndex) => {
    tracks[horse]?.push(drawIndex + 1);
  });
  return tracks;
};

/**
 * 抽選の進行度 x（0..totalDraws、小数可。超えても可）における馬の歩数を滑らかに返す。
 * 前進と前進の間を線形補間する。勝ち馬のゴール時点で次の前進がない馬は、
 * 平均ペースから「次に前進するはずだった時刻」を仮置きして、ゴール後も走り続けさせる
 * （ゴール前に勝ち馬を追い越すことはない）。
 */
export const progressAt = (track: number[], x: number, totalDraws: number): number => {
  if (x <= 0) return 0;
  // 二分探索で x 以下の前進回数を数える
  let lo = 0;
  let hi = track.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (track[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  const done = lo;
  const prevTime = done === 0 ? 0 : track[done - 1];
  if (done < track.length) {
    const nextTime = track[done];
    return done + (x - prevTime) / (nextTime - prevTime);
  }
  const total = Math.max(1, totalDraws);
  const pace = Math.max(track.length, 0.5) / total;
  const virtualNext = Math.max(total, prevTime) + 1 / pace;
  if (x <= virtualNext) {
    return done + (x - prevTime) / (virtualNext - prevTime);
  }
  return done + 1 + (x - virtualNext) * pace;
};
