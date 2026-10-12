import * as THREE from "three";

/**
 * コースの柵（ラチ: 白い丸パイプの手すりと支柱）用 3D ソリッドテクスチャ。
 *
 * 【チャンネル仕様 (すべて 0..1)】
 * - R: 汚れ・雨だれ。重力方向（-Y）に縦に伸びた細い筋（Y 方向 6〜16 ボクセル、X/Z 方向 1〜2 ボクセル）と淡い汚れムラ。
 * - G: 泥はね。走路側の低い位置に飛んだ泥の細かい点の集まり（小さな点が群れて飛び散った形）。
 * - B: 擦り傷・塗装の小さな欠け。細く短い線（向きはばらばら、長さ 3〜8 ボクセル）と小さな点。全体のおよそ 3〜5% 程度。
 * - A: 表面の高さ。健全な面は 0.6 前後、欠けた所は 0.3 前後、汚れ・泥はごくわずかに盛り上がる。
 *
 * 【座標系の想定】
 * シェーダー側では部材のワールド座標を「ワールド座標 / 3.0」として 3D サンプリング（UV なし）。
 * 3 軸すべてで周期的にシームレスに繰り返す（64x64x64 RGBA8、1MB）。
 */

export interface RailDetail {
  texture: THREE.Data3DTexture;
  dispose: () => void;
}

const SIZE = 64;
const VOXELS = SIZE * SIZE * SIZE;

/** 種から決まる決定的な乱数（mulberry32）。毎回同一のテクスチャを再現する */
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
 * 単純な差分では 0 と SIZE - 1 の境界をまたぐ雨だれや傷ストロークが切断されてタイリング境界に不自然な
 * 継ぎ目ができるため、最短周回方向への差分を用いて完全な継ぎ目なしテクスチャを保証する。
 */
const torusDelta = (val: number, center: number, period: number) => {
  let d = (val - center) % period;
  const isOverHalf = d > period * 0.5;
  if (isOverHalf) {
    d -= period;
  } else {
    const isUnderNegHalf = d < -period * 0.5;
    if (isUnderNegHalf) {
      d += period;
    }
  }
  return d;
};

/**
 * 3 軸すべてで周期的な 3D バリューノイズテーブルをボリューム全体へ展開する。
 *
 * 【どう実現しているか】
 * 低解像度格子点の乱数をトリリニア補間して 64x64x64 の Float32Array に展開する。
 *
 * 【なぜ他の方法を採らなかったか】
 * ボクセルごとに関数呼び出しを行って格子点を参照する方式では関数呼び出しオーバーヘッドが大きいため、
 * Z・Y の外側ループで補間係数を事前計算して内側ループを単純化し、高速に展開する。
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

  for (let z = 0; z < SIZE; z += 1) {
    const wz = (z / SIZE) * gridZ;
    const zi = Math.floor(wz);
    const fz = smooth(wz - zi);
    const zOffset = z * SIZE * SIZE;

    for (let y = 0; y < SIZE; y += 1) {
      const wy = (y / SIZE) * gridY;
      const yi = Math.floor(wy);
      const fy = smooth(wy - yi);
      const yOffset = zOffset + y * SIZE;

      for (let x = 0; x < SIZE; x += 1) {
        const wx = (x / SIZE) * gridX;
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

/**
 * 3D テクスチャオブジェクトを生成・初期化する。
 *
 * 【どう実現しているか】
 * 64x64x64 の RGBA8 ボリュームテクスチャを作成し、3 軸すべてのラッピングを RepeatWrapping に、
 * フィルタを LinearFilter / LinearMipmapLinearFilter に設定してミップマップを有効化する。
 *
 * 【なぜ他の方法を採らなかったか】
 * シェーダー側で遠方の柵を描画する際にミップマップがないと微細な筋や泥の点が強いエイリアシング（チラつき）
 * を引き起こすため、三線形ミップマップ補間を必須とする。
 */
