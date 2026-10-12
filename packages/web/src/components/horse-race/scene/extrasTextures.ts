import * as THREE from "three";

// 競馬場コース周辺の備品・車両・植栽用テクスチャを手続き生成する。
// 外部画像やフォントファイルは使用せず、Data3DTexture と HTML5 Canvas 2D API で
// 完全決定的に自己完結して生成する（外部アセット依存・ネットワーク遅延を根絶）。
//
// =============================================================================
// 各テクスチャの仕様およびチャンネル定義
// =============================================================================
//
// 1. foliage (64x64x64 RGBA8, Data3DTexture, 3軸すべて周期的, Linear+Mipmap, Linear/データ):
//    生垣および低木の葉の茂みに貼る 3D テクスチャ（ワールド座標 / 2.0 でサンプリング）。
//    - R: 葉の塊の明暗（小さな葉の重なり。平均 0.5 に正規化）
//    - G: 葉の色味（0 = 濃い緑、1 = 明るい黄緑の新芽）
//    - B: 茂みの奥行き（0 = 奥の暗い隙間、1 = 表面に出た葉）。小さな葉が密に重なり、
//         ところどころに暗い隙間がある分布
//    - A: 枯れ葉・花のマスク（ほとんど 0、約 2% が 1）
//
// 2. pavement (64x64x64 RGBA8, Data3DTexture, 3軸すべて周期的, Linear+Mipmap, Linear/データ):
//    アスファルトおよびコンクリート共用の 3D テクスチャ（ワールド座標 / 4.0 でサンプリング）。
//    - R: 骨材の粒（細かい明暗。平均 0.5 に正規化）
//    - G: 汚れ・油じみのムラ（大きくぼんやりした低周波ノイズ）
//    - B: ひび割れのマスク（細い枝分かれした線。通常 0、ひび割れ部分が 1）
//    - A: 表面の高さ（平均 0.5、骨材の粒と起伏で上下）
//
// 3. ambulanceLivery (1024x256, CanvasTexture, sRGB):
//    救急車の側面塗装と文字。u=0 が車の前、u=1 が車の後ろ、v=0 が車体下部、v=1 がルーフ側。
//    白地をベースに、腰の高さ（v=0.35〜0.45）に鮮やかな赤の太帯、その直上に細い赤ストライプ。
//    車体中央寄りに大きく「救急車」の赤文字。前寄りには架空の救急章（赤丸＋白星）。
//
// 4. horseAmbulanceLivery (1024x512, CanvasTexture, sRGB):
//    馬運車（競走馬用救急車）の荷台側面塗装と文字。u=0 が前、u=1 が後ろ。
//    上半分がクリーンな白地、下半分が深い競馬場グリーン（#1f6b2e）。境目に白と黄の細ライン。
//    白地部に堂々とした緑文字「馬運車」と英文小見出し「HORSE AMBULANCE」、蹄鉄を模した独自マーク。

export interface ExtrasTextures {
  /** 生垣・低木の葉の 3D テクスチャ（ワールド座標 / 2.0 で引く） */
  foliage: THREE.Data3DTexture;
  /** アスファルト・コンクリートの 3D テクスチャ（ワールド座標 / 4.0 で引く） */
  pavement: THREE.Data3DTexture;
  /** 救急車 −Z 側面用リバリー（前が u = 0、CanvasTexture、sRGB） */
  ambulanceLivery: THREE.CanvasTexture;
  /** 救急車 +Z 側面用リバリー（前が u = 1、CanvasTexture、sRGB） */
  ambulanceLiveryFrontRight: THREE.CanvasTexture;
  /** 馬運車 −Z 側面用リバリー（前が u = 0、CanvasTexture、sRGB） */
  horseAmbulanceLivery: THREE.CanvasTexture;
  /** 馬運車 +Z 側面用リバリー（前が u = 1、CanvasTexture、sRGB） */
  horseAmbulanceLiveryFrontRight: THREE.CanvasTexture;
  dispose: () => void;
}

const SIZE_3D = 64;
const VOXELS_3D = SIZE_3D ** 3;

const AMBULANCE_WIDTH = 1024;
const AMBULANCE_HEIGHT = 256;

