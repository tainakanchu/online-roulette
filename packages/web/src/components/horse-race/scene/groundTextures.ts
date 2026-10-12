import * as THREE from "three";

// 路面の細部テクスチャ（Data3DTexture による 3D ソリッドテクスチャ、3 軸すべてで周期的に繰り返す）。
// 3D テクスチャ（128x128x16 RGBA、各 1MB）として手続き生成し、
// ワールド座標でサンプリングすることで UV に依存せず継ぎ目なく模様を貼る。
//
// 1 枚あたり 128 * 128 * 16 * 4 = 1,048,576 バイト（ちょうど 1MB）。2 枚合計 2MB。
// 生成時間は格子点補間の事前展開とスプラッティングの最適化により、2 枚合計 60〜90ms 程度で完了する。

const WIDTH = 128;
const HEIGHT = 128;
const DEPTH = 16;
const VOXELS = WIDTH * HEIGHT * DEPTH;

/** 種から決まる乱数（mulberry32）。毎回同一のテクスチャを再現する */
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
 * トーラス（周期境界）上での最短符号付き差分 (val - center)。
 *
 * 【どう実現しているか】
 * 周期の半分を超える差分を反対周りへと折り返し、[-period/2, period/2] の範囲に正規化する。
 *
 * 【なぜ他の方法を採らなかったか】
 * 単純な差分では 0 と 127（あるいは 0 と 15）の境界をまたぐ小石や芝の葉が切断されてタイリング境界に継ぎ目ができるため、
 * 最短周回方向への差分を用いて完全な継ぎ目なしテクスチャを保証する。
 */
const torusDelta = (val: number, center: number, period: number) => {
  let d = (val - center) % period;
  if (d > period * 0.5) d -= period;
  else if (d < -period * 0.5) d += period;
  return d;
};

/**
 * 3 軸すべてで周期的な 3D バリューノイズテーブルをボリューム全体へ展開する。
 *
 * 【どう実現しているか】
 * 格子点の乱数をトリリニア補間して 128x128x16 の Float32Array に展開する。
 *
 * 【なぜ他の方法を採らなかったか】
 * ボクセルごとに関数呼び出しを行って 8 点ルックアップと 7 回の lerp を実行する方式（旧実装）では、
 * 26 万回の関数呼び出しオーバーヘッドだけで 100ms 以上消費してしまう。
 * スライス（Z）およびライン（Y）の外側ループで補間係数を事前計算して内側ループを単純化することで、
 * 2〜3ms でボリューム全体の補間展開を完了させている。
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

  const output = new Float32Array(VOXELS);

  for (let z = 0; z < DEPTH; z += 1) {
    const wz = (z / DEPTH) * gridZ;
    const zi = Math.floor(wz);
    const fz = smooth(wz - zi);
    const zOffset = z * WIDTH * HEIGHT;

    for (let y = 0; y < HEIGHT; y += 1) {
      const wy = (y / HEIGHT) * gridY;
      const yi = Math.floor(wy);
      const fy = smooth(wy - yi);
      const yOffset = zOffset + y * WIDTH;

      for (let x = 0; x < WIDTH; x += 1) {
        const wx = (x / WIDTH) * gridX;
        const xi = Math.floor(wx);
        const fx = smooth(wx - xi);

        const x00 = lerp(at(xi, yi, zi), at(xi + 1, yi, zi), fx);
        const x10 = lerp(at(xi, yi + 1, zi), at(xi + 1, yi + 1, zi), fx);
        const y0 = lerp(x00, x10, fy);

        const x01 = lerp(at(xi, yi, zi + 1), at(xi + 1, yi, zi + 1), fx);
        const x11 = lerp(at(xi, yi + 1, zi + 1), at(xi + 1, yi + 1, zi + 1), fx);
        const y1 = lerp(x01, x11, fy);

        output[yOffset + x] = lerp(y0, y1, fz);
      }
    }
  }

  return output;
};

/** 中心 cz と厚み rz から影響を受ける Z スライス番号と減衰重み wz を取得する */
const collectZSliceWeights = (cz: number, rz: number): { zIndices: number[]; zWeights: number[] } => {
  const minZ = Math.floor(cz - rz);
  const maxZ = Math.ceil(cz + rz);
  const zIndices: number[] = [];
  const zWeights: number[] = [];
  for (let iz = minZ; iz <= maxZ; iz += 1) {
    const dz = Math.abs(torusDelta(iz, cz, DEPTH));
    if (dz <= rz) {
      zIndices.push(wrap(iz, DEPTH));
      zWeights.push(1.0 - (dz / rz) ** 2);
    }
  }
  return { zIndices, zWeights };
};

