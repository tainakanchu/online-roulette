import * as THREE from "three";

// 競馬場ターフビジョン（大型 LED 画面、幅 36 x 高さ 14 ワールド単位）用 LED モジュール詳細テクスチャ。
// 実物の大型 LED 画面は 0.5〜1m 角程度のモジュールを敷き詰めて構成されており、
// 近接時に見えるモジュール継ぎ目の細いスリット線や、モジュールごとの個体差による輝度・色味のわずかなムラ、
// およびドット抜け素子を表現する DataTexture (512x512 RGBA8) を手続き生成する。
//
// 画面 UV (0..1) に対し「画面のモジュール数 / modulesPerTile」を乗算してサンプリングする想定。
//
// 【各チャンネルの仕様（すべて 0..1）】
// - R: モジュールごとの明るさ補正係数。
//      平均 0.5、モジュール内は一様、モジュールごとに +-0.06 程度ばらつく（シェーダー側で 0.88〜1.12 倍に換算）。
//      隣接モジュール間の極端な段差を防ぐため、画面全体に広がる周期的な低周波ムラと、
//      モジュール単位の小さな個体差乱数を加算合成している。
// - G: モジュール継ぎ目のマスク。
//      モジュール境界の 1〜2 ピクセル幅のスリット線で 1、それ以外は 0。線の縁は 1 ピクセルでなめらかに減衰する。
// - B: モジュールごとの色味のずれ。
//      0.5 が無補正、0..1 でわずかに赤寄り〜青寄り（シェーダー側で +-3% 程度の色温度ずれに換算）。
//      モジュール内は一様。
// - A: 輝度低下素子（ドット抜け・くすみ）およびベゼル近傍の減光マスク。
//      通常素子は 1.0、稀（全ピクセルの約 0.15%）に 0.3〜0.7 の暗い点欠陥素子が点在する。
//      さらに全体の約 1 割のモジュールにおいて、端の 1 列がわずかに暗い（0.92）個体を再現する。

const TEXTURE_SIZE = 512;
const MODULES_PER_TILE = 16;
const MODULE_PIXELS = TEXTURE_SIZE / MODULES_PER_TILE; // 32 ピクセル
const MODULE_COUNT = MODULES_PER_TILE * MODULES_PER_TILE; // 256 モジュール
const TOTAL_PIXELS = TEXTURE_SIZE * TEXTURE_SIZE;

export interface LedModuleDetail {
  texture: THREE.DataTexture;
  /** テクスチャ 1 枚に並ぶモジュールの数(縦横とも) */
  modulesPerTile: number;
  dispose: () => void;
}

/**
 * 種から決まる決定的な乱数（mulberry32）。
 *
 * 【どう実現しているか】
 * 32bit 整数演算を用いたビットシフトと乗算により、決定的かつ均一な擬似乱数列を生成する。
 *
 * 【なぜ他の方法を採らなかったか】
 * Math.random() では実行環境や呼び出し順序によってテクスチャ内容が変わり、
 * テクスチャの再現性やビルド間の視覚的一貫性が失われてしまうため。
 */
const seededRandom = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const wrap = (i: number, period: number) => ((i % period) + period) % period;
const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * 周期境界（トーラス）を持つ 2D バリューノイズをサンプリングする関数を作成する。
 *
 * 【どう実現しているか】
 * 指定格子サイズのランダムテーブルを生成し、周囲 4 点の格子値をエルミート補間でバイリニア補間する。
 *
 * 【なぜ他の方法を採らなかったか】
 * 非周期的なノイズ関数ではテクスチャ端（U=0 と U=1、V=0 と V=1）で不連続な継ぎ目が発生してしまうが、
 * 格子参照時に wrap 演算を施すことで、テクスチャを RepeatWrapping でタイリングした際にも完全な連続性を保証できるため。
 */