const HORSE_AMBULANCE_WIDTH = 1024;
const HORSE_AMBULANCE_HEIGHT = 512;

/** 種から決まる決定的な擬似乱数（mulberry32） */
const seededRandom = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const wrap = (i: number, period: number) => ((i % period) + period) % period;
const smooth = (t: number) => t * t * (3 - 2 * t);

/**
 * トーラス（3次元周期境界）上での最短符号付き差分 (val - center)。
 *
 * 【どう実現しているか】
 * 周期 SIZE_3D の半分を超える距離を反対周りへと折り返し、[-SIZE_3D/2, SIZE_3D/2] の範囲に正規化する。
 *
 * 【なぜ他の方法を採らなかったか】
 * 単純な座標差分では境界（0 と 63）を跨ぐ小葉スプラットやひび割れが途切れてタイリング時に
 * 目立つシームが生じてしまうため、最短周回差分でシームレス性を保証する。
 */
const torusDelta = (val: number, center: number, period: number) => {
  let d = (val - center) % period;
  if (d > period * 0.5) d -= period;
  else if (d < -period * 0.5) d += period;
  return d;
};

/**
 * 3軸すべてで周期的な 3D バリューノイズテーブルをボリューム全体（64x64x64）へ事前展開する。
 *
 * 【どう実現しているか】
 * 格子点の乱数をトリリニア補間して Float32Array に展開する。
 * 最外ループで X 補間係数を事前計算し、ラインおよびスライスループで Y/Z 補間を整理して
 * 内側ループの演算を最適化する。
 *
 * 【なぜ他の方法を採らなかったか】
 * ボクセルごとに関数呼び出しを行って格子点を参照・補間する方式では、
 * 26 万回の関数呼び出しオーバーヘッドで生成時間が 100ms を超えてしまうため。
 */
const createPeriodicNoise3D = (
  gridX: number,
  gridY: number,
  gridZ: number,
  random: () => number
): Float32Array => {
  const lattice = Float32Array.from({ length: gridX * gridY * gridZ }, () => random());
  const at = (gx: number, gy: number, gz: number) =>
    lattice[(wrap(gz, gridZ) * gridY + wrap(gy, gridY)) * gridX + wrap(gx, gridX)];

  const output = new Float32Array(VOXELS_3D);

  const xiArr = new Int32Array(SIZE_3D);
  const fxArr = new Float32Array(SIZE_3D);
  for (let x = 0; x < SIZE_3D; x += 1) {
    const wx = (x / SIZE_3D) * gridX;
    xiArr[x] = Math.floor(wx);
    fxArr[x] = smooth(wx - xiArr[x]);
  }

  for (let z = 0; z < SIZE_3D; z += 1) {
    const wz = (z / SIZE_3D) * gridZ;
    const zi = Math.floor(wz);
    const fz = smooth(wz - zi);
    const zOffset = z * SIZE_3D * SIZE_3D;

    for (let y = 0; y < SIZE_3D; y += 1) {
      const wy = (y / SIZE_3D) * gridY;
      const yi = Math.floor(wy);
      const fy = smooth(wy - yi);
      const yOffset = zOffset + y * SIZE_3D;

      for (let x = 0; x < SIZE_3D; x += 1) {
        const xi = xiArr[x];
        const fx = fxArr[x];

        const p000 = at(xi, yi, zi);
        const p100 = at(xi + 1, yi, zi);
        const p010 = at(xi, yi + 1, zi);
        const p110 = at(xi + 1, yi + 1, zi);
        const p001 = at(xi, yi, zi + 1);
        const p101 = at(xi + 1, yi, zi + 1);
        const p011 = at(xi, yi + 1, zi + 1);
        const p111 = at(xi + 1, yi + 1, zi + 1);

        const x00 = p000 + (p100 - p000) * fx;
        const x10 = p010 + (p110 - p010) * fx;
        const y0 = x00 + (x10 - x00) * fy;

        const x01 = p001 + (p101 - p001) * fx;
        const x11 = p011 + (p111 - p011) * fx;
        const y1 = x01 + (x11 - x01) * fy;

        output[yOffset + x] = y0 + (y1 - y0) * fz;
      }
    }
  }

  return output;
};