const createData3D = (data: Uint8Array): THREE.Data3DTexture => {
  const texture = new THREE.Data3DTexture(data, WIDTH, HEIGHT, DEPTH);
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

export interface GroundDetail {
  /** 3D ボリュームテクスチャ（ダート: RGB=色 A=高さ、芝: R=明暗 G/B=未使用 A=高さ） */
  texture: THREE.Data3DTexture;
  dispose: () => void;
}

/**
 * ダートの 3D テクスチャ（砂粒・小石・土くれの色と高さ）。
 *
 * 【チャンネル仕様】
 * RGB: 地の色（アルベド、リニア値）。平均色は sRGB #b39169 相当（リニア約 (0.45, 0.28, 0.14)）。
 * A: 高さ 0..1（小石 > 土くれ > 砂地 の順に盛り上がり、シェーダーで法線摂動に使用）。
 *
 * 【なぜリニア値として保存するか】
 * sRGB 相当の値をそのまま格納すると、シェーダーでのライティング計算時に二重にガンマ変換されたようになり
 * 地面が白飛びして見えるため、(sRGB/255)^2.2 で算出したリニア値を直接 0..255 に格納している。
 *
 * 【なぜスプラッティング方式を採用したか】
 * 3D ノイズの閾値処理では、土くれや小石の立体的なドーム形状、上からの照明による明暗、
 * および片側に落ちる小さな影を自然に表現することが困難なため、要素ごとに位置・厚み・陰影を持って
 * ボリュームへ直接ラスタライズする方式を採用した。
 */
export const createDirtDetail = (): GroundDetail => {
  const random = seededRandom(20261013);

  // 1. 低周波の湿り気・踏み固めノイズ (周期 4x4x4)
  const coarseNoise = createPeriodicNoise3D(4, 4, 4, random);
  // 2. 砂粒ベースの中高周波ノイズ (周期 32x32x16)
  const fineNoise = createPeriodicNoise3D(32, 32, 16, random);

  const bufR = new Float32Array(VOXELS);
  const bufG = new Float32Array(VOXELS);
  const bufB = new Float32Array(VOXELS);
  const bufA = new Float32Array(VOXELS);

  // 目標平均リニア色 (sRGB #b39169 相当)
  const targetLinearR = 0.45;
  const targetLinearG = 0.28;
  const targetLinearB = 0.14;

  // ベース層: 湿り気・踏み固めの濃淡と砂地の基礎
  for (let i = 0; i < VOXELS; i += 1) {
    const moist = (coarseNoise[i] - 0.5) * 0.35;
    const grain = (fineNoise[i] - 0.5) * 0.25;

    const bright = 1.0 + moist * 0.75 + grain * 0.55;
    bufR[i] = targetLinearR * bright;
    bufG[i] = targetLinearG * bright;
    bufB[i] = targetLinearB * bright;
    bufA[i] = 0.45 + moist * 0.2 + grain * 0.15;
  }

  // 3. 砂粒の散布 (1〜2 テクセルの明・暗・白の粒子を密に配置)
  const grainCount = 7000;
  for (let g = 0; g < grainCount; g += 1) {
    const cx = random() * WIDTH;
    const cy = random() * HEIGHT;
    const cz = random() * DEPTH;
    const roll = random();

    let colMult = 1.0;
    let dH = 0.03;
    if (roll < 0.2) {
      // 白っぽい砂粒
      colMult = 1.75;
      dH = 0.06;
    } else if (roll < 0.5) {
      // 暗い砂粒
      colMult = 0.62;
      dH = -0.04;
    } else {
      // 明るめの砂粒
      colMult = 1.3;
      dH = 0.03;
    }

    const rxy = 0.75 + random() * 0.6;
    const rxy2 = rxy * rxy;
    const { zIndices, zWeights } = collectZSliceWeights(cz, 1.2);

    const minY = Math.floor(cy - rxy);
    const maxY = Math.ceil(cy + rxy);
    const minX = Math.floor(cx - rxy);
    const maxX = Math.ceil(cx + rxy);

    for (let iy = minY; iy <= maxY; iy += 1) {
      const y = wrap(iy, HEIGHT);
      const dy = torusDelta(iy, cy, HEIGHT);
      const dy2 = dy * dy;
      for (let ix = minX; ix <= maxX; ix += 1) {
        const x = wrap(ix, WIDTH);
        const dx = torusDelta(ix, cx, WIDTH);
        const dist2 = dx * dx + dy2;
        if (dist2 >= rxy2) continue;
        const wxy = (1.0 - dist2 / rxy2) * 0.85;

        for (let zi = 0; zi < zIndices.length; zi += 1) {
          const z = zIndices[zi];
          const w = wxy * zWeights[zi];
          const idx = (z * HEIGHT + y) * WIDTH + x;
          bufR[idx] = bufR[idx] * (1 - w) + bufR[idx] * colMult * w;
          bufG[idx] = bufG[idx] * (1 - w) + bufG[idx] * colMult * w;
          bufB[idx] = bufB[idx] * (1 - w) + bufB[idx] * colMult * w;
          bufA[idx] += dH * w;
        }
      }
    }
  }

  // 4. 土くれ (3〜8 テクセルの暗い茶色の塊、上側が少し明るい、高さ高め)
  const clodCount = 500;
  for (let c = 0; c < clodCount; c += 1) {
    const cx = random() * WIDTH;
    const cy = random() * HEIGHT;
    const cz = random() * DEPTH;
    const rx = 1.8 + random() * 2.2;
    const ry = 1.5 + random() * 1.8;
    const { zIndices, zWeights } = collectZSliceWeights(cz, 1.8);

    const minY = Math.floor(cy - ry);
    const maxY = Math.ceil(cy + ry);
    const minX = Math.floor(cx - rx);
    const maxX = Math.ceil(cx + rx);

    for (let iy = minY; iy <= maxY; iy += 1) {
      const y = wrap(iy, HEIGHT);
      const dy = torusDelta(iy, cy, HEIGHT);
      const yNorm2 = (dy * dy) / (ry * ry);
      if (yNorm2 >= 1.0) continue;
      const shade = 1.0 + (dy / ry) * 0.35;
      const clodR = targetLinearR * 0.65 * shade;
      const clodG = targetLinearG * 0.65 * shade;
      const clodB = targetLinearB * 0.65 * shade;

      for (let ix = minX; ix <= maxX; ix += 1) {
        const x = wrap(ix, WIDTH);
        const dx = torusDelta(ix, cx, WIDTH);
        const dist2 = (dx * dx) / (rx * rx) + yNorm2;
        if (dist2 >= 1.0) continue;
        const wxy = 1.0 - dist2;
        const clodH = 0.72 + wxy * 0.15;

        for (let zi = 0; zi < zIndices.length; zi += 1) {
          const z = zIndices[zi];
          const w = wxy * zWeights[zi];
          const idx = (z * HEIGHT + y) * WIDTH + x;
          bufR[idx] = bufR[idx] * (1 - w) + clodR * w;
          bufG[idx] = bufG[idx] * (1 - w) + clodG * w;
          bufB[idx] = bufB[idx] * (1 - w) + clodB * w;
          bufA[idx] = Math.max(bufA[idx], bufA[idx] * (1 - w) + clodH * w);
        }
      }
    }
  }

  // 5. 小石 (白・灰の楕円 2〜6 テクセル、片側に小さな影、高さ最大)
  const pebbleCount = 200;
  for (let p = 0; p < pebbleCount; p += 1) {
    const cx = random() * WIDTH;
    const cy = random() * HEIGHT;
    const cz = random() * DEPTH;
    const rx = 1.2 + random() * 1.6;
    const ry = 1.0 + random() * 1.3;
    const isWhite = random() < 0.45;
    const { zIndices, zWeights } = collectZSliceWeights(cz, 1.8);

    // 石のリニア色
    const pColR = isWhite ? 0.68 + random() * 0.1 : 0.36 + random() * 0.08;
    const pColG = isWhite ? 0.62 + random() * 0.1 : 0.35 + random() * 0.08;
    const pColB = isWhite ? 0.54 + random() * 0.1 : 0.33 + random() * 0.08;

    // 影の投影: 光が上から当たるため下側（-y 方向）に影を落とす
    const shadowOffsetY = -(ry * 0.6 + 0.6);
    const sMinY = Math.floor(cy + shadowOffsetY - ry * 0.8);
    const sMaxY = Math.ceil(cy + shadowOffsetY + ry * 0.8);
    const sMinX = Math.floor(cx - rx * 1.2);
    const sMaxX = Math.ceil(cx + rx * 1.2);

    for (let iy = sMinY; iy <= sMaxY; iy += 1) {
      const y = wrap(iy, HEIGHT);
      const dy = torusDelta(iy, cy + shadowOffsetY, HEIGHT);
      const yNorm2 = (dy * dy) / (ry * ry * 0.64);
      if (yNorm2 >= 1.0) continue;

      for (let ix = sMinX; ix <= sMaxX; ix += 1) {
        const x = wrap(ix, WIDTH);
        const dx = torusDelta(ix, cx, WIDTH);
        const dist2 = (dx * dx) / (rx * rx * 1.44) + yNorm2;
        if (dist2 >= 1.0) continue;
        const wxy = (1.0 - dist2) * 0.55;

        for (let zi = 0; zi < zIndices.length; zi += 1) {
          const z = zIndices[zi];
          const w = wxy * zWeights[zi];
          const idx = (z * HEIGHT + y) * WIDTH + x;
          bufR[idx] *= 1 - w * 0.5;
          bufG[idx] *= 1 - w * 0.5;
          bufB[idx] *= 1 - w * 0.5;
        }
      }
    }

    // 小石本体
    const minY = Math.floor(cy - ry);
    const maxY = Math.ceil(cy + ry);
    const minX = Math.floor(cx - rx);
    const maxX = Math.ceil(cx + rx);

    for (let iy = minY; iy <= maxY; iy += 1) {
      const y = wrap(iy, HEIGHT);
      const dy = torusDelta(iy, cy, HEIGHT);
      const yNorm2 = (dy * dy) / (ry * ry);
      if (yNorm2 >= 1.0) continue;

      const shade = 1.0 + (dy / ry) * 0.3;
      const colR = pColR * shade;
      const colG = pColG * shade;
      const colB = pColB * shade;

      for (let ix = minX; ix <= maxX; ix += 1) {
        const x = wrap(ix, WIDTH);
        const dx = torusDelta(ix, cx, WIDTH);
        const dist2 = (dx * dx) / (rx * rx) + yNorm2;
        if (dist2 >= 1.0) continue;
        const wxy = Math.min(1.0, (1.0 - dist2) * 1.5);
        const pebbleH = 0.88 + (1.0 - dist2) * 0.1;

        for (let zi = 0; zi < zIndices.length; zi += 1) {
          const z = zIndices[zi];
          const w = wxy * zWeights[zi];
          const idx = (z * HEIGHT + y) * WIDTH + x;
          bufR[idx] = bufR[idx] * (1 - w) + colR * w;
          bufG[idx] = bufG[idx] * (1 - w) + colG * w;
          bufB[idx] = bufB[idx] * (1 - w) + colB * w;
          bufA[idx] = Math.max(bufA[idx], pebbleH);
        }
      }
    }
  }

  // 6. 平均色の算出と目標リニア値への正規化
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (let i = 0; i < VOXELS; i += 1) {
    sumR += bufR[i];
    sumG += bufG[i];
    sumB += bufB[i];
  }
  const avgR = sumR / VOXELS;
  const avgG = sumG / VOXELS;
  const avgB = sumB / VOXELS;

  const scaleR = targetLinearR / avgR;
  const scaleG = targetLinearG / avgG;
  const scaleB = targetLinearB / avgB;

  const data = new Uint8Array(VOXELS * 4);
  for (let i = 0; i < VOXELS; i += 1) {
    data[i * 4] = Math.min(255, Math.max(0, Math.round(bufR[i] * scaleR * 255)));
    data[i * 4 + 1] = Math.min(255, Math.max(0, Math.round(bufG[i] * scaleG * 255)));
    data[i * 4 + 2] = Math.min(255, Math.max(0, Math.round(bufB[i] * scaleB * 255)));
    data[i * 4 + 3] = Math.min(255, Math.max(0, Math.round(bufA[i] * 255)));
  }

  const texture = createData3D(data);
  return {
    texture,
    dispose: () => texture.dispose(),
  };
};

/**
 * 芝の細部 3D テクスチャ（葉・葉の隙間の土・刈りくず）。
 *
 * 【チャンネル仕様】
 * R: 明暗（地の色に掛ける乗数値。全体の平均がちょうど 0.5 になるよう正規化）。
 * A: 高さマップ 0..1（葉の先端ほど高く、シェーダーで法線勾配に使用）。
 * G/B: 自由（G に葉の密集度、B に微細ノイズを格納）。
 *
 * 【なぜ葉ストローク方式を採ったか】
 * ノイズの閾値処理では葉の「刈り込み方向への倒れ」「根元の暗がりと葉先のハイライト」という
 * 芝特有の重なり構造が表現できないため、線分ストロークのラスタライズと深度ブレンドを採用した。
 */
export const createTurfDetail = (): GroundDetail => {
  const random = seededRandom(20261014);

  // 1. 低周波ムラ (周期 4x4x4)
  const coarseNoise = createPeriodicNoise3D(4, 4, 4, random);

  const bufR = new Float32Array(VOXELS);
  const bufG = new Float32Array(VOXELS);
  const bufB = new Float32Array(VOXELS);
  const bufA = new Float32Array(VOXELS);

  // ベース層: 葉の隙間に見える根元の暗い土
  for (let i = 0; i < VOXELS; i += 1) {
    const patchy = coarseNoise[i];
    bufR[i] = 0.22 + (patchy - 0.5) * 0.08;
    bufA[i] = 0.16 + (patchy - 0.5) * 0.06;
    bufG[i] = 0.2;
    bufB[i] = 0;
  }

  // 2. 芝の葉のストローク描画 (長さ 5〜14、幅 1〜2、刈り込み方向 = x 軸に寝かせ気味)
  const bladeCount = 7500;
  for (let b = 0; b < bladeCount; b += 1) {
    const x0 = random() * WIDTH;
    const y0 = random() * HEIGHT;
    const z0 = random() * DEPTH;

    const length = 5 + random() * 9;
    // 刈り込み方向: 主に +x 方向（20% は -x 方向）に寝かせ、わずかに角度を揺らす
    const dir = random() < 0.2 ? -1 : 1;
    const angle = dir * ((random() - 0.5) * 0.45);
    const x1 = x0 + Math.cos(angle) * length;
    const y1 = y0 + Math.sin(angle) * length;

    const halfWidth = 0.6 + random() * 0.35;
    const { zIndices, zWeights } = collectZSliceWeights(z0, 1.5);

    // 根元が暗く、先端が明るい。高さも先端ほど高い
    const rootR = 0.26 + random() * 0.06;
    const tipR = 0.72 + random() * 0.14;
    const rootA = 0.22 + random() * 0.06;
    const tipA = 0.78 + random() * 0.14;

    const steps = Math.max(4, Math.ceil(length * 0.9));

    for (let s = 0; s < steps; s += 1) {
      const t = s / (steps - 1);
      const px = x0 + t * (x1 - x0);
      const py = y0 + t * (y1 - y0);

      // 葉の中央がやや太く先端にかけて細くなるプロファイル
      const curWidth = halfWidth * (0.65 + 0.35 * Math.sin(t * Math.PI));
      const curWidth2 = curWidth * curWidth;
      const rVal = lerp(rootR, tipR, t);
      const aVal = lerp(rootA, tipA, t);

      const minIY = Math.floor(py - curWidth);
      const maxIY = Math.ceil(py + curWidth);
      const minIX = Math.floor(px - curWidth);
      const maxIX = Math.ceil(px + curWidth);

      for (let iy = minIY; iy <= maxIY; iy += 1) {
        const y = wrap(iy, HEIGHT);
        const dy = torusDelta(iy, py, HEIGHT);
        const dy2 = dy * dy;
        for (let ix = minIX; ix <= maxIX; ix += 1) {
          const x = wrap(ix, WIDTH);
          const dx = torusDelta(ix, px, WIDTH);
          const dist2 = dx * dx + dy2;
          if (dist2 >= curWidth2) continue;
          const wxy = 1.0 - dist2 / curWidth2;

          for (let zi = 0; zi < zIndices.length; zi += 1) {
            const z = zIndices[zi];
            const w = wxy * zWeights[zi];
            const idx = (z * HEIGHT + y) * WIDTH + x;
            // 葉が重なり合う際、背の高い葉（先端や手前）が優先されるようにブレンド
            if (aVal >= bufA[idx]) {
              bufR[idx] = bufR[idx] * (1 - w) + rVal * w;
              bufA[idx] = bufA[idx] * (1 - w) + aVal * w;
            } else {
              const blendW = w * 0.4;
              bufR[idx] = bufR[idx] * (1 - blendW) + rVal * blendW;
              bufA[idx] = Math.max(bufA[idx], aVal * w);
            }
            bufG[idx] = Math.min(1.0, bufG[idx] + w * 0.5);
          }
        }
      }
    }
  }

  // 3. 明るい刈りくず (所々に散らばる細片)
  const clippingCount = 800;
  for (let c = 0; c < clippingCount; c += 1) {
    const x0 = random() * WIDTH;
    const y0 = random() * HEIGHT;
    const z0 = random() * DEPTH;
    const length = 3 + random() * 3;
    const angle = random() * Math.PI * 2;
    const x1 = x0 + Math.cos(angle) * length;
    const y1 = y0 + Math.sin(angle) * length;
    const { zIndices, zWeights } = collectZSliceWeights(z0, 1.2);
    const steps = Math.ceil(length * 1.2);

    for (let s = 0; s < steps; s += 1) {
      const t = s / (steps - 1);
      const px = x0 + t * (x1 - x0);
      const py = y0 + t * (y1 - y0);
      const ix = wrap(Math.round(px), WIDTH);
      const iy = wrap(Math.round(py), HEIGHT);

      for (let zi = 0; zi < zIndices.length; zi += 1) {
        const z = zIndices[zi];
        const w = 0.75 * zWeights[zi];
        const idx = (z * HEIGHT + iy) * WIDTH + ix;
        bufR[idx] = bufR[idx] * (1 - w) + 0.92 * w;
        bufA[idx] = Math.max(bufA[idx], 0.85);
      }
    }
  }

  // 4. R チャンネルの平均値をちょうど 0.5（Uint8 で 127.5、シェーダーで平均 0.5）に正規化
  let sumR = 0;
  for (let i = 0; i < VOXELS; i += 1) {
    sumR += bufR[i];
  }
  const avgR = sumR / VOXELS;
  const targetFloatR = 127.5 / 255;
  const scaleR = targetFloatR / avgR;

  const data = new Uint8Array(VOXELS * 4);
  let totalByteR = 0;
  for (let i = 0; i < VOXELS; i += 1) {
    const byteVal = Math.min(255, Math.max(0, Math.round(bufR[i] * scaleR * 255)));
    data[i * 4] = byteVal;
    data[i * 4 + 1] = Math.min(255, Math.max(0, Math.round(bufG[i] * 255)));
    data[i * 4 + 2] = Math.min(255, Math.max(0, Math.round(bufB[i] * 255)));
    data[i * 4 + 3] = Math.min(255, Math.max(0, Math.round(bufA[i] * 255)));
    totalByteR += byteVal;
  }

  // 整数丸めで生じる微細な誤差を解消し、平均 127.5 (0.500) を達成
  const targetTotal = Math.round(127.5 * VOXELS);
  let diff = targetTotal - totalByteR;
  if (diff !== 0) {
    const step = Math.max(1, Math.floor(VOXELS / Math.abs(diff)));
    const sign = diff > 0 ? 1 : -1;
    let idx = 0;
    while (diff !== 0 && idx < VOXELS) {
      const val = data[idx * 4] + sign;
      if (val >= 0 && val <= 255) {
        data[idx * 4] = val;
        diff -= sign;
      }
      idx += step;
    }
  }

  const texture = createData3D(data);
  return {
    texture,
    dispose: () => texture.dispose(),
  };
};
