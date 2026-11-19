// URL クエリで画面の状態を共有するためのヘルパー（履歴は増やさず replaceState で書き換える）

export const QUERY_KEYS = {
  mode: "mode",
  distance: "distance",
  surface: "surface",
  going: "going",
  raceName: "raceName",
  raceGrade: "grade",
} as const;

export const readQueryParam = (key: string): string | null =>
  new URLSearchParams(window.location.search).get(key);

/** null を渡すとクエリから取り除く */
export const writeQueryParams = (params: Record<string, string | null>) => {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(params)) {
    if (value === null) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
  }
  const next = url.toString();
  if (next !== window.location.href) {
    window.history.replaceState(window.history.state, "", next);
  }
};