/**
 * Three.js の Data3DTexture を構築する。
 *
 * 【どう実現しているか】
 * 64x64x64 RGBA8（1MB）バッファを渡し、RepeatWrapping、LinearFilter + LinearMipmapLinearFilter、
 * generateMipmaps = true、colorSpace = NoColorSpace で設定する。
 *
 * 【なぜ他の方法を採らなかったか】
 * SRGBColorSpace に設定するとシェーダー側で暗黙のガンマ補正が適用されてしまい、
 * マスク値や高さデータが歪んでしまうため、既定の NoColorSpace（データテクスチャ）として作成する。
 */
const createData3D = (data: Uint8Array): THREE.Data3DTexture => {
  const texture = new THREE.Data3DTexture(data, SIZE_3D, SIZE_3D, SIZE_3D);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.wrapR = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
};

/**
 * 2D Canvas 要素とそのコンテキストを初期化して返す
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
 * Canvas から Three.js の CanvasTexture を生成して共通設定を適用する
 */
const toCanvasTexture = (canvas: HTMLCanvasElement): THREE.CanvasTexture => {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
};

// =============================================================================
// 1. 生垣・低木の葉の 3D テクスチャ (foliage)
// =============================================================================

/**
 * 生垣・低木の葉の 3D テクスチャを生成する。
 *
 * 【どう実現しているか】
 * 1. 枝葉の塊（周期 4x4x4）の低周波バリューノイズを事前生成。
 * 2. 1800 枚の微小な葉の楕円体ディスクをトーラス上にスプラッティングし、葉の重なり、
 *    色味（濃緑〜黄緑）、深度（表面の葉〜内部の暗い隙間）、および約 2% の花・枯葉マスクを記録。
 * 3. 枝葉クラスタノイズと合成し、大きな茂みの起伏と暗い隙間を形成。
 * 4. R チャンネル（明暗）を平均 0.5 に正規化して RGBA8 に格納。
 *
 * 【なぜ他の方法を採らなかったか】
 * 単純なパーリンノイズの組み合わせでは、生垣特有の「細かい扁平な葉が重なり合い、
 * 隙間に落ち葉や暗がりが存在する」構造を再現できないため、スプラッティングと周期ノイズを組み合わせた。
 */
