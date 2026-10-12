import * as THREE from "three";

// スタートゲート（発馬機）用の使い込まれた塗装金属 3D テクスチャ（ソリッドテクスチャ）。
// Data3DTexture (64x64x64 RGBA8、1MB) として手続き生成し、3方向とも周期的（RepeatWrapping）。
// シェーダー側では部材のワールド座標をそのまま3D座標（ワールド座標 / 2.5 など）として引く想定。
//
// 【各チャンネルの仕様（すべて 0..1）】
// - R: 塗装の剥がれ（チッピング）マスク。0=健全、1=剥げて地金・錆が出ている。
//      小さな欠け（直径1〜4ボクセル）が群れて点在し、ところどころに大きめの剥がれ（5〜10ボクセル、縁がギザギザ）。
//      全体のおよそ8〜12%が0.5を超える程度。
// - G: 錆の濃さと色味の揺らぎ。剥がれた所とその周りで高く、塗装の上にもうっすら滲む。
//      低周波の濃淡 + 細かいざらつき。
// - B: 汚れ・雨だれ。重力方向（-Y）に縦に伸びた筋（Y方向に8〜20ボクセルの長さ、X/Z方向に1〜3ボクセルの細さ）と、
//      ぼんやりした汚れのムラ。値が大きいほど汚れている。
// - A: 塗膜の高さ。健全な塗装は0.6前後、剥がれた所は0.2前後に凹み、剥がれの縁は塗膜の段差でわずかに高い（0.7）。
//      錆のざらつきで細かく揺らす。シェーダー側で画面空間の微分から法線を作る。

const SIZE = 64;
const VOXELS = SIZE ** 3;

export interface GateDetail {
  /** 3D ボリュームテクスチャ（R=チッピング、G=錆、B=雨だれ・汚れ、A=塗膜高さ） */
  texture: THREE.Data3DTexture;
  dispose: () => void;
}

/**
 * 種から決まる決定的な乱数（mulberry32）。
 * 実行環境や呼び出し順序によらず、毎回完全に同一のテクスチャを再現する。
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
 * トーラス（周期境界）上での最短符号付き差分 (val - center)。
 *
 * 【どう実現しているか】
 * 周期 SIZE の半分を超える距離を反対周りへと折り返し、[-SIZE/2, SIZE/2] の範囲に正規化する。
 *
 * 【なぜ他の方法を採らなかったか】
 * 単純な座標差分では 0 と 63 の境界を跨ぐチッピングや雨だれスプラットが切断され、
 * リピート境界で不自然な継ぎ目（シーム）が生じるため。
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
 * X 軸の補間係数は最外ループで事前計算し、スライス（Z）およびライン（Y）の外側ループで
 * Y/Z の補間係数を事前計算して内側ループの演算を最小化する。
 *
 * 【なぜ他の方法を採らなかったか】
 * ボクセルごとに関数呼び出しを行って格子点を参照・補間する方式では関数呼び出しコストで
 * 100ms 以上消費してしまうが、ループ展開と補間係数事前計算により数ミリ秒で全格子展開が完了するため。
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

  const xiArr = new Int32Array(SIZE);
  const fxArr = new Float32Array(SIZE);
  for (let x = 0; x < SIZE; x += 1) {
    const wx = (x / SIZE) * gridX;
    xiArr[x] = Math.floor(wx);
    fxArr[x] = smooth(wx - xiArr[x]);
  }

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
        const xi = xiArr[x];
        const fx = fxArr[x];

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
 * Three.js の Data3DTexture を構築する。
 *
 * 【どう実現しているか】
 * 64x64x64 RGBA8（1MB）バッファを渡し、RepeatWrapping、LinearFilter + LinearMipmapLinearFilter、
 * generateMipmaps = true、colorSpace = NoColorSpace で設定する。
 *
 * 【なぜ他の方法を採らなかったか】
 * カラーテクスチャ（SRGBColorSpace）として扱うとシェーダー側で暗黙のガンマ補正が掛かり
 * マスク値や高さデータが歪んでしまうため、既定の NoColorSpace（データテクスチャ）として作成する。
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
 * スタートゲート用の使い込まれた塗装金属 3D テクスチャ（ソリッドテクスチャ）を生成する。
 *
 * 【どう実現しているか】
 * 1. 周期 4x4x4（低周波ムラ）、8x8x8（チッピング・錆のクラスタ）、32x32x32（微細ざらつき・ギザギザ）、
 *    および 16x2x16（雨だれ用縦引き伸ばし）の4種類の周期的バリューノイズを事前生成。
 * 2. 剥がれ（チッピング）の骨格として、大きめの剥がれ（直径5〜10ボクセル）と、
 *    小さな欠け（直径1〜4ボクセル）のクラスタを周期トーラス上にスプラッティング。
 * 3. 雨だれ（汚れ）として、重力方向（-Y）に伸びる縦筋（長さ8〜20、太さ1〜3ボクセル）をスプラッティング。
 * 4. 各ボクセルで高周波ノイズと合成し、エッジのギザギザ化、錆の滲み出し、雨だれ筋、
 *    および塗膜の段差（健全0.6、剥がれ0.2、縁0.7）を計算して RGBA8 に詰める。
 *
 * 【なぜ他の方法を採らなかったか】
 * 純粋なノイズの積和・閾値処理（FBM のみ）では「重力に沿った細長い雨だれの筋」や
 * 「金属部材の角や面でまとまって発生する局所的なチッピングの欠け形状」をシャープに表現できず、
 * 全体が一様な雲模様になってしまうため、スプラッティングと周期ノイズ変調を併用するハイブリッド方式を採用した。
 */
