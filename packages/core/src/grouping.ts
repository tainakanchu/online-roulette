import { cryptoRandom } from "./roulette";
import { shuffleArray } from "./shuffle";

/** グループ分け結果の1グループ */
export interface GroupResult {
  /** グループのラベル (e.g., "Group 1", "Aries ♈", "Fire 🔥") */
  label: string;
  /** 表示用のHexカラー */
  color: string;
  /** このグループに割り当てられたメンバー */
  items: string[];
}

/** 利用可能なグループ分けテーマ */
export type GroupingMethod = "random" | "zodiac" | "element" | "color";

interface GroupMeta {
  label: string;
  color: string;
}

interface GroupingCriteria {
  getGroupMeta(count: number): GroupMeta[];
}

const ZODIAC_SIGNS: GroupMeta[] = [
  { label: "Aries ♈", color: "#FF6B6B" },
  { label: "Taurus ♉", color: "#98FB98" },
  { label: "Gemini ♊", color: "#FFD700" },
  { label: "Cancer ♋", color: "#87CEEB" },
  { label: "Leo ♌", color: "#FFA500" },
  { label: "Virgo ♍", color: "#90EE90" },
  { label: "Libra ♎", color: "#E6E6FA" },
  { label: "Scorpio ♏", color: "#FF4D4D" },
  { label: "Sagittarius ♐", color: "#DA70D6" },
  { label: "Capricorn ♑", color: "#40E0D0" },
  { label: "Aquarius ♒", color: "#4169E1" },
  { label: "Pisces ♓", color: "#48D1CC" },
];

const ELEMENTS: GroupMeta[] = [
  { label: "Fire 🔥", color: "#FF6B6B" },
  { label: "Water 💧", color: "#4169E1" },
  { label: "Earth 🌍", color: "#8B6914" },
  { label: "Wind 🌪️", color: "#87CEEB" },
  { label: "Lightning ⚡", color: "#FFD700" },
  { label: "Ice ❄️", color: "#B0E0E6" },
];

const COLOR_TEAMS: GroupMeta[] = [
  { label: "Red Team 🔴", color: "#FF6B6B" },
  { label: "Blue Team 🔵", color: "#4169E1" },
  { label: "Green Team 🟢", color: "#2E8B57" },
  { label: "Yellow Team 🟡", color: "#DAA520" },
  { label: "Purple Team 🟣", color: "#9370DB" },
  { label: "Orange Team 🟠", color: "#FF8C00" },
];

const DEFAULT_GROUP_COLORS = [
  "#FF6B6B",
  "#4169E1",
  "#2E8B57",
  "#DAA520",
  "#9370DB",
  "#FF8C00",
  "#40E0D0",
  "#FF69B4",
  "#87CEEB",
  "#32CD32",
  "#E6E6FA",
  "#FF4D4D",
];

function createThemedCriteria(themes: GroupMeta[]): GroupingCriteria {
  return {
    getGroupMeta(count: number): GroupMeta[] {
      const shuffled = shuffleArray(themes);
      if (count <= themes.length) {
        return shuffled.slice(0, count);
      }
      // テーマ数を超える場合はサイクルして番号を付与
      const result: GroupMeta[] = [];
      for (let i = 0; i < count; i++) {
        const base = themes[i % themes.length];
        result.push(
          i < themes.length
            ? shuffled[i]
            : { label: `${base.label} (${Math.floor(i / themes.length) + 1})`, color: base.color }
        );
      }
      return result;
    },
  };
}

const GROUPING_CRITERIA: Record<GroupingMethod, GroupingCriteria> = {
  random: {
    getGroupMeta(count: number): GroupMeta[] {
      return Array.from({ length: count }, (_, i) => ({
        label: `Group ${i + 1}`,
        color: DEFAULT_GROUP_COLORS[i % DEFAULT_GROUP_COLORS.length],
      }));
    },
  },
  zodiac: createThemedCriteria(ZODIAC_SIGNS),
  element: createThemedCriteria(ELEMENTS),
  color: createThemedCriteria(COLOR_TEAMS),
};

/**
 * アイテムをN個のグループにランダムに分ける。
 *
 * 各アイテムにランダムスコアを割り当て、ソートし、上から順にグループに分配する。
 * 端数は先頭グループから順に1つずつ追加される（例: 7人→3グループ = 3,2,2）。
 */
export function divideIntoGroups(
  items: string[],
  groupCount: number,
  method: GroupingMethod = "random",
  random: () => number = cryptoRandom,
): GroupResult[] {
  if (groupCount < 2) throw new Error("groupCount must be >= 2");
  if (groupCount > items.length)
    throw new Error("groupCount must be <= items.length");

  // ランダムスコアを割り当ててソート
  const scored = items.map((item) => ({ item, score: random() }));
  scored.sort((a, b) => a.score - b.score);

  // グループメタデータ（ラベル、色）を取得
  const criteria = GROUPING_CRITERIA[method];
  const groupMeta = criteria.getGroupMeta(groupCount);

  // グループ初期化
  const groups: GroupResult[] = groupMeta.map((meta) => ({
    ...meta,
    items: [],
  }));

  // 上から順にグループに分配
  const baseSize = Math.floor(items.length / groupCount);
  const remainder = items.length % groupCount;
  let idx = 0;
  for (let g = 0; g < groupCount; g++) {
    const size = baseSize + (g < remainder ? 1 : 0);
    for (let j = 0; j < size; j++) {
      groups[g].items.push(scored[idx].item);
      idx++;
    }
  }

  return groups;
}

/** 利用可能なグループ分けテーマの一覧 */
export const GROUPING_METHODS: GroupingMethod[] = [
  "random",
  "zodiac",
  "element",
  "color",
];

/** 文字列がGroupingMethodかどうかを判定 */
export function isValidGroupingMethod(
  method: string,
): method is GroupingMethod {
  return (GROUPING_METHODS as string[]).includes(method);
}