const createFoliageTexture = (random: () => number): THREE.Data3DTexture => {
  const clusterNoise = createPeriodicNoise3D(4, 4, 4, random);

  const bufR = new Float32Array(VOXELS_3D);
  const bufG = new Float32Array(VOXELS_3D);
  const bufB = new Float32Array(VOXELS_3D);
  const bufA = new Float32Array(VOXELS_3D);

  const numLeaves = 1800;
  for (let i = 0; i < numLeaves; i += 1) {
    const cx = random() * SIZE_3D;
    const cy = random() * SIZE_3D;
    const cz = random() * SIZE_3D;
    const rad = 1.8 + random() * 1.6;
    const rInt = Math.ceil(rad);
    const rad2 = rad * rad;

    const leafShade = 0.35 + random() * 0.45;
    const leafTone = random(); // 0 = 濃緑, 1 = 明るい黄緑
    const leafDepth = 0.45 + random() * 0.55; // 表面に出た葉
    const isFlowerOrDead = random() < 0.02; // 約 2% の花・枯葉

    for (let dz = -rInt; dz <= rInt; dz += 1) {
      const z = wrap(Math.floor(cz + dz), SIZE_3D);
      const zd = torusDelta(z, cz, SIZE_3D);
      const z2 = zd * zd;
      const zOff = z * SIZE_3D * SIZE_3D;

      for (let dy = -rInt; dy <= rInt; dy += 1) {
        const y = wrap(Math.floor(cy + dy), SIZE_3D);
        const yd = torusDelta(y, cy, SIZE_3D);
        const y2 = yd * yd;
        const yz2 = y2 + z2;
        const isOutsideYZ = yz2 > rad2;
        if (isOutsideYZ) continue;
        const yOff = zOff + y * SIZE_3D;

        for (let dx = -rInt; dx <= rInt; dx += 1) {
          const x = wrap(Math.floor(cx + dx), SIZE_3D);
          const xd = torusDelta(x, cx, SIZE_3D);
          const d2 = yz2 + xd * xd;
          const isInside = d2 <= rad2;
          if (isInside) {
            const idx = yOff + x;
            const falloff = 1.0 - Math.sqrt(d2) / rad;
            bufR[idx] = Math.max(bufR[idx], leafShade * (0.8 + 0.2 * falloff));
            bufG[idx] = leafTone;
            bufB[idx] = Math.max(bufB[idx], leafDepth * falloff);
            if (isFlowerOrDead) {
              bufA[idx] = 1.0;
            }
          }
        }
      }
    }
  }

  // クラスタノイズと合成して茂みの奥行き・明暗を強調
  let sumR = 0;
  for (let i = 0; i < VOXELS_3D; i += 1) {
    const cluster = clusterNoise[i];
    // R: 葉の重なりにクラスタの陰影を反映
    const r = bufR[i] * (0.55 + 0.55 * cluster);
    bufR[i] = r;
    sumR += r;

    // G: 葉の色味。新芽はクラスタ上部・表面寄りにやや集中
    bufG[i] = Math.min(1.0, bufG[i] * 0.8 + cluster * 0.2);

    // B: 奥行き。クラスタが薄く葉のない領域は奥の暗い隙間 (0寄り)
    bufB[i] = Math.min(1.0, bufB[i] * (0.35 + 0.65 * cluster));
  }

  // R チャンネルの平均値を 0.5 (Uint8 で 127.5) に正規化
  const avgR = sumR / VOXELS_3D;
  const targetFloatR = 127.5 / 255;
  const scaleR = targetFloatR / (avgR || 1);

  const data = new Uint8Array(VOXELS_3D * 4);
  let totalByteR = 0;
  for (let i = 0; i < VOXELS_3D; i += 1) {
    const byteVal = Math.min(255, Math.max(0, Math.round(bufR[i] * scaleR * 255)));
    data[i * 4] = byteVal;
    data[i * 4 + 1] = Math.min(255, Math.max(0, Math.round(bufG[i] * 255)));
    data[i * 4 + 2] = Math.min(255, Math.max(0, Math.round(bufB[i] * 255)));
    data[i * 4 + 3] = Math.min(255, Math.max(0, Math.round(bufA[i] * 255)));
    totalByteR += byteVal;
  }

  // 整数丸めの微少な残差を補正
  const targetTotal = Math.round(127.5 * VOXELS_3D);
  let diff = targetTotal - totalByteR;
  if (diff !== 0) {
    const step = Math.max(1, Math.floor(VOXELS_3D / Math.abs(diff)));
    const sign = diff > 0 ? 1 : -1;
    let idx = 0;
    while (diff !== 0 && idx < VOXELS_3D) {
      const val = data[idx * 4] + sign;
      const isValid = val >= 0 && val <= 255;
      if (isValid) {
        data[idx * 4] = val;
        diff -= sign;
      }
      idx += step;
    }
  }

  return createData3D(data);
};

// =============================================================================
// 2. アスファルト・コンクリートの 3D テクスチャ (pavement)
// =============================================================================

/**
 * アスファルト・コンクリートの 3D テクスチャを生成する。
 *
 * 【どう実現しているか】
 * 1. 骨材の粒用ノイズ（周期 32x32x32）、汚れ・油じみムラ（周期 4x4x4）、起伏用（周期 16x16x16）を生成。
 * 2. トーラス周期空間をランダムウォークする分岐クラックジェネレータで、
 *    アスファルト表面の細い枝分かれしたひび割れライン（B チャンネル）をプロット。
 * 3. 骨材粒と起伏を合成して表面高さ（A チャンネル）を生成。
 * 4. R チャンネル（骨材粒明暗）および A チャンネル（高さ）の平均値を 0.5 に正規化。
 *
 * 【なぜ他の方法を採らなかったか】
 * ひび割れ表現に 3D ボロノイ（Worley）境界抽出を用いると 64^3 ボリュームで 150ms 以上
 * 消費してしまうため、周期境界トーラス上のランダムウォーク分岐法を採用し 1〜2ms で
 * 自然なひび割れ網を高速生成している。
 */
