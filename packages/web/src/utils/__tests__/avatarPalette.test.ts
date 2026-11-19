import { extractAvatarPalette } from "../avatarPalette";

/** [r, g, b, 画素数] の組から RGBA の画素列を作る */
const pixels = (...groups: Array<[number, number, number, number]>) =>
  Uint8ClampedArray.from(groups.flatMap(([r, g, b, count]) => Array.from({ length: count }, () => [r, g, b, 255]).flat()));

describe("extractAvatarPalette", () => {
  it("面積の大きい鮮やかな色から順に 2 色を選び、白や黒の背景は数えない", () => {
    const palette = extractAvatarPalette(
      pixels([255, 255, 255, 500], [0, 0, 0, 200], [154, 214, 236, 200], [49, 68, 124, 100])
    );
    expect(palette).toEqual([
      { r: 154, g: 214, b: 236 },
      { r: 49, g: 68, b: 124 },
    ]);
  });

  it("色相が近くても明るさが違えば別の色として拾う（水色と紺）", () => {
    const palette = extractAvatarPalette(pixels([120, 200, 240, 100], [20, 50, 120, 80]));
    expect(palette?.[0]).toEqual({ r: 120, g: 200, b: 240 });
    expect(palette?.[1]).toEqual({ r: 20, g: 50, b: 120 });
  });

  it("色が 1 つしかなければ、2 色目はその明るさ違いにする", () => {
    const palette = extractAvatarPalette(pixels([255, 255, 255, 100], [200, 40, 40, 100]));
    expect(palette).toEqual([
      { r: 200, g: 40, b: 40 },
      { r: 120, g: 24, b: 24 },
    ]);
  });

  it("色のついた画素がほとんどないアイコン（モノクロ）は null", () => {
    expect(extractAvatarPalette(pixels([255, 255, 255, 300], [20, 20, 20, 300], [128, 128, 128, 100]))).toBeNull();
    expect(extractAvatarPalette(pixels([255, 255, 255, 1000], [200, 40, 40, 5]))).toBeNull();
  });

  it("透明な画素は数えない", () => {
    const transparent = Uint8ClampedArray.from([200, 40, 40, 0, 200, 40, 40, 0]);
    expect(extractAvatarPalette(transparent)).toBeNull();
  });
});
