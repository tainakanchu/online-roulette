import { divideIntoGroups, GROUPING_METHODS, isValidGroupingMethod } from "../src/grouping";
import type { GroupingMethod } from "../src/grouping";

describe("divideIntoGroups", () => {
  // 決定論的テスト用: 0.1, 0.2, 0.3... を返すランダム関数
  let callCount: number;
  const deterministicRandom = () => {
    callCount += 1;
    return callCount * 0.1;
  };

  beforeEach(() => {
    callCount = 0;
  });

  it("均等分割: 6人→3グループ = 2,2,2", () => {
    const items = ["A", "B", "C", "D", "E", "F"];
    const groups = divideIntoGroups(items, 3, "random", deterministicRandom);
    expect(groups).toHaveLength(3);
    expect(groups[0].items).toHaveLength(2);
    expect(groups[1].items).toHaveLength(2);
    expect(groups[2].items).toHaveLength(2);
    // 全員が割り当てられている
    const allItems = groups.flatMap((g) => g.items);
    expect(allItems.sort()).toEqual(items.sort());
  });

  it("端数分割: 7人→3グループ = 3,2,2", () => {
    const items = ["A", "B", "C", "D", "E", "F", "G"];
    const groups = divideIntoGroups(items, 3, "random", deterministicRandom);
    expect(groups).toHaveLength(3);
    expect(groups[0].items).toHaveLength(3);
    expect(groups[1].items).toHaveLength(2);
    expect(groups[2].items).toHaveLength(2);
    const allItems = groups.flatMap((g) => g.items);
    expect(allItems.sort()).toEqual(items.sort());
  });

  it("各人が1グループ: 3人→3グループ = 1,1,1", () => {
    const items = ["A", "B", "C"];
    const groups = divideIntoGroups(items, 3, "random", deterministicRandom);
    expect(groups).toHaveLength(3);
    groups.forEach((g) => expect(g.items).toHaveLength(1));
  });

  it("2グループ: 5人→2グループ = 3,2", () => {
    const items = ["A", "B", "C", "D", "E"];
    const groups = divideIntoGroups(items, 2, "random", deterministicRandom);
    expect(groups).toHaveLength(2);
    expect(groups[0].items).toHaveLength(3);
    expect(groups[1].items).toHaveLength(2);
  });

  it("randomテーマはGroup N形式のラベルを返す", () => {
    const items = ["A", "B", "C", "D"];
    const groups = divideIntoGroups(items, 2, "random", deterministicRandom);
    expect(groups[0].label).toBe("Group 1");
    expect(groups[1].label).toBe("Group 2");
  });

  it.each(["zodiac", "element", "color"] as GroupingMethod[])(
    "%s テーマはラベルと色を持つ",
    (method) => {
      const items = ["A", "B", "C", "D"];
      const groups = divideIntoGroups(items, 2, method, deterministicRandom);
      expect(groups).toHaveLength(2);
      groups.forEach((g) => {
        expect(g.label).toBeTruthy();
        expect(g.color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      });
    },
  );

  it("groupCount < 2 でエラー", () => {
    expect(() => divideIntoGroups(["A", "B"], 1)).toThrow(
      "groupCount must be >= 2",
    );
  });

  it("groupCount > items.length でエラー", () => {
    expect(() => divideIntoGroups(["A", "B"], 3)).toThrow(
      "groupCount must be <= items.length",
    );
  });
});

describe("isValidGroupingMethod", () => {
  it("有効なメソッドを判定", () => {
    for (const method of GROUPING_METHODS) {
      expect(isValidGroupingMethod(method)).toBe(true);
    }
  });

  it("無効なメソッドを拒否", () => {
    expect(isValidGroupingMethod("invalid")).toBe(false);
    expect(isValidGroupingMethod("")).toBe(false);
  });
});
