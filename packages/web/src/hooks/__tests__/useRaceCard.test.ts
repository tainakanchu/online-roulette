import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useRaceCard } from "../useRaceCard";
import {
  getOwnValue,
  loadActivityCache,
  loadGitHubLogins,
  saveActivityCache,
} from "../../utils/horseRaceStorage";
import { fetchGitHubActivity } from "../../utils/githubActivity";

jest.mock("../../utils/githubActivity", () => ({
  ...jest.requireActual("../../utils/githubActivity"),
  fetchGitHubActivity: jest.fn(),
}));

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

const names = ["constructor", "toString", "__proto__", "hasOwnProperty"];

it("handles prototype key horse names through rendering, fetching and login storage", async () => {
  window.localStorage.clear();
  const container = document.createElement("div");
  const root = createRoot(container);
  let card: ReturnType<typeof useRaceCard>;
  function Harness() {
    card = useRaceCard(names);
    return createElement("div", null, card.entries.map((entry) => entry.login).join(","));
  }
  try {
    act(() => root.render(createElement(Harness)));
    expect(card!.entries.map((entry) => entry.login)).toEqual(names.map(() => ""));
    await act(async () => card!.fetchActivities());
    expect(fetchGitHubActivity).not.toHaveBeenCalled();
    for (const name of names) {
      act(() => card!.setLogin(name, "octocat"));
    }
    expect(card!.entries.map((entry) => entry.login)).toEqual(names.map(() => "octocat"));
    expect(Object.entries(loadGitHubLogins())).toEqual(names.map((name) => [name, "octocat"]));
    expect(JSON.parse(window.localStorage.getItem("roulette-horse-race-github-logins")!))
      .toEqual(Object.fromEntries(names.map((name) => [name, "octocat"])));
    const activity = { commits: 1, pullRequests: 2, reviews: 3, issues: 4 };
    jest.mocked(fetchGitHubActivity).mockResolvedValue(activity);
    act(() => card!.setLogin("constructor", "constructor"));
    await act(async () => card!.fetchActivities());
    expect(fetchGitHubActivity).toHaveBeenCalledTimes(2);
    expect(card!.entries.map((entry) => entry.activity)).toEqual(names.map(() => activity));
    await act(async () => card!.fetchActivities());
    expect(fetchGitHubActivity).toHaveBeenCalledTimes(2);
    act(() => card!.setLogin("__proto__", ""));
    expect(card!.entries[2].login).toBe("");
    expect(Object.prototype.hasOwnProperty.call(loadGitHubLogins(), "__proto__")).toBe(false);
  } finally {
    act(() => root.unmount());
    window.localStorage.clear();
  }
});

it.each(names)("reads only own activity cache entries for %s", (login) => {
  window.localStorage.clear();
  expect(getOwnValue(loadActivityCache(), login)).toBeUndefined();
  const cached = {
    activity: { commits: 1, pullRequests: 2, reviews: 3, issues: 4 },
    fetchedAt: Date.now(),
  };
  saveActivityCache({ [login]: cached });
  expect(getOwnValue(loadActivityCache(), login)).toEqual(cached);
  window.localStorage.clear();
});

it("prefers URL query for distance and course, and syncs changes back to the URL", () => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/?mode=horseRace&distance=2400&surface=dirt&going=soft");
  const container = document.createElement("div");
  const root = createRoot(container);
  let card: ReturnType<typeof useRaceCard>;
  function Harness() {
    card = useRaceCard(["A", "B"]);
    return null;
  }
  try {
    act(() => root.render(createElement(Harness)));
    expect(card!.distance).toBe(2400);
    expect(card!.surface).toBe("dirt");
    expect(card!.going).toBe("soft");

    act(() => card!.setDistance(1200));
    act(() => card!.setSurface("turf"));
    const params = new URLSearchParams(window.location.search);
    expect(params.get("distance")).toBe("1200");
    expect(params.get("surface")).toBe("turf");
    expect(params.get("going")).toBe("soft");
  } finally {
    act(() => root.unmount());
  }
  // 競馬モードを離れたらコース系のクエリは消え、モードは残る
  const params = new URLSearchParams(window.location.search);
  expect(params.get("distance")).toBeNull();
  expect(params.get("mode")).toBe("horseRace");
});

it("falls back to stored values when the URL query is invalid", () => {
  window.localStorage.clear();
  window.localStorage.setItem("roulette-horse-race-surface", "dirt");
  window.history.replaceState(null, "", "/?distance=abc&surface=sand");
  const container = document.createElement("div");
  const root = createRoot(container);
  let card: ReturnType<typeof useRaceCard>;
  function Harness() {
    card = useRaceCard(["A"]);
    return null;
  }
  try {
    act(() => root.render(createElement(Harness)));
    expect(card!.distance).toBe(1600);
    expect(card!.surface).toBe("dirt");
  } finally {
    act(() => root.unmount());
  }
});
