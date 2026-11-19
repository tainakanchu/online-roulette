import { loadActivityCache } from "../horseRaceStorage";

beforeEach(() => localStorage.clear());

describe("loadActivityCache", () => {
  it.each(["null", "[]", "invalid JSON"])("rejects invalid outer data: %s", (stored) => {
    localStorage.setItem("roulette-horse-race-github-activity", stored);
    expect(loadActivityCache()).toEqual({});
  });

  it("keeps only entries with valid timestamps and finite nonnegative counters", () => {
    const valid = { fetchedAt: 123, activity: { commits: 1, pullRequests: 2, reviews: 3, issues: 0 } };
    const zero = { ...valid, fetchedAt: 0 };
    const cache = {
      valid, zero, empty: { fetchedAt: 123, activity: {} }, nil: null,
      missing: {}, noActivity: { fetchedAt: 123, activity: null },
      ...Object.fromEntries([null, "123", -1].map((fetchedAt, i) => [
        `timestamp${i}`, { ...valid, fetchedAt },
      ])),
      ...Object.fromEntries(Object.keys(valid.activity).flatMap((counter) =>
        [undefined, null, "1", -1].map((value, i) => [
          `${counter}${i}`, { ...valid, activity: { ...valid.activity, [counter]: value } },
        ])
      )),
    };
    localStorage.setItem("roulette-horse-race-github-activity", JSON.stringify(cache));
    expect(loadActivityCache()).toEqual({ valid, zero });

  });
  it.each(["fetchedAt", "commits", "pullRequests", "reviews", "issues"])(
    "rejects a non-finite %s",
    (field) => {
      const entry = { fetchedAt: 123, activity: { commits: 1, pullRequests: 2, reviews: 3, issues: 0 } };
      const stored = JSON.stringify({ overflow: entry }).replace(
        `"${field}":${field === "fetchedAt" ? 123 : entry.activity[field as keyof typeof entry.activity]}`,
        `"${field}":1e400`
      );
      localStorage.setItem("roulette-horse-race-github-activity", stored);
      expect(loadActivityCache()).toEqual({});
    }
  );
});
