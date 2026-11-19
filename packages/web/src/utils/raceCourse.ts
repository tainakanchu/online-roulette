import { readLocalStorage, writeLocalStorage } from "./localStorage";

// 競馬モードのコース（芝・ダート）と馬場状態。見た目だけに使い、レース展開には影響しない

const SURFACE_KEY = "roulette-horse-race-surface";
const GOING_KEY = "roulette-horse-race-going";

export const TRACK_SURFACES = ["turf", "dirt"] as const;
export type TrackSurface = (typeof TRACK_SURFACES)[number];

/** 馬場状態。良 → 稍重 → 重 → 不良 の順に水を含む */
export const TRACK_GOINGS = ["firm", "good", "yielding", "soft"] as const;
export type TrackGoing = (typeof TRACK_GOINGS)[number];

export const parseSurface = (value: unknown): TrackSurface | null =>
  TRACK_SURFACES.find((surface) => surface === value) ?? null;

export const parseGoing = (value: unknown): TrackGoing | null =>
  TRACK_GOINGS.find((going) => going === value) ?? null;

export const loadSurface = (): TrackSurface =>
  parseSurface(readLocalStorage(SURFACE_KEY)) ?? "turf";

export const saveSurface = (surface: TrackSurface) => {
  writeLocalStorage(SURFACE_KEY, surface);
};

export const loadGoing = (): TrackGoing => parseGoing(readLocalStorage(GOING_KEY)) ?? "firm";

export const saveGoing = (going: TrackGoing) => {
  writeLocalStorage(GOING_KEY, going);
};
