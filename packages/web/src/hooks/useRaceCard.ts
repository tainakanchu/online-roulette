import { useCallback, useMemo, useState } from "react";
import {
  COLORS,
  MAX_HORSES,
  activityScore,
  clampDistance,
  computeRating,
  estimateWinProbabilities,
  formScore,
  marksFromProbabilities,
  nameHash,
  oddsFromProbability,
  popularityRanks,
  raceTarget,
  recentFinishes,
  runningStyleFor,
  strengthFromRating,
  type Finish,
  type GitHubActivity,
  type RaceRecord,
  type RunningStyle,
} from "@tainakanchu/roulette-core";
import {
  loadActivityCache,
  loadDistance,
  loadGitHubLogins,
  loadRaceHistory,
  saveActivityCache,
  saveDistance,
  saveGitHubLogins,
  saveRaceHistory,
  type CachedActivity,
} from "../utils/horseRaceStorage";
import {
  fetchGitHubActivity,
  GitHubFetchError,
  isValidLogin,
  normalizeLogin,
} from "../utils/githubActivity";

const ACTIVITY_TTL_MS = 60 * 60 * 1000;

export type GitHubStatus = "idle" | "loading" | "notFound" | "rateLimited" | "network" | "invalid";

export interface RaceEntry {
  index: number;
  number: number;
  name: string;
  color: string;
  seed: number;
  finishes: Finish[];
  style: RunningStyle;
  login: string;
  activity: GitHubActivity | null;
  rating: number;
  strength: number;
  probability: number;
  odds: number;
  mark: string;
  popularity: number;
}

/** 出走表（競馬新聞）に必要なデータをまとめて管理する */
export const useRaceCard = (options: string[]) => {
  const [distance, setDistanceState] = useState<number>(loadDistance);
  const [history, setHistory] = useState<RaceRecord[]>(loadRaceHistory);
  const [logins, setLogins] = useState<Record<string, string>>(loadGitHubLogins);
  const [activityCache, setActivityCache] =
    useState<Record<string, CachedActivity>>(loadActivityCache);
  const [githubStatus, setGithubStatus] = useState<Record<string, GitHubStatus>>({});

  const names = useMemo(() => options.slice(0, MAX_HORSES), [options]);

  const setDistance = useCallback((meters: number) => {
    const value = clampDistance(meters);
    setDistanceState(value);
    saveDistance(value);
  }, []);

  const base = useMemo(
    () =>
      names.map((name, index) => {
        const finishes = recentFinishes(name, history);
        const login = logins[name] ?? "";
        const activity = login ? (activityCache[login.toLowerCase()]?.activity ?? null) : null;
        const rating = computeRating(
          formScore(finishes),
          activity ? activityScore(activity) : null
        );
        return {
          index,
          number: index + 1,
          name,
          color: COLORS[index % COLORS.length],
          seed: nameHash(name),
          finishes,
          style: runningStyleFor(name),
          login,
          activity,
          rating,
          strength: strengthFromRating(rating),
        };
      }),
    [names, history, logins, activityCache]
  );

  const target = raceTarget(distance);
  const strengthKey = base.map((b) => `${b.strength}:${b.style}`).join("|");
  const probabilities = useMemo(
    () =>
      estimateWinProbabilities(
        base.map((b) => b.strength),
        base.map((b) => b.style),
        target,
        base.length > 10 ? 500 : 900
      ),
    // 能力値・脚質・距離が変わったときだけ再計算する（重い）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [strengthKey, target]
  );

  const entries: RaceEntry[] = useMemo(() => {
    const marks = marksFromProbabilities(probabilities);
    const ranks = popularityRanks(probabilities);
    return base.map((b, i) => ({
      ...b,
      probability: probabilities[i] ?? 0,
      odds: oddsFromProbability(probabilities[i] ?? 0),
      mark: marks[i] ?? "",
      popularity: ranks[i] ?? 0,
    }));
  }, [base, probabilities]);

  const recordRace = useCallback((record: RaceRecord) => {
    setHistory((prev) => {
      const next = [record, ...prev];
      saveRaceHistory(next);
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    saveRaceHistory([]);
  }, []);

  const setLogin = useCallback((name: string, value: string) => {
    setLogins((prev) => {
      const next = { ...prev };
      const login = normalizeLogin(value);
      if (login) next[name] = login;
      else delete next[name];
      saveGitHubLogins(next);
      return next;
    });
  }, []);

  const fetchActivities = useCallback(async () => {
    const now = Date.now();
    const targets = Array.from(
      new Set(names.map((name) => logins[name]).filter((login): login is string => !!login))
    );
    for (const login of targets) {
      const key = login.toLowerCase();
      if (!isValidLogin(login)) {
        setGithubStatus((prev) => ({ ...prev, [key]: "invalid" }));
        continue;
      }
      const cached = activityCache[key];
      if (cached && now - cached.fetchedAt < ACTIVITY_TTL_MS) continue;
      setGithubStatus((prev) => ({ ...prev, [key]: "loading" }));
      try {
        const activity = await fetchGitHubActivity(login, now);
        setActivityCache((prev) => {
          const next = { ...prev, [key]: { activity, fetchedAt: now } };
          saveActivityCache(next);
          return next;
        });
        setGithubStatus((prev) => ({ ...prev, [key]: "idle" }));
      } catch (error) {
        const kind = error instanceof GitHubFetchError ? error.kind : "network";
        setGithubStatus((prev) => ({ ...prev, [key]: kind }));
        if (kind === "rateLimited") break;
      }
    }
  }, [names, logins, activityCache]);

  return {
    distance,
    setDistance,
    entries,
    history,
    recordRace,
    clearHistory,
    logins,
    setLogin,
    githubStatus,
    fetchActivities,
    overflow: Math.max(0, options.length - MAX_HORSES),
  };
};
