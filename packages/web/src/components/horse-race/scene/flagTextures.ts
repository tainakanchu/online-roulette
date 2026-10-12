import * as THREE from "three";

// 競馬場発走委員が振る赤い旗（StarterFlag）用の手続き生成テクスチャ。
// 旗はワールド単位で 0.9 × 0.6 の長方形布地（アスペクト比 1.5:1）。
// UV 座標は竿側（固定側）が u = 0、先端（はためく側）が u = 1、下端が v = 0、上端が v = 1。
//
// 本モジュールは以下の 2 枚のテクスチャを生成してまとめた FlagCloth を提供する:
// 1. map (CanvasTexture, 512 x 352, sRGB):
//    - 鮮やかな競馬用赤布（ベース #cb141b〜#d0161c）。
//    - 竿側（u = 0〜0.06）に竿を通す袋縫い（スリーブ）の濃い赤帯と点線ステッチ。
//    - 外周三辺（上・下・先端）に三つ折りヘム（細い濃い赤の折り返し縁）と点線ステッチ。
//    - 先端側（u = 1 寄り）の紫外線・風雨による微弱な退色グラデーション。
//    - 下端寄り（v = 0 寄り）および旗竿金具近傍のうっすらとした経年埃・土煙汚れ。
//    - Canvas 2D による布目（経糸・緯糸）の規則的な明暗パターン。
// 2. detail (DataTexture, 256 x 256, RGBA8, Linear/データ):
//    - R: 布目（平織り構造）の微細な凹凸高さ。平均 0.5、振幅 ±0.15。
//    - G: 生地の厚み・段差の高さ。通常布面は 0.5、二重・三重に重なる縁・袋縫い帯で 0.8。
//    - B: 逆光時の光の透け具合（透過度）。布地単層は 0.8、重なった縁・袋縫い帯は 0.35。
//    - A: 1.0 (255 固定)。
//    ※ DataTexture は flipY = false でサンプリングされるため、行 0 が v = 0（下端）となるよう配置。

export interface FlagCloth {
  /** 色（sRGB の CanvasTexture） */
  map: THREE.CanvasTexture;
  /** 布の凹凸と透け具合（データ。DataTexture） */
  detail: THREE.DataTexture;
  dispose: () => void;
}

const MAP_WIDTH = 512;
const MAP_HEIGHT = 352;
const DETAIL_SIZE = 256;

/** 袋縫い（竿を通すスリーブ帯）の幅（UV 比率: 6%） */
const SLEEVE_U_RATIO = 0.06;
/** 外周三つ折りヘム（上・下・先端）の幅（UV 比率: 2.5%） */
const HEM_U_RATIO = 0.025;
const HEM_V_RATIO = 0.035;

/**
 * 2D Canvas 要素とそのコンテキストを初期化して返す。
 *
 * 【どう実現しているか】
 * document.createElement("canvas") で DOM ツリーに追加しないオフスクリーン Canvas を作成する。
 *
 * 【なぜ他の方法を採らなかったか】
 * OffscreenCanvas は一部のブラウザ環境や three.js の旧バージョンで CanvasTexture との互換性問題が生じることがあるため、
 * 最も安全かつ確実な HTMLCanvasElement を採用している。
 */
const makeCanvas = (width: number, height: number) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2D canvas not available");
  }
  return { canvas, ctx };
};

/**
 * 種から決まる決定的な擬似乱数生成器（mulberry32）。
 *
 * 【どう実現しているか】
 * 32bit 整数演算によるビットシフトと乗算で、毎回同一シード値から完全に一致する乱数列を生成する。
 *
 * 【なぜ他の方法を採らなかったか】
 * Math.random() は実行ごとに異なる結果を返し、テクスチャの再現性やビルド間での視覚的一貫性が失われるため。
 */
const seededRandom = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * 旗のカラーテクスチャ（CanvasTexture）を生成する。
 *
 * 【どう実現しているか】
 * 1. 赤いベース色の上に、先端側の退色（白っぽく褪せる）と下端寄りの汚れ（砂埃色）のグラデーションを合成。
 * 2. 竿側スリーブ（袋縫い）と三辺の三つ折りヘムを濃い赤で塗り重ねる。
 * 3. 縫製ラインに沿って点線（破線）ストロークでステッチを描画。
 * 4. ピクセル単位で微細な布目の規則的ストライプとノイズを半透明オーバーレイして、実物の布らしい風合いを出す。
 */
