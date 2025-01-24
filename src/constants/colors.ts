export const COLORS = [
  // 色相環に沿って循環的に配置
  "#FF6B6B", // 赤
  "#FFB6C1", // ピンク
  "#FFA500", // オレンジ
  "#FFD700", // 黄色
  "#98FB98", // 緑
  "#40E0D0", // 青緑
  "#87CEEB", // 青
  "#E6E6FA", // 紫
  "#FFE5D9", // パステル

  "#FF8B94", // 赤
  "#FFC0CB", // ピンク
  "#FF9F45", // オレンジ
  "#FFD93D", // 黄色
  "#90EE90", // 緑
  "#48D1CC", // 青緑
  "#87CEFA", // 青
  "#D8BFD8", // 紫
  "#FED7C3", // パステル

  "#FF9AA2", // 赤
  "#FFB5C5", // ピンク
  "#FF9933", // オレンジ
  "#FFDB58", // 黄色
  "#32CD32", // 緑
  "#00CED1", // 青緑
  "#00BFFF", // 青
  "#DDA0DD", // 紫
  "#F9DCC4", // パステル

  "#FFB7B2", // 赤
  "#FF69B4", // ピンク
  "#FF8C00", // オレンジ
  "#FFE87C", // 黄色
  "#3CB371", // 緑
  "#20B2AA", // 青緑
  "#1E90FF", // 青
  "#DA70D6", // 紫
  "#FEC89A", // パステル

  "#FFB6B9", // 赤
  "#FF1493", // ピンク
  "#FF7F00", // オレンジ
  "#FFF68F", // 黄色
  "#2E8B57", // 緑
  "#008B8B", // 青緑
  "#4169E1", // 青
  "#BA55D3", // 紫
  "#FFEEAD", // パステル

  "#FF9A76", // 赤
  "#DB7093", // ピンク
  "#FF6F00", // オレンジ
  "#FFFACD", // 黄色
  "#228B22", // 緑
  "#008080", // 青緑
  "#0000FF", // 青
  "#9370DB", // 紫
  "#E2F0CB", // パステル

  "#FF7B7B", // 赤
  "#FFA07A", // ピンク
  "#FFC04C", // オレンジ
  "#F0E68C", // 黄色
  "#008000", // 緑
  "#45B7D1", // 青緑
  "#0000CD", // 青
  "#8A2BE2", // 紫
  "#B5EAD7", // パステル

  "#FF6B8B", // 赤
  "#FF8C69", // ピンク
  "#FFB347", // オレンジ
  "#EEE8AA", // 黄色
  "#006400", // 緑
  "#4ECDC4", // 青緑
  "#00008B", // 青
  "#9400D3", // 紫
  "#C7CEEA", // パステル

  "#FF5C5C", // 赤
  "#FF7F50", // ピンク
  "#FFA647", // オレンジ
  "#FFE4B5", // 黄色
  "#9ACD32", // 緑
  "#96CEB4", // 青緑
  "#000080", // 青
  "#9932CC", // 紫
  "#E0BBE4", // パステル

  "#FF4D4D", // 赤
  "#FF6347", // ピンク
  "#FF9B47", // オレンジ
  "#FFDAB9", // 黄色
  "#6B8E23", // 緑
  "#88D8B0", // 青緑
  "#191970", // 青
  "#8B008B", // 紫
  "#957DAD", // パステル

  "#FF3E3E", // 赤
  "#FF4500", // ピンク
  "#FF8F47", // オレンジ
  "#FFE4C4", // 黄色
  "#556B2F", // 緑
  "#67E0A3", // 青緑
  "#6495ED", // 青
  "#800080", // 紫
  "#D4A5A5", // パステル

  "#FF2F2F", // 赤
  "#FF8066", // ピンク
  "#FF8347", // オレンジ
  "#FFF8DC", // 黄色
  "#66CDAA", // 緑
  "#9ED2C6", // 青緑
  "#4682B4", // 青
  "#4B0082", // 紫
  "#FFC75F", // パステル
];

// 色の明るさを計算する関数
export const getColorBrightness = (hexColor: string): number => {
  const rgb = hexColor.replace("#", "").match(/.{2}/g);
  if (!rgb) return 0;

  const r = parseInt(rgb[0], 16);
  const g = parseInt(rgb[1], 16);
  const b = parseInt(rgb[2], 16);

  return (r * 299 + g * 587 + b * 114) / 1000;
};