const createPeriodicNoise2D = (
  gridX: number,
  gridY: number,
  random: () => number
): ((u: number, v: number) => number) => {
  const lattice = Float32Array.from({ length: gridX * gridY }, () => random());
  const at = (gx: number, gy: number) =>
    lattice[wrap(gy, gridY) * gridX + wrap(gx, gridX)];

  return (u: number, v: number): number => {
    const wx = u * gridX;
    const wy = v * gridY;
    const xi = Math.floor(wx);
    const yi = Math.floor(wy);
    const fx = smooth(wx - xi);
    const fy = smooth(wy - yi);

    const v00 = at(xi, yi);
    const v10 = at(xi + 1, yi);
    const v01 = at(xi, yi + 1);
    const v11 = at(xi + 1, yi + 1);

    const x0 = lerp(v00, v10, fx);
    const x1 = lerp(v01, v11, fx);
    return lerp(x0, x1, fy);
  };
};

/**
 * モジュール境界の継ぎ目減衰テーブル（32 要素）を作成する。
 *
 * 【どう実現しているか】
 * 境界中心（インデックス 0）を 1.0 とし、その両隣（インデックス 1 および 31）を 0.5 としてなめらかに落とし、
 * それ以外の内部ピクセルを 0.0 とする 1 次元ルックアップテーブルを作成する。
 *
 * 【なぜ他の方法を採らなかったか】
 * 26 万ピクセルのループ内部で距離関数や条件分岐を毎回評価すると不要なオーバーヘッドが生じるため、
 * モジュール内座標（0..31）から直接強度を参照できる事前テーブル化を採用した。
 */
const createEdgeLut = (): Float32Array => {
  const lut = new Float32Array(MODULE_PIXELS);
  lut[0] = 1.0;
  lut[1] = 0.5;
  lut[MODULE_PIXELS - 1] = 0.5;
  return lut;
};

/**
 * 競馬場ターフビジョン用の LED モジュール詳細テクスチャを生成する。
 *
 * 【どう実現しているか】
 * - 乱数シードを固定し、モジュール単位（16x16）の明暗・色味・減光端テーブルを事前生成。
 * - 各モジュールの R 値および B 値は平均 0.5 に厳密補正し、モジュール内は均一値とする。
 * - ピクセルループでは事前計算テーブルと継ぎ目 LUT を組み合わせて RGBA8 バッファを一括構築する。
 */