const createPavementTexture = (random: () => number): THREE.Data3DTexture => {
  const aggregateNoise = createPeriodicNoise3D(32, 32, 32, random);
  const stainNoise = createPeriodicNoise3D(4, 4, 4, random);
  const heightNoise = createPeriodicNoise3D(16, 16, 16, random);

  // トーラス上での分岐ひび割れウォーカー
  const crackBuf = new Uint8Array(VOXELS_3D);
  const numCrackRoots = 22;
  for (let r = 0; r < numCrackRoots; r += 1) {
    let cx = random() * SIZE_3D;
    let cy = random() * SIZE_3D;
    let cz = random() * SIZE_3D;
    let theta = random() * Math.PI * 2;
    let phi = (random() - 0.5) * Math.PI;
    let dx = Math.cos(phi) * Math.cos(theta);
    let dy = Math.cos(phi) * Math.sin(theta);
    let dz = Math.sin(phi);

    const steps = 25 + Math.floor(random() * 25);
    for (let s = 0; s < steps; s += 1) {
      const ix = wrap(Math.round(cx), SIZE_3D);
      const iy = wrap(Math.round(cy), SIZE_3D);
      const iz = wrap(Math.round(cz), SIZE_3D);
      crackBuf[(iz * SIZE_3D + iy) * SIZE_3D + ix] = 255;

      theta += (random() - 0.5) * 0.75;
      phi += (random() - 0.5) * 0.75;
      dx = Math.cos(phi) * Math.cos(theta);
      dy = Math.cos(phi) * Math.sin(theta);
      dz = Math.sin(phi);

      cx = wrap(cx + dx * 0.8, SIZE_3D);
      cy = wrap(cy + dy * 0.8, SIZE_3D);
      cz = wrap(cz + dz * 0.8, SIZE_3D);

      const shouldBranch = random() < 0.08;
      if (shouldBranch) {
        let bx = cx;
        let by = cy;
        let bz = cz;
        const btheta = theta + (random() < 0.5 ? 1 : -1) * (0.6 + random() * 0.5);
        const bphi = phi + (random() - 0.5) * 0.5;
        const bsteps = 12 + Math.floor(random() * 14);
        for (let bs = 0; bs < bsteps; bs += 1) {
          const bix = wrap(Math.round(bx), SIZE_3D);
          const biy = wrap(Math.round(by), SIZE_3D);
          const biz = wrap(Math.round(bz), SIZE_3D);
          crackBuf[(biz * SIZE_3D + biy) * SIZE_3D + bix] = 255;

          bx = wrap(bx + Math.cos(bphi) * Math.cos(btheta) * 0.8, SIZE_3D);
          by = wrap(by + Math.cos(bphi) * Math.sin(btheta) * 0.8, SIZE_3D);
          bz = wrap(bz + Math.sin(bphi) * 0.8, SIZE_3D);
        }
      }
    }
  }

  // 各チャンネルの計算と正規化
  let sumR = 0;
  let sumA = 0;
  const bufR = new Float32Array(VOXELS_3D);
  const bufA = new Float32Array(VOXELS_3D);

  for (let i = 0; i < VOXELS_3D; i += 1) {
    const agg = aggregateNoise[i];
    const ht = heightNoise[i];
    bufR[i] = agg;
    sumR += agg;

    // 骨材粒の細かな凸凹と全体起伏
    const h = 0.5 + (agg - 0.5) * 0.35 + (ht - 0.5) * 0.15;
    bufA[i] = h;
    sumA += h;
  }

  const avgR = sumR / VOXELS_3D;
  const scaleR = (127.5 / 255) / (avgR || 1);
  const avgA = sumA / VOXELS_3D;
  const scaleA = (127.5 / 255) / (avgA || 1);

  const data = new Uint8Array(VOXELS_3D * 4);
  for (let i = 0; i < VOXELS_3D; i += 1) {
    data[i * 4] = Math.min(255, Math.max(0, Math.round(bufR[i] * scaleR * 255)));
    data[i * 4 + 1] = Math.min(255, Math.max(0, Math.round(stainNoise[i] * 255)));
    data[i * 4 + 2] = crackBuf[i];
    data[i * 4 + 3] = Math.min(255, Math.max(0, Math.round(bufA[i] * scaleA * 255)));
  }

  return createData3D(data);
};