const createData3D = (data: Uint8Array): THREE.Data3DTexture => {
  const texture = new THREE.Data3DTexture(data, SIZE, SIZE, SIZE);
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
 * 屋外で使い込まれた白い柵（ラチ）の 3D 細部テクスチャを生成する。
 *
 * 【どう実現しているか】
 * 1. R チャンネル: 周期ノイズによる淡い汚れムラに、-Y（重力）方向へ垂れる雨だれ筋（Y 方向 6〜16 ボクセル、幅 1〜2 ボクセル）を重ねる。
 * 2. G チャンネル: 多数の微小点が飛び散った泥はねクラスタをランダム配置する。
 * 3. B チャンネル: 向きがランダムな短い線傷（長さ 3〜8 ボクセル）と小さな塗装欠け点を散布し、全体の約 3〜5% を占めるようにする。
 * 4. A チャンネル: 健全面を 0.60 とし、B の欠け部を 0.30 付近まで彫り込み、R・G の汚れ・泥をわずかに盛り上げて法線用ハイトマップとする。
 *
 * 【なぜ他の方法を採らなかったか】
 * ノイズテクスチャの計算シェーダー実行や 2D UV マッピングでは、丸パイプや支柱が立体交差する複雑な部材形状において
 * UV 継ぎ目が生じ、雨だれの鉛直方向（-Y）整合性を保つことが難しいため、CPU で一括生成する 3D ソリッドテクスチャを採用した。
 */
export const createRailDetail = (): RailDetail => {
  const random = seededRandom(20261015);

  const bufR = new Float32Array(VOXELS);
  const bufG = new Float32Array(VOXELS);
  const bufB = new Float32Array(VOXELS);
  const bufA = new Float32Array(VOXELS);

  // 1. 低周波の汚れムラノイズ（周期 4x4x4）
  const grimeNoise = createPeriodicNoise3D(4, 4, 4, random);

  // ベース層の初期化: 淡い汚れムラと健全塗装面の基本ハイト（0.60 前後）
  for (let i = 0; i < VOXELS; i += 1) {
    const grimeBase = grimeNoise[i] * 0.16;
    bufR[i] = grimeBase;
    const surfaceJitter = (grimeNoise[i] - 0.5) * 0.02;
    bufA[i] = 0.6 + surfaceJitter;
  }

  // 2. R チャンネル: 重力方向（-Y）に伸びる雨だれの縦筋ストローク
  const streakCount = 320;
  for (let s = 0; s < streakCount; s += 1) {
    const cx = random() * SIZE;
    const cy = random() * SIZE;
    const cz = random() * SIZE;

    // Y 方向の長さ 6〜16 ボクセル
    const streakLength = 6 + Math.floor(random() * 11);
    // X, Z 方向の半径 0.6〜1.1 ボクセル（幅 1〜2 ボクセル）
    const rx = 0.6 + random() * 0.5;
    const rz = 0.6 + random() * 0.5;
    const rx2 = rx * rx;
    const rz2 = rz * rz;

    const streakStrength = 0.5 + random() * 0.45;

    const minX = Math.floor(cx - rx);
    const maxX = Math.ceil(cx + rx);
    const minZ = Math.floor(cz - rz);
    const maxZ = Math.ceil(cz + rz);

    for (let step = 0; step < streakLength; step += 1) {
      // 重力方向（-Y 方向）に垂れる
      const iy = wrap(Math.floor(cy - step), SIZE);
      const progress = step / streakLength;
      // 下に向かうにつれて細く薄くなる減衰プロファイル
      const verticalWeight = (1.0 - progress * 0.4) * (1.0 - progress * progress * 0.6);

      for (let iz = minZ; iz <= maxZ; iz += 1) {
        const z = wrap(iz, SIZE);
        const dz = torusDelta(iz, cz, SIZE);
        const dzNorm2 = (dz * dz) / rz2;
        const isOutsideZ = dzNorm2 >= 1.0;
        if (isOutsideZ) continue;

        const zOffset = (z * SIZE + iy) * SIZE;

        for (let ix = minX; ix <= maxX; ix += 1) {
          const x = wrap(ix, SIZE);
          const dx = torusDelta(ix, cx, SIZE);
          const dist2 = (dx * dx) / rx2 + dzNorm2;
          const isOutsideRadius = dist2 >= 1.0;
          if (isOutsideRadius) continue;

          const lateralWeight = 1.0 - dist2;
          const streakValue = streakStrength * verticalWeight * lateralWeight;
          const idx = zOffset + x;

          const isStronger = streakValue > bufR[idx];
          if (isStronger) {
            bufR[idx] = Math.min(1.0, streakValue);
          }
        }
      }
    }
  }

  // 3. G チャンネル: 泥はね（小さな点が群れて飛び散ったスプラッター）
  const splatterClusterCount = 65;
  for (let c = 0; c < splatterClusterCount; c += 1) {
    const clusterX = random() * SIZE;
    const clusterY = random() * SIZE;
    const clusterZ = random() * SIZE;

    // 1 クラスタあたり 14〜26 個の微小な泥滴を散布
    const dropletsInCluster = 14 + Math.floor(random() * 13);
    for (let d = 0; d < dropletsInCluster; d += 1) {
      // クラスタ中心から放射状に飛び散るオフセット
      const sprayDist = (random() ** 1.8) * 6.5;
      const theta = random() * Math.PI * 2;
      const phi = (random() - 0.5) * Math.PI;
      const cosPhi = Math.cos(phi);

      const px = clusterX + Math.cos(theta) * cosPhi * sprayDist;
      const py = clusterY + Math.sin(phi) * sprayDist;
      const pz = clusterZ + Math.sin(theta) * cosPhi * sprayDist;

      // 微小滴の半径 0.5〜1.1 ボクセル（1〜2 ボクセルの点）
      const dropRadius = 0.5 + random() * 0.6;
      const dropRadius2 = dropRadius * dropRadius;
      const dropStrength = 0.65 + random() * 0.35;

      const minDropX = Math.floor(px - dropRadius);
      const maxDropX = Math.ceil(px + dropRadius);
      const minDropY = Math.floor(py - dropRadius);
      const maxDropY = Math.ceil(py + dropRadius);
      const minDropZ = Math.floor(pz - dropRadius);
      const maxDropZ = Math.ceil(pz + dropRadius);

      for (let iz = minDropZ; iz <= maxDropZ; iz += 1) {
        const z = wrap(iz, SIZE);
        const dz = torusDelta(iz, pz, SIZE);
        const dz2 = dz * dz;

        for (let iy = minDropY; iy <= maxDropY; iy += 1) {
          const y = wrap(iy, SIZE);
          const dy = torusDelta(iy, py, SIZE);
          const dyz2 = dz2 + dy * dy;
          const isOutsideYZ = dyz2 >= dropRadius2;
          if (isOutsideYZ) continue;

          const yzOffset = (z * SIZE + y) * SIZE;

          for (let ix = minDropX; ix <= maxDropX; ix += 1) {
            const x = wrap(ix, SIZE);
            const dx = torusDelta(ix, px, SIZE);
            const dist2 = dyz2 + dx * dx;
            const isOutsideDrop = dist2 >= dropRadius2;
            if (isOutsideDrop) continue;

            const w = 1.0 - dist2 / dropRadius2;
            const idx = yzOffset + x;
            const val = dropStrength * w;
            const isNewValHigher = val > bufG[idx];
            if (isNewValHigher) {
              bufG[idx] = Math.min(1.0, val);
            }
          }
        }
      }
    }
  }

  // 4. B チャンネル: 擦り傷・小さな塗装の欠け（全体のおよそ 3〜5% 程度）
  // 細い短い線傷（向きはばらばら、長さ 3〜8 ボクセル）
  const scratchCount = 550;
  for (let s = 0; s < scratchCount; s += 1) {
    const x0 = random() * SIZE;
    const y0 = random() * SIZE;
    const z0 = random() * SIZE;

    const length = 3 + random() * 5;
    // 3D 空間でのランダムな方向ベクトル
    const theta = random() * Math.PI * 2;
    const phi = (random() - 0.5) * Math.PI;
    const cosPhi = Math.cos(phi);
    const dirX = Math.cos(theta) * cosPhi;
    const dirY = Math.sin(phi);
    const dirZ = Math.sin(theta) * cosPhi;

    const scratchRadius = 0.7;
    const scratchRadius2 = scratchRadius * scratchRadius;
    const scratchStrength = 0.75 + random() * 0.25;

    const steps = Math.ceil(length * 1.5);
    for (let st = 0; st <= steps; st += 1) {
      const t = st / steps;
      const px = x0 + dirX * length * t;
      const py = y0 + dirY * length * t;
      const pz = z0 + dirZ * length * t;

      const minX = Math.floor(px - scratchRadius);
      const maxX = Math.ceil(px + scratchRadius);
      const minY = Math.floor(py - scratchRadius);
      const maxY = Math.ceil(py + scratchRadius);
      const minZ = Math.floor(pz - scratchRadius);
      const maxZ = Math.ceil(pz + scratchRadius);

      for (let iz = minZ; iz <= maxZ; iz += 1) {
        const z = wrap(iz, SIZE);
        const dz = torusDelta(iz, pz, SIZE);
        const dz2 = dz * dz;

        for (let iy = minY; iy <= maxY; iy += 1) {
          const y = wrap(iy, SIZE);
          const dy = torusDelta(iy, py, SIZE);
          const dyz2 = dz2 + dy * dy;
          const isOutsideYZ = dyz2 >= scratchRadius2;
          if (isOutsideYZ) continue;

          const yzOffset = (z * SIZE + y) * SIZE;

          for (let ix = minX; ix <= maxX; ix += 1) {
            const x = wrap(ix, SIZE);
            const dx = torusDelta(ix, px, SIZE);
            const dist2 = dyz2 + dx * dx;
            const isOutsideScratch = dist2 >= scratchRadius2;
            if (isOutsideScratch) continue;

            const w = 1.0 - dist2 / scratchRadius2;
            const idx = yzOffset + x;
            const val = scratchStrength * w;
            const isNewValHigher = val > bufB[idx];
            if (isNewValHigher) {
              bufB[idx] = Math.min(1.0, val);
            }
          }
        }
      }
    }
  }

  // 小さな点状の塗装欠け（チッピング）
  const chipCount = 1200;
  for (let c = 0; c < chipCount; c += 1) {
    const cx = random() * SIZE;
    const cy = random() * SIZE;
    const cz = random() * SIZE;

    const chipRadius = 0.75 + random() * 0.35;
    const chipRadius2 = chipRadius * chipRadius;
    const chipStrength = 0.8 + random() * 0.2;

    const minX = Math.floor(cx - chipRadius);
    const maxX = Math.ceil(cx + chipRadius);
    const minY = Math.floor(cy - chipRadius);
    const maxY = Math.ceil(cy + chipRadius);
    const minZ = Math.floor(cz - chipRadius);
    const maxZ = Math.ceil(cz + chipRadius);

    for (let iz = minZ; iz <= maxZ; iz += 1) {
      const z = wrap(iz, SIZE);
      const dz = torusDelta(iz, cz, SIZE);
      const dz2 = dz * dz;

      for (let iy = minY; iy <= maxY; iy += 1) {
        const y = wrap(iy, SIZE);
        const dy = torusDelta(iy, cy, SIZE);
        const dyz2 = dz2 + dy * dy;
        const isOutsideYZ = dyz2 >= chipRadius2;
        if (isOutsideYZ) continue;

        const yzOffset = (z * SIZE + y) * SIZE;

        for (let ix = minX; ix <= maxX; ix += 1) {
          const x = wrap(ix, SIZE);
          const dx = torusDelta(ix, cx, SIZE);
          const dist2 = dyz2 + dx * dx;
          const isOutsideChip = dist2 >= chipRadius2;
          if (isOutsideChip) continue;

          const w = 1.0 - dist2 / chipRadius2;
          const idx = yzOffset + x;
          const val = chipStrength * w;
          const isNewValHigher = val > bufB[idx];
          if (isNewValHigher) {
            bufB[idx] = Math.min(1.0, val);
          }
        }
      }
    }
  }

  // 5. A チャンネルの合成と Uint8Array へのパック
  // 健全面: 0.60 前後、欠けた所: 0.30 前後、汚れ・泥: ごくわずかに盛り上がり（+0.02〜0.03）
  const data = new Uint8Array(VOXELS * 4);
  for (let i = 0; i < VOXELS; i += 1) {
    const rVal = bufR[i];
    const gVal = bufG[i];
    const bVal = bufB[i];

    const currentBaseHeight = bufA[i];
    const chipDepression = bVal * 0.3;
    const grimeElevation = rVal * 0.02 + gVal * 0.03;
    const finalHeight = currentBaseHeight - chipDepression + grimeElevation;

    const clampedR = Math.min(255, Math.max(0, Math.round(rVal * 255)));
    const clampedG = Math.min(255, Math.max(0, Math.round(gVal * 255)));
    const clampedB = Math.min(255, Math.max(0, Math.round(bVal * 255)));
    const clampedA = Math.min(255, Math.max(0, Math.round(finalHeight * 255)));

    data[i * 4] = clampedR;
    data[i * 4 + 1] = clampedG;
    data[i * 4 + 2] = clampedB;
    data[i * 4 + 3] = clampedA;
  }

  const texture = createData3D(data);
  return {
    texture,
    dispose: () => {
      texture.dispose();
    },
  };
};