export const createLedModuleDetail = (): LedModuleDetail => {
  const random = seededRandom(0x51ed0001);

  // --- R チャンネル用：低周波ムラ（4x4 周期格子）とモジュール固有ばらつき ---
  const noiseR = createPeriodicNoise2D(4, 4, random);
  const moduleR = new Float32Array(MODULE_COUNT);
  let sumR = 0;
  for (let my = 0; my < MODULES_PER_TILE; my += 1) {
    for (let mx = 0; mx < MODULES_PER_TILE; mx += 1) {
      const u = (mx + 0.5) / MODULES_PER_TILE;
      const v = (my + 0.5) / MODULES_PER_TILE;
      const lowFreq = noiseR(u, v) - 0.5; // [-0.5, 0.5]
      const localVariation = random() - 0.5; // [-0.5, 0.5]
      const val = 0.5 + lowFreq * 0.07 + localVariation * 0.05; // 0.5 +- 0.06 程度
      const mIdx = my * MODULES_PER_TILE + mx;
      moduleR[mIdx] = val;
      sumR += val;
    }
  }
  // 全体平均を正確に 0.5 にシフト補正
  const offsetR = sumR / MODULE_COUNT - 0.5;
  for (let i = 0; i < MODULE_COUNT; i += 1) {
    moduleR[i] = Math.max(0, Math.min(1, moduleR[i] - offsetR));
  }

  // --- B チャンネル用：低周波色ムラ（2x2 周期格子）とモジュール固有色温度差 ---
  const noiseB = createPeriodicNoise2D(2, 2, random);
  const moduleB = new Float32Array(MODULE_COUNT);
  let sumB = 0;
  for (let my = 0; my < MODULES_PER_TILE; my += 1) {
    for (let mx = 0; mx < MODULES_PER_TILE; mx += 1) {
      const u = (mx + 0.5) / MODULES_PER_TILE;
      const v = (my + 0.5) / MODULES_PER_TILE;
      const lowFreq = noiseB(u, v) - 0.5;
      const localVariation = random() - 0.5;
      const val = 0.5 + lowFreq * 0.06 + localVariation * 0.1;
      const mIdx = my * MODULES_PER_TILE + mx;
      moduleB[mIdx] = val;
      sumB += val;
    }
  }
  // 全体平均を正確に 0.5 にシフト補正
  const offsetB = sumB / MODULE_COUNT - 0.5;
  for (let i = 0; i < MODULE_COUNT; i += 1) {
    moduleB[i] = Math.max(0, Math.min(1, moduleB[i] - offsetB));
  }

  // --- A チャンネル用：モジュールの端 1 列が減光（0.92）するモジュール（全体の約 1 割） ---
  // -1: 減光なし, 0: 上(py=0), 1: 下(py=31), 2: 左(px=0), 3: 右(px=31)
  const moduleDimEdge = new Int8Array(MODULE_COUNT);
  moduleDimEdge.fill(-1);

  // 256 個のインデックスから 1 割（26 個）を Fisher-Yates シャッフルで選出
  const moduleIndices = Array.from({ length: MODULE_COUNT }, (_, i) => i);
  const dimModuleCount = Math.round(MODULE_COUNT * 0.1);
  for (let i = 0; i < dimModuleCount; i += 1) {
    const swapTarget = i + Math.floor(random() * (MODULE_COUNT - i));
    const selectedModule = moduleIndices[swapTarget];
    moduleIndices[swapTarget] = moduleIndices[i];
    moduleIndices[i] = selectedModule;

    // 減光する辺を 4 辺から均等に 1 つ決定
    const edgeDirection = Math.floor(random() * 4);
    moduleDimEdge[selectedModule] = edgeDirection;
  }

  // G チャンネル用継ぎ目 LUT
  const edgeLut = createEdgeLut();

  // --- テクスチャバッファの生成（512x512 RGBA8） ---
  const data = new Uint8Array(TOTAL_PIXELS * 4);

  for (let y = 0; y < TEXTURE_SIZE; y += 1) {
    const my = Math.floor(y / MODULE_PIXELS);
    const py = y % MODULE_PIXELS;
    const yOffset = y * TEXTURE_SIZE;

    for (let x = 0; x < TEXTURE_SIZE; x += 1) {
      const mx = Math.floor(x / MODULE_PIXELS);
      const px = x % MODULE_PIXELS;
      const mIdx = my * MODULES_PER_TILE + mx;
      const pixelIdx = (yOffset + x) * 4;

      // R: モジュール単位の明暗（モジュール内一様）
      const rVal = moduleR[mIdx];

      // G: モジュール境界の継ぎ目スリット
      const gVal = Math.max(edgeLut[px], edgeLut[py]);

      // B: モジュール単位の色味のずれ（モジュール内一様）
      const bVal = moduleB[mIdx];

      // A: 素子の健全度マスク（基本 1.0、端列減光 0.92、欠陥ドット 0.3〜0.7）
      let aVal = 1.0;

      const dimEdge = moduleDimEdge[mIdx];
      const isDimTop = dimEdge === 0 && py === 0;
      const isDimBottom = dimEdge === 1 && py === MODULE_PIXELS - 1;
      const isDimLeft = dimEdge === 2 && px === 0;
      const isDimRight = dimEdge === 3 && px === MODULE_PIXELS - 1;
      const isDimEdgePixel = isDimTop || isDimBottom || isDimLeft || isDimRight;
      if (isDimEdgePixel) {
        aVal = 0.92;
      }

      // 全ピクセルの 0.15% 程度に小さな欠陥素子（ドット抜け・くすみ）
      const isDefectivePixel = random() < 0.0015;
      if (isDefectivePixel) {
        aVal = 0.3 + random() * 0.4;
      }

      data[pixelIdx] = Math.round(rVal * 255);
      data[pixelIdx + 1] = Math.round(gVal * 255);
      data[pixelIdx + 2] = Math.round(bVal * 255);
      data[pixelIdx + 3] = Math.round(aVal * 255);
    }
  }

  const texture = new THREE.DataTexture(data, TEXTURE_SIZE, TEXTURE_SIZE);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;

  return {
    texture,
    modulesPerTile: MODULES_PER_TILE,
    dispose: () => {
      texture.dispose();
    },
  };
};
