// アイコンの雰囲気を馬の毛色に足すため、アイコンから目立つ色を 2 つ選ぶ

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** 色相 12 段 × 明暗 2 段。水色と青のように色相が近くても明るさが違えば別の色として拾う */
const HUE_BINS = 12;
const BIN_COUNT = HUE_BINS * 2;
/** 彩度・明度がこれより低い画素（白・黒・灰色の背景や線）は数えない */
const MIN_SATURATION = 0.25;
const MIN_VALUE = 0.2;
/** 色のついた画素がこれより少ないアイコン（モノクロなど）は色を返さない */
const MIN_COLORED_SHARE = 0.04;
/** 2 色目がこれより弱ければ、1 色目の明るさ違いで代用する */
const MIN_SECOND_SHARE = 0.12;

const toHsv = (r: number, g: number, b: number) => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return { h: h / 6, s: max === 0 ? 0 : d / max, v: max / 255 };
};

const shade = (color: Rgb, factor: number): Rgb => ({
  r: Math.min(255, Math.round(color.r * factor)),
  g: Math.min(255, Math.round(color.g * factor)),
  b: Math.min(255, Math.round(color.b * factor)),
});

/**
 * RGBA の画素列から、鮮やかで面積の大きい色を 2 つ（多い順に）選ぶ。
 * 色のついた画素がほとんどないアイコンは null
 */
export const extractAvatarPalette = (pixels: ArrayLike<number>): [Rgb, Rgb] | null => {
  const bins = Array.from({ length: BIN_COUNT }, () => ({ weight: 0, r: 0, g: 0, b: 0 }));
  let pixelCount = 0;
  let coloredWeight = 0;
  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    pixelCount += 1;
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const { h, s, v } = toHsv(r, g, b);
    if (s < MIN_SATURATION || v < MIN_VALUE) continue;
    const weight = s * v;
    const bin = bins[Math.min(HUE_BINS - 1, Math.floor(h * HUE_BINS)) * 2 + (v > 0.6 ? 1 : 0)];
    bin.weight += weight;
    bin.r += r * weight;
    bin.g += g * weight;
    bin.b += b * weight;
    coloredWeight += weight;
  }
  if (pixelCount === 0 || coloredWeight < pixelCount * MIN_COLORED_SHARE) return null;
  const ranked = bins.filter((bin) => bin.weight > 0).sort((a, b) => b.weight - a.weight);
  const average = (bin: (typeof bins)[number]): Rgb => ({
    r: Math.round(bin.r / bin.weight),
    g: Math.round(bin.g / bin.weight),
    b: Math.round(bin.b / bin.weight),
  });
  const first = average(ranked[0]);
  const second = ranked[1];
  if (!second || second.weight < ranked[0].weight * MIN_SECOND_SHARE) {
    const isLight = toHsv(first.r, first.g, first.b).v > 0.6;
    return [first, shade(first, isLight ? 0.6 : 1.5)];
  }
  return [first, average(second)];
};
