import {
  DEFAULT_DISTANCE,
  parseDistance,
  type GitHubActivity,
  type RaceRecord,
} from "@tainakanchu/roulette-core";
import { readLocalStorage, writeLocalStorage } from "./localStorage";

const HISTORY_KEY = "roulette-horse-race-history";
const DISTANCE_KEY = "roulette-horse-race-distance";
const RACE_NAME_KEY = "roulette-horse-race-name";
const RACE_GRADE_KEY = "roulette-horse-race-grade";
const LOGINS_KEY = "roulette-horse-race-github-logins";
const ACTIVITY_KEY = "roulette-horse-race-github-activity";

const MAX_HISTORY = 100;

const readJson = <T>(key: string, fallback: T): T => {
  const raw = readLocalStorage(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

// ----- レース履歴（新しい順） -----

/** 保存済みの 1 レース分を読み取る（旧バージョンの距離 ID も m に変換する） */
const toRaceRecord = (value: unknown): RaceRecord | null => {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const distance = parseDistance(record.distance);
  if (
    typeof record.timestamp !== "number" ||
    distance === null ||
    !Array.isArray(record.order) ||
    !record.order.every((name) => typeof name === "string")
  ) {
    return null;
  }
  return { timestamp: record.timestamp, distance, order: record.order as string[] };
};

export const loadRaceHistory = (): RaceRecord[] => {
  const value = readJson<unknown>(HISTORY_KEY, []);
  if (!Array.isArray(value)) return [];
  return value.map(toRaceRecord).filter((r): r is RaceRecord => r !== null);
};

export const saveRaceHistory = (history: RaceRecord[]) => {
  writeLocalStorage(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
};

// ----- 距離 -----

export const loadDistance = (): number =>
  parseDistance(readLocalStorage(DISTANCE_KEY)) ?? DEFAULT_DISTANCE;

export const saveDistance = (meters: number) => {
  writeLocalStorage(DISTANCE_KEY, String(meters));
};

// ----- レース名（ユーザー入力のみ保存。空ならローカライズ済みの既定名を使う） -----

export const MAX_RACE_NAME_LENGTH = 30;

export const normalizeRaceName = (value: string): string =>
  value.trim().slice(0, MAX_RACE_NAME_LENGTH).trim();

export const loadRaceName = (): string => normalizeRaceName(readLocalStorage(RACE_NAME_KEY) ?? "");

export const saveRaceName = (name: string) => {
  writeLocalStorage(RACE_NAME_KEY, name);
};

/** 格付け（空文字は格付けなし） */
export const RACE_GRADES = ["G1", "G2", "G3", "OP", ""] as const;
export type RaceGrade = (typeof RACE_GRADES)[number];

export const loadRaceGrade = (): RaceGrade => {
  const value = readLocalStorage(RACE_GRADE_KEY);
  return RACE_GRADES.find((grade) => grade === value) ?? "G1";
};

export const saveRaceGrade = (grade: RaceGrade) => {
  writeLocalStorage(RACE_GRADE_KEY, grade);
};

// ----- GitHub 連携（馬名 → GitHub ユーザー名） -----

export const loadGitHubLogins = (): Record<string, string> => {
  const value = readJson<unknown>(LOGINS_KEY, {});
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
};

export const saveGitHubLogins = (logins: Record<string, string>) => {
  writeLocalStorage(LOGINS_KEY, JSON.stringify(logins));
};

export interface CachedActivity {
  activity: GitHubActivity;
  fetchedAt: number;
}

export const loadActivityCache = (): Record<string, CachedActivity> => {
  const value = readJson<unknown>(ACTIVITY_KEY, {});
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, CachedActivity>;
};

export const saveActivityCache = (cache: Record<string, CachedActivity>) => {
  writeLocalStorage(ACTIVITY_KEY, JSON.stringify(cache));
};
