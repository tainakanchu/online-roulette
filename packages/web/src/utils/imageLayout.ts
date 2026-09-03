/**
 * 画像生成で使う純粋なレイアウト用ヘルパー。
 * キャンバスに依存しないため単体テストできる。
 */

/**
 * 幅に収まるようにラベルを省略記号付きで切り詰める（純粋関数）。
 * 文字幅の計測は呼び出し側から注入する（テスト・キャンバス非依存のため）。
 */
export const truncateLabel = (
  text: string,
  maxWidth: number,
  measure: (value: string) => number
): string => {
  if (maxWidth <= 0) return "";
  if (measure(text) <= maxWidth) return text;

  const ellipsis = "…";
  if (measure(ellipsis) > maxWidth) return "";

  const chars = Array.from(text);
  let truncated = "";
  for (let i = 0; i < chars.length; i += 1) {
    const candidate = truncated + chars[i];
    if (measure(candidate + ellipsis) > maxWidth) break;
    truncated = candidate;
  }

  return truncated + ellipsis;
};

/** バトル結果の1行分 */
export interface BattleRow {
  label: string;
  count: number;
  /** 元の選択肢配列でのインデックス（色の決定に使う） */
  index: number;
}

/**
 * 当選回数の多い順（同数は元の並び順）に並べ替える（純粋関数）。
 */
export const sortBattleRows = (
  options: string[],
  counts: number[]
): BattleRow[] =>
  options
    .map((label, index) => ({ label, count: counts[index] ?? 0, index }))
    .sort((a, b) => b.count - a.count || a.index - b.index);