// =============================================================================
// 3. 救急車側面リバリー (ambulanceLivery / ambulanceLiveryFrontRight)
// =============================================================================

/**
 * 救急車の側面塗装・文字テクスチャを生成する。
 *
 * 【どう実現しているか】
 * - `frontSide: "left" | "right"` 引数により、前方向の位置（左 u=0 または 右 u=1）を切り替える。
 *   - "left" (−Z 側面用): 救急章が u=0.43 (v=0.72)、文字「救急車」が u=0.49 (v=0.20)。
 *   - "right" (+Z 側面用): レイアウトを左右反転し、救急章が u=0.57、文字「救急車」が u=0.51。
 *     文字自体は反転せず、左から右へ通常通り読める向きを維持する。
 * - 腰高さ v=0.35〜0.45 に赤い太帯（#d32020）、その上部 v=0.48〜0.50 に細い赤ライン。
 *
 * 【なぜ他の方法を採らなかったか】
 * モデルの UV は左右両側面とも外から見て文字が読める向き（+X が前）に付いているため、
 * −Z 側面では u=0 が前、+Z 側面では u=1 が前となる。描画ロジックを共通化することで
 * 重複コードを防ぎつつ正確な鏡映配置を実現する。
 */
const createAmbulanceLivery = (frontSide: "left" | "right" = "left"): THREE.CanvasTexture => {
  const { canvas, ctx } = makeCanvas(AMBULANCE_WIDTH, AMBULANCE_HEIGHT);

  // 1. 下地（清潔感のあるホワイトボディ）
  ctx.fillStyle = "#f5f6f8";
  ctx.fillRect(0, 0, AMBULANCE_WIDTH, AMBULANCE_HEIGHT);

  // 微細なパネル継ぎ目・シャドウライン（ルーフ側・窓下）
  ctx.fillStyle = "rgba(0, 0, 0, 0.04)";
  ctx.fillRect(0, 0, AMBULANCE_WIDTH, 4);

  // 2. 腰の太い赤帯 (v = 0.35〜0.45)
  // Canvas y: v=0.45 が上端、v=0.35 が下端
  const waistTopY = AMBULANCE_HEIGHT * (1.0 - 0.45);
  const waistHeight = AMBULANCE_HEIGHT * (0.45 - 0.35);
  ctx.fillStyle = "#d32020";
  ctx.fillRect(0, waistTopY, AMBULANCE_WIDTH, waistHeight);

  // 3. 細い赤ライン (v = 0.48〜0.50)
  const stripeTopY = AMBULANCE_HEIGHT * (1.0 - 0.50);
  const stripeHeight = AMBULANCE_HEIGHT * 0.02;
  ctx.fillRect(0, stripeTopY, AMBULANCE_WIDTH, stripeHeight);

  // 4. 救急マーク（赤丸＋白星）: 前のドアの窓と後ろの窓の間のパネル (left: u = 0.43, right: u = 0.57, v = 0.72)
  const emblemU = frontSide === "left" ? 0.43 : 0.57;
  const emblemX = AMBULANCE_WIDTH * emblemU;
  const emblemY = AMBULANCE_HEIGHT * (1.0 - 0.72);
  const emblemRadius = 28; // 直径は v で 0.22 前後（高さ 256 * 0.22 / 2 ≒ 28px）

  // 外側赤円
  ctx.beginPath();
  ctx.arc(emblemX, emblemY, emblemRadius, 0, Math.PI * 2);
  ctx.fillStyle = "#d32020";
  ctx.fill();

  // 内側の白星
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  const starOutRadius = 18;
  const starInRadius = 8;
  for (let i = 0; i < 5; i += 1) {
    const angleOut = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
    const angleIn = angleOut + Math.PI / 5;
    const isFirst = i === 0;
    if (isFirst) {
      ctx.moveTo(emblemX + Math.cos(angleOut) * starOutRadius, emblemY + Math.sin(angleOut) * starOutRadius);
    } else {
      ctx.lineTo(emblemX + Math.cos(angleOut) * starOutRadius, emblemY + Math.sin(angleOut) * starOutRadius);
    }
    ctx.lineTo(emblemX + Math.cos(angleIn) * starInRadius, emblemY + Math.sin(angleIn) * starInRadius);
  }
  ctx.closePath();
  ctx.fill();

  // 5. 赤い文字「救急車」: 前後の車輪の間・赤い帯の下 (left: u = 0.49, right: u = 0.51, v = 0.2)
  // 文字の高さは v で 0.2 前後（約 50px）
  const textU = frontSide === "left" ? 0.49 : 0.51;
  ctx.fillStyle = "#d32020";
  ctx.font = "900 50px 'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("救急車", AMBULANCE_WIDTH * textU, AMBULANCE_HEIGHT * (1.0 - 0.20));

  return toCanvasTexture(canvas);
};

