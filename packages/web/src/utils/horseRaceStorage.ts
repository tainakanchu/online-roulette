import {
  isRaceDistanceId,
  type GitHubActivity,
  type RaceDistanceId,
  type RaceRecord,
} from "@tainakanchu/roulette-core";
import { readLocalStorage, writeLocalStorage } from "./localStorage";

const HISTORY_KEY = "roulette-horse-race-history";
const DISTANCE_KEY = "roulette-horse-race-distance";
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

const isRaceRecord = (value: unknown): value is RaceRecord => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.timestamp === "number" &&
    isRaceDistanceId(record.distance) &&
    Array.isArray(record.order) &&
    record.order.every((name) => typeof name === "string")
  );
};

export const loadRaceHistory = (): RaceRecord[] => {
  const value = readJson<unknown>(HISTORY_KEY, []);
  return Array.isArray(value) ? value.filter(isRaceRecord) : [];
};

export const saveRaceHistory = (history: RaceRecord[]) => {
  writeLocalStorage(HISTORY_KEY, JSON.stringify(history.slice(0, MAX_HISTORY)));
};

// ----- 距離 -----

export const loadDistance = (): RaceDistanceId => {
  const value = readLocalStorage(DISTANCE_KEY);
  return isRaceDistanceId(value) ? value : "mile";
};

export const saveDistance = (distance: RaceDistanceId) => {
  writeLocalStorage(DISTANCE_KEY, distance);
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
