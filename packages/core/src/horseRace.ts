import { cryptoRandom } from "./roulette";

// ===== 競馬モードのロジック =====
// 抽選で当たった馬がスピードを得て前に出て、最初にゴールした馬が勝ち。
// 当たりは「位置」ではなく「スピード」に効かせるので、動きはなめらかになる。
// 能力値（近走成績 + GitHub の調教データ）で当たりやすさを「少しだけ」重みづけする。

// ----- 距離 -----

export const MIN_DISTANCE = 1000;
export const MAX_DISTANCE = 3600;
export const DISTANCE_STEP = 100;
export const DEFAULT_DISTANCE = 1600;
/** よく使う距離（ワンタップで選べる） */
export const DISTANCE_PRESETS = [1200, 1600, 2000, 2400, 3000, 3200] as const;

/** 距離区分（SMILE 区分） */
export type DistanceCategory = "sprint" | "mile" | "intermediate" | "long" | "extended";

export const distanceCategory = (meters: number): DistanceCategory => {
  if (meters <= 1300) return "sprint";
  if (meters < 1900) return "mile";
  if (meters <= 2100) return "intermediate";
  if (meters <= 2700) return "long";
  return "extended";
};

export const clampDistance = (meters: number): number => {
  const stepped = Math.round(meters / DISTANCE_STEP) * DISTANCE_STEP;
  return Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, stepped));
};

// 旧バージョン（3 択）で保存された距離 ID
const LEGACY_DISTANCES: Record<string, number> = { sprint: 1200, mile: 1600, long: 2400 };

/** 保存値などから距離（m）を読み取る。読めなければ null */
export const parseDistance = (value: unknown): number | null => {
  if (typeof value === "string" && value in LEGACY_DISTANCES) return LEGACY_DISTANCES[value];
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(num) || num <= 0) return null;
  return clampDistance(num);
};

/**
 * ゴールまでの距離（レース内部の単位）。1 単位 ≒ 1 頭あたりの平均当選 1 回分。
 * 長いほど抽選回数が増え、実力が結果に出やすくなる。
 */
export const raceTarget = (meters: number): number => (meters * 36) / 1600;

export const MAX_HORSES = 18;

/** 脚質: 逃げ / 先行 / 差し / 追込 */
export type RunningStyle = "front" | "stalker" | "closer" | "deep";