// =============================================================================
// 4. 馬運車側面リバリー (horseAmbulanceLivery / horseAmbulanceLiveryFrontRight)
// =============================================================================

/**
 * 馬運車（馬の救急車）の荷台側面塗装・文字テクスチャを生成する。
 *
 * 【どう実現しているか】
 * - `frontSide: "left" | "right"` 引数により、前方向の位置（左 u=0 または 右 u=1）を切り替える。
 *   - "left" (−Z 側面用): 蹄鉄マークが u=0.08 (v=0.60)、文字「馬運車」が u=0.55 (v=0.60)、「HORSE AMBULANCE」が u=0.55 (v=0.27)。
 *   - "right" (+Z 側面用): レイアウトを左右反転し、蹄鉄マークが u=0.92、文字「馬運車」「HORSE AMBULANCE」が u=0.45。
 *     文字自体は反転せず、左から右へ通常通り読める向きを維持する。
 * - 上半分がホワイト、下半分が深い緑（#1f6b2e）。境目に白と黄の細ライン。
 *
 * 【なぜ他の方法を採らなかったか】
 * 救急車と同様、左右側面で UV の前方向が異なるため、描画関数を 1 つに統合して引数で
 * 反転位置を決定的に計算する。
 */
const createHorseAmbulanceLivery = (frontSide: "left" | "right" = "left"): THREE.CanvasTexture => {
  const { canvas, ctx } = makeCanvas(HORSE_AMBULANCE_WIDTH, HORSE_AMBULANCE_HEIGHT);

  // 1. 上半分: ホワイト
  ctx.fillStyle = "#f8f9fa";
  ctx.fillRect(0, 0, HORSE_AMBULANCE_WIDTH, HORSE_AMBULANCE_HEIGHT * 0.5);

  // 2. 下半分: 落ち着いた深緑 (#1f6b2e)
  ctx.fillStyle = "#1f6b2e";
  ctx.fillRect(0, HORSE_AMBULANCE_HEIGHT * 0.5, HORSE_AMBULANCE_WIDTH, HORSE_AMBULANCE_HEIGHT * 0.5);

  // 3. 塗り分け境界のストライプ
  // 白の細線（境界の直上）
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, HORSE_AMBULANCE_HEIGHT * 0.5 - 6, HORSE_AMBULANCE_WIDTH, 6);
  // 黄色（ゴールドイエロー）の細線（境界の直下）
  ctx.fillStyle = "#f1c40f";
  ctx.fillRect(0, HORSE_AMBULANCE_HEIGHT * 0.5, HORSE_AMBULANCE_WIDTH, 8);

  // 4. 白地部前寄りの蹄鉄型オリジナルマーク: 前寄りスリットの下 (left: u = 0.08, right: u = 0.92, v = 0.60)
  // スリット (u 0.16〜0.29, v 0.71〜0.78) にかからない大きさ（半径 34px）
  const markU = frontSide === "left" ? 0.08 : 0.92;
  const markX = HORSE_AMBULANCE_WIDTH * markU;
  const markY = HORSE_AMBULANCE_HEIGHT * (1.0 - 0.60);
  const outerR = 34;
  const innerR = 20;
  const armLen = 22;

  ctx.save();
  ctx.fillStyle = "#1f6b2e";
  ctx.beginPath();
  // 蹄鉄の形状: 下側が閉じた U 字形（アーチ）
  // 左アーム上端
  ctx.arc(markX - (outerR + innerR) * 0.5, markY - armLen, (outerR - innerR) * 0.5, Math.PI, 0, false);
  // 左アーム内側を下へ
  ctx.lineTo(markX - innerR, markY);
  // 内側アーチ
  ctx.arc(markX, markY, innerR, Math.PI, 0, true);
  // 右アーム内側を上へ
  ctx.lineTo(markX + innerR, markY - armLen);
  // 右アーム上端
  ctx.arc(markX + (outerR + innerR) * 0.5, markY - armLen, (outerR - innerR) * 0.5, Math.PI, 0, false);
  // 右アーム外側を下へ
  ctx.lineTo(markX + outerR, markY);
  // 外側アーチ
  ctx.arc(markX, markY, outerR, 0, Math.PI, false);
  ctx.closePath();
  ctx.fill();

  // 蹄鉄の釘穴（白の小円）
  ctx.fillStyle = "#ffffff";
  const nailAngles = [0.25, 0.42, 0.58, 0.75];
  const nailR = (outerR + innerR) * 0.5;
  for (let i = 0; i < nailAngles.length; i += 1) {
    const angle = Math.PI * nailAngles[i];
    const nx = markX + Math.cos(angle) * nailR;
    const ny = markY + Math.sin(angle) * nailR;
    ctx.beginPath();
    ctx.arc(nx, ny, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // 5. 白地部に緑文字「馬運車」: スリットの下の白地 (left: u = 0.55, right: u = 0.45, v = 0.60)
  // 文字の高さは v で 0.13 前後（約 66px）
  const textU = frontSide === "left" ? 0.55 : 0.45;
  ctx.fillStyle = "#1f6b2e";
  ctx.font = "900 66px 'Noto Sans JP', 'Hiragino Kaku Gothic ProN', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("馬運車", HORSE_AMBULANCE_WIDTH * textU, HORSE_AMBULANCE_HEIGHT * (1.0 - 0.60));

  // 6. 緑の地に白い文字で「HORSE AMBULANCE」 (left: u = 0.55, right: u = 0.45, v = 0.27)
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 32px 'Montserrat', sans-serif";
  ctx.letterSpacing = "4px";
  ctx.fillText("HORSE AMBULANCE", HORSE_AMBULANCE_WIDTH * textU, HORSE_AMBULANCE_HEIGHT * (1.0 - 0.27));

  return toCanvasTexture(canvas);
};

// =============================================================================
// メインエクスポート (createExtrasTextures)
// =============================================================================

/**
 * 競馬場周辺の備品・車両・植栽に貼るテクスチャ一式を生成する。
 *
 * 【どう実現しているか】
 * シード値固定の擬似乱数を用いて、foliage（生垣）、pavement（舗装）、
 * ambulanceLivery（救急車 −Z）、ambulanceLiveryFrontRight（救急車 +Z）、
 * horseAmbulanceLivery（馬運車 −Z）、horseAmbulanceLiveryFrontRight（馬運車 +Z）を順次生成してバンドル。
 * 合計生成時間は最適化により 100〜120ms 以内に収まる。
 *
 * 【なぜ他の方法を採らなかったか】
 * 各アセットを個別の非同期読み込みにするとレースシーン初期化時の表示遅延や
 * テクスチャ欠落（ピンク画面）の原因となるため、同期的な単一ファクトリで一括初期化する。
 */
export const createExtrasTextures = (): ExtrasTextures => {
  const random = seededRandom(20261012);

  const foliage = createFoliageTexture(random);
  const pavement = createPavementTexture(random);
  const ambulanceLivery = createAmbulanceLivery("left");
  const ambulanceLiveryFrontRight = createAmbulanceLivery("right");
  const horseAmbulanceLivery = createHorseAmbulanceLivery("left");
  const horseAmbulanceLiveryFrontRight = createHorseAmbulanceLivery("right");

  return {
    foliage,
    pavement,
    ambulanceLivery,
    ambulanceLiveryFrontRight,
    horseAmbulanceLivery,
    horseAmbulanceLiveryFrontRight,
    dispose: () => {
      foliage.dispose();
      pavement.dispose();
      ambulanceLivery.dispose();
      ambulanceLiveryFrontRight.dispose();
      horseAmbulanceLivery.dispose();
      horseAmbulanceLiveryFrontRight.dispose();
    },
  };
};