export const createGateDetail = (): GateDetail => {
  const random = seededRandom(20261012);

  // 1. 周期的ノイズマップの事前生成
  const coarseNoise = createPeriodicNoise3D(4, 4, 4, random);
  const clusterNoise = createPeriodicNoise3D(8, 8, 8, random);
  const fineNoise = createPeriodicNoise3D(32, 32, 32, random);
  const streakNoise = createPeriodicNoise3D(16, 2, 16, random);

  // 2. 剥がれ（チッピング）フィールドのスプラッティング
  const chipField = new Float32Array(VOXELS);

  // (A) 大きめの剥がれ（直径 5〜10ボクセル、半径 2.5〜5.0）
  const numLargeChips = 150;
  for (let i = 0; i < numLargeChips; i += 1) {
    const cx = random() * SIZE;
    const cy = random() * SIZE;
    const cz = random() * SIZE;
    const radius = 2.5 + random() * 2.5;
    const rInt = Math.ceil(radius);
    const rad2 = radius * radius;

    for (let dz = -rInt; dz <= rInt; dz += 1) {
      const z = wrap(Math.floor(cz + dz), SIZE);
      const zDist = torusDelta(z, cz, SIZE);
      const z2 = zDist * zDist;
      const zOffset = z * SIZE * SIZE;

      for (let dy = -rInt; dy <= rInt; dy += 1) {
        const y = wrap(Math.floor(cy + dy), SIZE);
        const yDist = torusDelta(y, cy, SIZE);
        const y2 = yDist * yDist;
        const yz2 = y2 + z2;
        const isOutsideYZ = yz2 > rad2;
        if (isOutsideYZ) continue;
        const yOffset = zOffset + y * SIZE;

        for (let dx = -rInt; dx <= rInt; dx += 1) {
          const x = wrap(Math.floor(cx + dx), SIZE);
          const xDist = torusDelta(x, cx, SIZE);
          const dist2 = xDist * xDist + yz2;

          const isInside = dist2 <= rad2;
          if (isInside) {
            const idx = yOffset + x;
            const factor = 1.0 - Math.sqrt(dist2) / radius;
            chipField[idx] = Math.max(chipField[idx], factor);
          }
        }
      }
    }
  }

  // (B) 小さな欠け（直径 1〜4ボクセル、半径 0.5〜2.0）の群れ（クラスタ散布）
  const numClusters = 100;
  for (let c = 0; c < numClusters; c += 1) {
    const clX = random() * SIZE;
    const clY = random() * SIZE;
    const clZ = random() * SIZE;
    const clusterSize = 20 + Math.floor(random() * 25);

    for (let k = 0; k < clusterSize; k += 1) {
      const ox = (random() - 0.5) * 12;
      const oy = (random() - 0.5) * 12;
      const oz = (random() - 0.5) * 12;
      const cx = wrap(clX + ox, SIZE);
      const cy = wrap(clY + oy, SIZE);
      const cz = wrap(clZ + oz, SIZE);
      const radius = 0.5 + random() * 1.5;
      const rInt = Math.ceil(radius);
      const rad2 = radius * radius;

      for (let dz = -rInt; dz <= rInt; dz += 1) {
        const z = wrap(Math.floor(cz + dz), SIZE);
        const zDist = torusDelta(z, cz, SIZE);
        const z2 = zDist * zDist;
        const zOffset = z * SIZE * SIZE;

        for (let dy = -rInt; dy <= rInt; dy += 1) {
          const y = wrap(Math.floor(cy + dy), SIZE);
          const yDist = torusDelta(y, cy, SIZE);
          const y2 = yDist * yDist;
          const yz2 = y2 + z2;
          const isOutsideYZ = yz2 > rad2;
          if (isOutsideYZ) continue;
          const yOffset = zOffset + y * SIZE;

          for (let dx = -rInt; dx <= rInt; dx += 1) {
            const x = wrap(Math.floor(cx + dx), SIZE);
            const xDist = torusDelta(x, cx, SIZE);
            const dist2 = xDist * xDist + yz2;

            const isInside = dist2 <= rad2;
            if (isInside) {
              const idx = yOffset + x;
              const factor = 1.0 - Math.sqrt(dist2) / radius;
              chipField[idx] = Math.max(chipField[idx], factor);
            }
          }
        }
      }
    }
  }

  // 3. 雨だれの縦筋（重力方向 -Y に伸びる筋、長さ 8〜20、太さ 1〜3ボクセル）
  const streakField = new Float32Array(VOXELS);
  const numStreaks = 100;
  for (let s = 0; s < numStreaks; s += 1) {
    const startX = random() * SIZE;
    const startY = random() * SIZE;
    const startZ = random() * SIZE;
    const length = 8 + random() * 12;
    const radXZ = 0.5 + random() * 1.0; // 半径 0.5〜1.5 (太さ 1〜3)
    const radXZInt = Math.ceil(radXZ);
    const radXZ2 = radXZ * radXZ;
    const lenInt = Math.ceil(length);

    for (let dy = 0; dy <= lenInt; dy += 1) {
      const y = wrap(Math.floor(startY - dy), SIZE);
      const yOffset = y * SIZE;
      const fade = 1.0 - (dy / length) * 0.4;

      for (let dz = -radXZInt; dz <= radXZInt; dz += 1) {
        const z = wrap(Math.floor(startZ + dz), SIZE);
        const zDist = torusDelta(z, startZ, SIZE);
        const z2 = zDist * zDist;
        const isOutsideZ = z2 > radXZ2;
        if (isOutsideZ) continue;
        const zOffset = z * SIZE * SIZE;

        for (let dx = -radXZInt; dx <= radXZInt; dx += 1) {
          const x = wrap(Math.floor(startX + dx), SIZE);
          const xDist = torusDelta(x, startX, SIZE);
          const distXZ2 = xDist * xDist + z2;

          const isInside = distXZ2 <= radXZ2;
          if (isInside) {
            const idx = zOffset + yOffset + x;
            const strength = (1.0 - Math.sqrt(distXZ2) / radXZ) * fade;
            streakField[idx] = Math.max(streakField[idx], strength);
          }
        }
      }
    }
  }

  // 4. 各チャンネルの合成と 8bit 配列への格納
  const data = new Uint8Array(VOXELS * 4);

  for (let i = 0; i < VOXELS; i += 1) {
    const fine = fineNoise[i];
    const coarse = coarseNoise[i];
    const cluster = clusterNoise[i];

    // --- R: 塗装の剥がれ（チッピング）マスク ---
    // 大きめの剥がれや小欠けに対し、微細ノイズでエッジをギザギザに切り欠く。
    let rVal = 0;
    const isChipped = chipField[i] > 0;
    if (isChipped) {
      const jagged = (fine - 0.5) * 0.45;
      const v = chipField[i] + jagged;
      const isVisibleChip = v > 0.15;
      if (isVisibleChip) {
        rVal = Math.min(1.0, (v - 0.15) / 0.35);
      }
    }
    // ノイズ密度の高い箇所に微小なチッピングを付加
    const isMicroCluster = cluster > 0.6 && fine > 0.65;
    if (isMicroCluster) {
      const micro = (fine - 0.65) / 0.35;
      rVal = Math.max(rVal, micro);
    }
    rVal = Math.min(1.0, Math.max(0.0, rVal));

    // --- G: 錆の濃さと色味の揺らぎ ---
    // 剥がれた箇所およびその周囲で高く、健全な塗装面にも薄く滲む。
    const rustBleed = Math.max(rVal, Math.min(1.0, chipField[i] * 1.2));
    const rustBase = rustBleed * 0.7;
    const paintBleed = coarse * 0.18;
    const grain = (fine - 0.5) * 0.15;
    const gVal = Math.min(1.0, Math.max(0.0, rustBase + paintBleed + grain + rVal * 0.25));

    // --- B: 汚れ・雨だれ ---
    // 重力方向(-Y)に伸びる筋と、広域のぼんやりした汚れムラ。
    const grimeMura = coarse * 0.35 + streakNoise[i] * 0.25;
    const streak = streakField[i] * 0.7;
    const bVal = Math.min(1.0, Math.max(0.0, grimeMura + streak));

    // --- A: 塗膜の高さ ---
    // 健全な塗装面は 0.6、剥がれた箇所は 0.2 に凹み、剥がれの境界エッジは塗膜の厚みで 0.7 に盛り上がる。
    let aVal = 0.6;
    const isFullyPeeled = rVal > 0.5;
    const isEdge = !isFullyPeeled && rVal > 0.05;
    if (isFullyPeeled) {
      aVal = 0.2 + (fine - 0.5) * 0.08;
    } else if (isEdge) {
      const edgeT = Math.sin((rVal / 0.5) * Math.PI);
      aVal = lerp(0.6, 0.2, rVal / 0.5) + edgeT * 0.22 + (fine - 0.5) * 0.04;
    } else {
      aVal = 0.6 + (fine - 0.5) * 0.04;
    }
    aVal = Math.min(1.0, Math.max(0.0, aVal));

    data[i * 4] = Math.round(rVal * 255);
    data[i * 4 + 1] = Math.round(gVal * 255);
    data[i * 4 + 2] = Math.round(bVal * 255);
    data[i * 4 + 3] = Math.round(aVal * 255);
  }

  const texture = createData3D(data);

  return {
    texture,
    dispose: () => {
      texture.dispose();
    },
  };
};