export interface RaceRecord {
  timestamp: number;
  /** 距離（m） */
  distance: number;
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
const STYLE_PIVOT = 0.57;

/**
 * レース展開（phase: 0=スタート, 1=ゴール）に応じた脚質ごとの倍率。
 * 逃げは序盤に飛ばして失速、追込は終盤に伸びる。勝率はほぼ同じで展開の妙だけが生まれる。
 */
export const styleMultiplier = (style: RunningStyle, phase: number): number => {
  const p = Math.min(1, Math.max(0, phase));
  return 1 + STYLE_SLOPES[style] * (p - STYLE_PIVOT);
};

// ----- レース本体 -----

/** 1 単位時間あたりの刻み数 */
const SUBSTEPS = 6;
/** 当たり → 勢い の時定数（単位時間） */
const RATE_TAU = 2.5;
/** 勢い → スピード の時定数（単位時間）。2 段にしてスピードの変化をなめらかにする */
const SPEED_TAU = 2.5;
const STYLE_LOOKAHEAD = 5;
const STYLE_REFERENCE_TARGET = 36;

export interface RaceSimulationInput {
  strengths: number[];
  styles: RunningStyle[];
  target: number;
  random?: () => number;
}

export interface RaceSimulation {
  target: number;
  /** samples の時間間隔（単位時間） */
  dt: number;
  /** 馬ごとの位置の時系列（index k は時刻 k * dt） */
  samples: number[][];
  /** 馬ごとのゴール時刻（補間済み）。ゴールしていなければ Infinity */
  finishTimes: number[];
  winner: number;
  /** 着順（馬 index） */
  order: number[];
}

const runRace = (
  { strengths, styles, target, random = cryptoRandom }: RaceSimulationInput,
  record: boolean
): RaceSimulation => {
  const n = strengths.length;
  const dt = 1 / SUBSTEPS;
  const finishTimes = new Array<number>(n).fill(Infinity);
  const samples: number[][] = record ? strengths.map(() => [0]) : [];
  if (n === 0 || target <= 0) {
    return { target, dt, samples, finishTimes, winner: -1, order: [] };
  }

  const pos = new Array<number>(n).fill(0);
  const rate = new Array<number>(n).fill(0);
  const speed = new Array<number>(n).fill(0);
  const weights = new Array<number>(n);
  // 距離が長いほど脚質の差が積み重なるので、効き目を距離で割り引いて距離による有利不利をなくす
  const styleScale = Math.sqrt(STYLE_REFERENCE_TARGET / target);
  let leader = 0;
  let finished = 0;
  let firstFinish = Infinity;
  let t = 0;
  // 安全弁（通常は target + 十数単位で決着する）
  const maxTime = target * 4 + 40;

  while (t < maxTime) {
    // スピードは当たりから遅れて効くので、その分だけ先の展開を見て脚質の倍率を決める
    const phase = Math.min(1, (leader + STYLE_LOOKAHEAD) / target);
    let sum = 0;
    for (let i = 0; i < n; i += 1) {
      weights[i] =
        strengths[i] * (1 + (styleMultiplier(styles[i] ?? "stalker", phase) - 1) * styleScale);
      sum += weights[i];
    }
    const mean = sum / n;
    t += dt;
    for (let i = 0; i < n; i += 1) {
      // 1 単位時間に平均 1 回（強い馬ほど少し多く）当たる
      const hit = random() < (weights[i] / mean) * dt ? 1 : 0;
      rate[i] += hit / RATE_TAU - (rate[i] * dt) / RATE_TAU;
      speed[i] += ((rate[i] - speed[i]) * dt) / SPEED_TAU;
      const prev = pos[i];
      pos[i] = prev + speed[i] * dt;
      if (pos[i] > leader) leader = pos[i];
      if (finishTimes[i] === Infinity && pos[i] >= target) {
        finishTimes[i] = t - dt + ((target - prev) / (pos[i] - prev)) * dt;
        finished += 1;
        if (finishTimes[i] < firstFinish) firstFinish = finishTimes[i];
      }
      if (record) samples[i].push(pos[i]);
    }
    // オッズ計算用は勝ち馬が決まった時点で打ち切る
    if (!record && finished > 0) break;
    // 描画用は全馬がゴールするまで（大差の最後方は打ち切って位置で着順を決める）
    if (record && (finished === n || t > firstFinish * 1.6 + 10)) break;
  }

  const order = pos
    .map((_, i) => i)
    .sort((a, b) => finishTimes[a] - finishTimes[b] || pos[b] - pos[a] || a - b);
  const winner = finishTimes[order[0]] === Infinity ? -1 : order[0];
  return { target, dt, samples, finishTimes, winner, order };
};

export const simulateHorseRace = (input: RaceSimulationInput): RaceSimulation =>
  runRace(input, true);

/**
 * 時刻 t（単位時間）における馬の位置。
 * サンプル間は Catmull-Rom で補間し、スピードが刻みの継ぎ目で段にならないようにする。
 * 記録の終わり以降は最後の速度で進み続ける。
 */
export const positionAt = (race: RaceSimulation, horse: number, t: number): number => {
  const s = race.samples[horse];
  if (!s || s.length === 0) return 0;
  if (t <= 0) return s[0];
  const f = t / race.dt;
  const i = Math.floor(f);
  const last = s.length - 1;
  if (i >= last) {
    const v = last > 0 ? (s[last] - s[last - 1]) / race.dt : 0;
    return s[last] + v * (t - last * race.dt);
  }
  const p1 = s[i];
  const p2 = s[i + 1];
  const p0 = i > 0 ? s[i - 1] : 2 * p1 - p2;
  const p3 = i + 2 <= last ? s[i + 2] : 2 * p2 - p1;
  const u = f - i;
  const m1 = (p2 - p0) / 2;
  const m2 = (p3 - p1) / 2;
  const u2 = u * u;
  const u3 = u2 * u;
  return (
    (2 * u3 - 3 * u2 + 1) * p1 + (u3 - 2 * u2 + u) * m1 + (-2 * u3 + 3 * u2) * p2 + (u3 - u2) * m2
  );
};

/** 勝ち馬がゴールした時刻 */
export const winnerTime = (race: RaceSimulation): number =>
  race.winner >= 0 ? race.finishTimes[race.winner] : 0;

/** モンテカルロで各馬の勝率を見積もる（オッズ・印に使う） */
export const estimateWinProbabilities = (
  strengths: number[],
  styles: RunningStyle[],
  target: number,
  trials = 1000,
  random: () => number = Math.random
): number[] => {
  const n = strengths.length;
  if (n === 0) return [];
  const wins = new Array<number>(n).fill(0.5); // 0 勝でもオッズが無限にならないよう補正
  for (let k = 0; k < trials; k += 1) {
    const { winner } = runRace({ strengths, styles, target, random }, false);
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
