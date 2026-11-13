import { useCallback, useEffect, useMemo, useState } from "react";
import {
  COLORS,
  MAX_HORSES,
  activityScore,
  clampDistance,
  computeRating,
  parseDistance,
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
  getOwnValue,
  loadActivityCache,
  loadDistance,
  loadGitHubLogins,
  loadRaceHistory,
  loadRaceGrade,
  loadRaceName,
  normalizeRaceName,
  saveActivityCache,
  saveDistance,
  saveGitHubLogins,
  saveRaceHistory,
  saveRaceGrade,
  saveRaceName,
  type CachedActivity,
  type RaceGrade,
} from "../utils/horseRaceStorage";
import {
  loadGoing,
  loadSurface,
  parseGoing,
  parseSurface,
  saveGoing,
  saveSurface,
  type TrackGoing,
  type TrackSurface,
} from "../utils/raceCourse";
import { changeWindForGoing, createRaceWind, type RaceWind } from "../utils/raceWind";
import {
  fetchGitHubActivity,
  GitHubFetchError,
  isValidLogin,
  normalizeLogin,
} from "../utils/githubActivity";
import { QUERY_KEYS, readQueryParam, writeQueryParams } from "../utils/urlQuery";

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
  // URL クエリがあればそれを優先し、なければ前回の設定を使う
  const [distance, setDistanceState] = useState<number>(
    () => parseDistance(readQueryParam(QUERY_KEYS.distance)) ?? loadDistance()
  );
  const [raceName, setRaceNameState] = useState<string>(loadRaceName);
  const [raceGrade, setRaceGradeState] = useState<RaceGrade>(loadRaceGrade);
  const [surface, setSurfaceState] = useState<TrackSurface>(
    () => parseSurface(readQueryParam(QUERY_KEYS.surface)) ?? loadSurface()
  );
  const [going, setGoingState] = useState<TrackGoing>(
    () => parseGoing(readQueryParam(QUERY_KEYS.going)) ?? loadGoing()
  );
  // 会場の風。開いたときに決め、馬場状態を変えたら強さだけ決め直す（同じ日の同じ競馬場なので向きは変えない）
  const [wind, setWind] = useState<RaceWind>(() => createRaceWind(going));
  const [history, setHistory] = useState<RaceRecord[]>(loadRaceHistory);
  const [logins, setLogins] = useState<Record<string, string>>(loadGitHubLogins);
  const [activityCache, setActivityCache] =
    useState<Record<string, CachedActivity>>(loadActivityCache);
  const [githubStatus, setGithubStatus] = useState<Record<string, GitHubStatus>>({});

  const names = useMemo(() => options.slice(0, MAX_HORSES), [options]);

  // 距離・コース・馬場状態を URL クエリに反映する（競馬モードを離れたら取り除く）
  useEffect(() => {
    writeQueryParams({
      [QUERY_KEYS.distance]: String(distance),
      [QUERY_KEYS.surface]: surface,
      [QUERY_KEYS.going]: going,
    });
  }, [distance, surface, going]);

  useEffect(
    () => () =>
      writeQueryParams({
        [QUERY_KEYS.distance]: null,
        [QUERY_KEYS.surface]: null,
        [QUERY_KEYS.going]: null,
      }),
    []
  );

  const setDistance = useCallback((meters: number) => {
    const value = clampDistance(meters);
    setDistanceState(value);
    saveDistance(value);
  }, []);

  const setRaceName = useCallback((value: string) => {
    const name = normalizeRaceName(value);
    setRaceNameState(name);
    saveRaceName(name);
  }, []);

  const setRaceGrade = useCallback((grade: RaceGrade) => {
    setRaceGradeState(grade);
    saveRaceGrade(grade);
  }, []);

  const setSurface = useCallback((value: TrackSurface) => {
    setSurfaceState(value);
    saveSurface(value);
  }, []);

  const setGoing = useCallback((value: TrackGoing) => {
    setGoingState(value);
    saveGoing(value);
    setWind((current) => changeWindForGoing(current, value));
  }, []);

  const base = useMemo(
    () =>
      names.map((name, index) => {
        const finishes = recentFinishes(name, history);
        const login = getOwnValue(logins, name) ?? "";
        const activity = login
          ? (getOwnValue(activityCache, login.toLowerCase())?.activity ?? null)
          : null;
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
      const login = normalizeLogin(value);
      const next = { ...prev, [name]: login };
      if (!login) delete next[name];
      saveGitHubLogins(next);
      return next;
    });
  }, []);

  const fetchActivities = useCallback(async () => {
    const now = Date.now();
    const targets = Array.from(
      new Set(
        names.map((name) => getOwnValue(logins, name)).filter((login): login is string => !!login)
      )
    );
    for (const login of targets) {
      const key = login.toLowerCase();
      if (!isValidLogin(login)) {
        setGithubStatus((prev) => ({ ...prev, [key]: "invalid" }));
        continue;
      }
      const cached = getOwnValue(activityCache, key);
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
    raceName,
    setRaceName,
    raceGrade,
    setRaceGrade,
    surface,
    setSurface,
    going,
    setGoing,
    wind,
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
