import { frameNumber } from "../raceFrame";
import { isValidLogin, normalizeLogin } from "../githubLogin";

describe("frameNumber", () => {
  it("8 頭以下は馬番 = 枠番", () => {
    expect([1, 2, 3, 4, 5].map((n) => frameNumber(n, 5))).toEqual([1, 2, 3, 4, 5]);
  });

  it("10 頭立ては 7・8 枠に 2 頭ずつ", () => {
    expect(Array.from({ length: 10 }, (_, i) => frameNumber(i + 1, 10))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 7, 8, 8,
    ]);
  });

  it("18 頭立ては 7・8 枠に 3 頭ずつ", () => {
    expect(Array.from({ length: 18 }, (_, i) => frameNumber(i + 1, 18))).toEqual([
      1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 7, 8, 8, 8,
    ]);
  });
});

describe("GitHub ユーザー名", () => {
  it("@ や URL を取り除く", () => {
    expect(normalizeLogin(" @octocat ")).toBe("octocat");
    expect(normalizeLogin("https://github.com/octocat/repo")).toBe("octocat");
  });

  it("形式チェック", () => {
    expect(isValidLogin("octo-cat")).toBe(true);
    expect(isValidLogin("-octo")).toBe(false);
    expect(isValidLogin("a/b")).toBe(false);
  });
});
