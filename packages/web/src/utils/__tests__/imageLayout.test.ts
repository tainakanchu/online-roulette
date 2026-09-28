import { sortBattleRows, truncateLabel } from "../imageLayout";

// 1文字10pxの単純な計測関数（jsdomにはcanvasの実装がないため注入する）
const measure = (value: string) => Array.from(value).length * 10;

describe("sortBattleRows", () => {
  it("当選回数の多い順に並べ替える", () => {
    const rows = sortBattleRows(["a", "b", "c"], [1, 5, 3]);
    expect(rows.map((row) => row.label)).toEqual(["b", "c", "a"]);
    expect(rows.map((row) => row.count)).toEqual([5, 3, 1]);
  });

  it("元のインデックスを保持する（色の決定に使う）", () => {
    const rows = sortBattleRows(["a", "b", "c"], [1, 5, 3]);
    expect(rows.map((row) => row.index)).toEqual([1, 2, 0]);
  });

  it("同数の場合は元の並び順を維持する", () => {
    const rows = sortBattleRows(["a", "b", "c"], [2, 2, 2]);
    expect(rows.map((row) => row.label)).toEqual(["a", "b", "c"]);
  });

  it("countsが不足している場合は0として扱う", () => {
    const rows = sortBattleRows(["a", "b"], [3]);
    expect(rows).toEqual([
      { label: "a", count: 3, index: 0 },
      { label: "b", count: 0, index: 1 },
    ]);
  });

  it("空配列を渡しても空配列を返す", () => {
    expect(sortBattleRows([], [])).toEqual([]);
  });
});

describe("truncateLabel", () => {
  it("収まる場合はそのまま返す", () => {
    expect(truncateLabel("abcde", 50, measure)).toBe("abcde");
  });

  it("はみ出す場合は省略記号を付けて切り詰める", () => {
    // "abc…" = 40px で 45px に収まる
    expect(truncateLabel("abcdefg", 45, measure)).toBe("abc…");
  });

  it("切り詰めた結果が指定幅に収まる", () => {
    const result = truncateLabel("abcdefghij", 55, measure);
    expect(measure(result)).toBeLessThanOrEqual(55);
    expect(result.endsWith("…")).toBe(true);
  });

  it("省略記号すら入らない幅なら空文字を返す", () => {
    expect(truncateLabel("abc", 5, measure)).toBe("");
  });

  it("幅が0以下なら空文字を返す", () => {
    expect(truncateLabel("abc", 0, measure)).toBe("");
  });

  it("サロゲートペアを壊さない", () => {
    const result = truncateLabel("🎯🎲🎰🎪", 25, measure);
    expect(result).toBe("🎯…");
  });
});