const createFlagMapTexture = (): THREE.CanvasTexture => {
  const { canvas, ctx } = makeCanvas(MAP_WIDTH, MAP_HEIGHT);
  const random = seededRandom(0x464c4147); // "FLAG"

  // 1. 赤いベース布地
  ctx.fillStyle = "#cb141b";
  ctx.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);

  // 2. 先端側の退色グラデーション（竿側から先端にかけてわずかに明るく淡く褪せる）
  const fadeGrad = ctx.createLinearGradient(0, 0, MAP_WIDTH, 0);
  fadeGrad.addColorStop(0, "rgba(225, 45, 40, 0.0)");
  fadeGrad.addColorStop(0.5, "rgba(235, 55, 48, 0.05)");
  fadeGrad.addColorStop(1.0, "rgba(245, 80, 70, 0.16)");
  ctx.fillStyle = fadeGrad;
  ctx.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);

  // 3. 下端寄りの汚れグラデーション（地面の砂埃・巻き上げによるうっすらとしたくすみ）
  // Canvas の Y=MAP_HEIGHT が UV の v = 0（下端）に対応
  const dirtGrad = ctx.createLinearGradient(0, MAP_HEIGHT * 0.4, 0, MAP_HEIGHT);
  dirtGrad.addColorStop(0, "rgba(90, 65, 45, 0.0)");
  dirtGrad.addColorStop(0.7, "rgba(95, 70, 48, 0.06)");
  dirtGrad.addColorStop(1.0, "rgba(80, 55, 35, 0.14)");
  ctx.fillStyle = dirtGrad;
  ctx.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);

  // 4. 竿側袋縫い（スリーブ）と外周三つ折りヘム（厚みによる濃赤色）
  const sleevePx = Math.round(MAP_WIDTH * SLEEVE_U_RATIO);
  const hemRightPx = Math.round(MAP_WIDTH * HEM_U_RATIO);
  const hemTopPx = Math.round(MAP_HEIGHT * HEM_V_RATIO);
  const hemBottomPx = Math.round(MAP_HEIGHT * HEM_V_RATIO);

  ctx.fillStyle = "rgba(130, 8, 14, 0.45)";
  // 竿側袋縫い帯
  ctx.fillRect(0, 0, sleevePx, MAP_HEIGHT);
  // 上端ヘム
  ctx.fillRect(sleevePx, 0, MAP_WIDTH - sleevePx, hemTopPx);
  // 下端ヘム
  ctx.fillRect(sleevePx, MAP_HEIGHT - hemBottomPx, MAP_WIDTH - sleevePx, hemBottomPx);
  // 先端ヘム
  ctx.fillRect(MAP_WIDTH - hemRightPx, hemTopPx, hemRightPx, MAP_HEIGHT - hemTopPx - hemBottomPx);

  // 袋縫いの折り返し影ライン
  ctx.fillStyle = "rgba(70, 4, 8, 0.55)";
  ctx.fillRect(sleevePx - 1, 0, 2, MAP_HEIGHT);

  // 5. ステッチ（縫い目）の点線描画
  ctx.save();
  ctx.strokeStyle = "rgba(250, 180, 180, 0.75)";
  ctx.lineWidth = 1.2;
  ctx.setLineDash([3, 3]);

  // 袋縫いのステッチ（帯の境界のわずかに内側）
  const stitchSleeveX = sleevePx - 2;
  ctx.beginPath();
  ctx.moveTo(stitchSleeveX, 2);
  ctx.lineTo(stitchSleeveX, MAP_HEIGHT - 2);
  ctx.stroke();

  // 上端ステッチ
  const stitchTopY = hemTopPx - 2;
  ctx.beginPath();
  ctx.moveTo(sleevePx + 2, stitchTopY);
  ctx.lineTo(MAP_WIDTH - 2, stitchTopY);
  ctx.stroke();

  // 下端ステッチ
  const stitchBottomY = MAP_HEIGHT - hemBottomPx + 2;
  ctx.beginPath();
  ctx.moveTo(sleevePx + 2, stitchBottomY);
  ctx.lineTo(MAP_WIDTH - 2, stitchBottomY);
  ctx.stroke();

  // 先端ステッチ
  const stitchRightX = MAP_WIDTH - hemRightPx + 2;
  ctx.beginPath();
  ctx.moveTo(stitchRightX, hemTopPx + 2);
  ctx.lineTo(stitchRightX, MAP_HEIGHT - hemBottomPx - 2);
  ctx.stroke();
  ctx.restore();

  // 6. 布目（縦糸・横糸の規則的な織り目）と微細ノイズのオーバーレイ
  // ImageData を直接操作して高速（約 2〜4ms）に織り目パターンを乗算・加算合成する
  const imgData = ctx.getImageData(0, 0, MAP_WIDTH, MAP_HEIGHT);
  const pixels = imgData.data;

  for (let y = 0; y < MAP_HEIGHT; y += 1) {
    const yWeave = (y % 4 < 2 ? 1 : -1) * 3;
    const rowOffset = y * MAP_WIDTH * 4;

    for (let x = 0; x < MAP_WIDTH; x += 1) {
      const idx = rowOffset + x * 4;
      const xWeave = (x % 4 < 2 ? 1 : -1) * 3;
      const grain = (xWeave + yWeave) + Math.round((random() - 0.5) * 6);

      // RGB 各成分に織り目の微小明暗を加算（クリップ）
      pixels[idx] = Math.min(255, Math.max(0, pixels[idx] + grain));
      pixels[idx + 1] = Math.min(255, Math.max(0, pixels[idx + 1] + (grain >> 1)));
      pixels[idx + 2] = Math.min(255, Math.max(0, pixels[idx + 2] + (grain >> 1)));
    }
  }
  ctx.putImageData(imgData, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.needsUpdate = true;

  return texture;
};

/**
 * 布の凹凸と透け具合（DataTexture）を生成する。
 *
 * 【どう実現しているか】
 * - R: 平織り（1本ごとの交差）の幾何学的凹凸と微細乱数ノイズ。中心 0.5。
 * - G: 厚み高さ。通常布面は 0.5。袋縫い・縁は 0.8、ステッチ孔はわずかに凹ませる (0.42)。
 * - B: 透け具合（逆光時の透過係数）。布単層は 0.8、二重・三重の縁・袋縫いは 0.35。
 * - A: 1.0 (255)。
 *
 * 【なぜ他の方法を採らなかったか】
 * Canvas 2D からピクセルを読み出して DataTexture に変換する方法では、Canvas コンテキストの不要なオーバーヘッドや
 * 色空間の暗黙のガンマ補正が混入する危険がある。
 * 物理データマップは純粋な Float / Uint8 バッファ計算で直接構築する方が決定性・高速性・正確性の面で最も優れている。
 */
const createFlagDetailTexture = (): THREE.DataTexture => {
  const random = seededRandom(0x44455441); // "DETA"
  const buffer = new Uint8Array(DETAIL_SIZE * DETAIL_SIZE * 4);

  // ピクセル単位の UV 境界インデックス（DataTexture: 行 0 が v = 0 / 下端）
  const sleevePixels = Math.round(DETAIL_SIZE * SLEEVE_U_RATIO); // 約 15px
  const hemRightStart = Math.round(DETAIL_SIZE * (1.0 - HEM_U_RATIO)); // 約 249px
  const hemBottomPixels = Math.round(DETAIL_SIZE * HEM_V_RATIO); // 約 9px (v = 0 付近)
  const hemTopStart = Math.round(DETAIL_SIZE * (1.0 - HEM_V_RATIO)); // 約 247px (v = 1 付近)

  // ステッチ位置のインデックス
  const stitchSleeveX = sleevePixels - 1;
  const stitchRightX = hemRightStart + 1;
  const stitchBottomY = hemBottomPixels - 1;
  const stitchTopY = hemTopStart + 1;

  for (let y = 0; y < DETAIL_SIZE; y += 1) {
    const isHemV = y < hemBottomPixels || y >= hemTopStart;
    const rowOffset = y * DETAIL_SIZE * 4;

    for (let x = 0; x < DETAIL_SIZE; x += 1) {
      const idx = rowOffset + x * 4;
      const isSleeve = x < sleevePixels;
      const isHemU = x >= hemRightStart;
      const isEdge = isSleeve || isHemU || isHemV;

      // -----------------------------------------------------------------------
      // R: 布目の凹凸（平織り構造）。平均 0.5、振幅 ±0.15
      // -----------------------------------------------------------------------
      // 経糸と緯糸が交互に浮き沈みするチェッカー交差パターン
      const warp = (x & 1) === 0 ? 0.08 : -0.08;
      const weft = (y & 1) === 0 ? -0.08 : 0.08;
      const weave = warp + weft; // -0.16 〜 +0.16
      const jitter = (random() - 0.5) * 0.08;
      const rVal = Math.min(1.0, Math.max(0.0, 0.5 + weave + jitter));

      // -----------------------------------------------------------------------
      // G: 生地の厚み・段差の高さ
      // -----------------------------------------------------------------------
      let gVal = isEdge ? 0.8 : 0.5;

      // ステッチの縫い目（ミシン糸が布を締め付けてできる窪み）
      const isStitchX = (x === stitchSleeveX || x === stitchRightX) && (y % 4 < 2);
      const isStitchY = (y === stitchBottomY || y === stitchTopY) && (x % 4 < 2);
      if (isStitchX || isStitchY) {
        gVal = 0.42;
      }

      // -----------------------------------------------------------------------
      // B: 光にかざしたときの透け具合（逆光透過度）
      // -----------------------------------------------------------------------
      // 布単層は薄いため光がよく透ける (0.8)。重なった縁や袋縫いは厚みで遮光される (0.35)。
      // わずかな糸密度のランダムなムラを加える
      const bNoise = (random() - 0.5) * 0.04;
      const bVal = isEdge ? 0.35 + bNoise : 0.8 + bNoise;

      buffer[idx] = Math.round(rVal * 255);
      buffer[idx + 1] = Math.round(gVal * 255);
      buffer[idx + 2] = Math.round(Math.min(1.0, Math.max(0.0, bVal)) * 255);
      buffer[idx + 3] = 255;
    }
  }

  const texture = new THREE.DataTexture(buffer, DETAIL_SIZE, DETAIL_SIZE);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.colorSpace = THREE.NoColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;

  return texture;
};

/**
 * 競馬場発走委員の赤い旗（StarterFlag）用テクスチャセットを生成する。
 *
 * @returns map（CanvasTexture）と detail（DataTexture）および廃棄用 dispose 関数
 */
export const createFlagCloth = (): FlagCloth => {
  const map = createFlagMapTexture();
  const detail = createFlagDetailTexture();

  const dispose = () => {
    map.dispose();
    detail.dispose();
  };

  return { map, detail, dispose };
};
