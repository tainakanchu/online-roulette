import * as THREE from "three";

// 遠景の山（丘）用の山肌 3D テクスチャ（ソリッドテクスチャ）。
// Data3DTexture (64x64x64 RGBA8、1MB) として手続き生成し、3 方向とも周期的（RepeatWrapping で継ぎ目なし）。
// シェーダー側では山のワールド座標をそのまま 3D 座標として引く。
// 「ワールド座標 / 60」（1 周期≒60 単位）と「ワールド座標 / 240」の 2 つのスケールで引いて重ねる想定。
//
// 【各チャンネルの仕様（すべて 0..1）】
// - R: 樹冠の凹凸。遠くから見た森の木々の丸い樹冠が密に並んだ凸凹。
//      Worley ノイズの「セルの中心ほど高い」ドーム形状を 2 段（周期 8 と 周期 16）の大きさで重ね合わせ、
//      木々の個別樹冠と群生樹冠を立体的に表現する。平均値はおよそ 0.5。
// - G: 植生の種類の分布。0=草地・畑、0.5=落葉広葉樹の森、1=濃い針葉樹の森。
//      低周波の周期ノイズをトリリニア補間して合成し、大きな塊がなめらかにつながる分布を形成。
//      高さ依存の遷移はシェーダー側で処理するため、高さ非依存の水平・立体広域分布として生成。
// - B: 尾根と谷の筋。山肌を縦に走る浅い谷筋（沢）の模様。
//      Y 方向（上下）に長く、X/Z 方向に細かく枝分かれした筋を縦長周期ノイズの多重オクターブで構成し、
//      0=谷筋（沢）、1=尾根になるように滑らかに遷移させる。
// - A: 岩・裸地・道のマスク。ところどころに出る岩場や伐採地（小さな塊）と、細い林道の線。
//      ほとんど 0、該当する所だけ 0.6〜1。全体のおよそ 5〜8% 程度が 0.5 を超える分布。

const SIZE = 64;
const VOXELS = SIZE ** 3;

export interface MountainDetail {
  /** 3D ボリュームテクスチャ（R=樹冠凹凸、G=植生分布、B=尾根・谷筋、A=岩・裸地・道マスク） */
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
 * 単純な座標差分では 0 と 63 の境界を跨ぐ林道スプラットが切断され、
 * リピート境界で不自然な継ぎ目（シーム）が生じてしまうため。
 */
const torusDelta = (val: number, center: number, period: number) => {
  let d = (val - center) % period;
  if (d > period * 0.5) d -= period;
  else if (d < -period * 0.5) d += period;
  return d;
};

/**
 * 3 軸すべてで周期的な 3D バリューノイズテーブルをボリューム全体（64x64x64）へ事前展開する。
 *
 * 【どう実現しているか】
 * 格子点の乱数をトリリニア補間して Float32Array に展開する。
 * X 軸の格子インデックスと補間係数を事前計算し、スライス（Z）およびライン（Y）の外側ループで
 * 格子行のベースインデックスを算出することで、内側ループの乗算や関数呼び出しを最小化している。
 *
 * 【なぜ他の方法を採らなかったか】
 * ボクセルごとに関数呼び出しを行って格子点を参照・補間する方式では呼び出しコストで
 * 100ms 以上消費してしまうが、行ポインタ展開と補間係数事前計算により数ミリ秒で全格子展開が完了するため。
 */
const createPeriodicNoise3D = (
  gridX: number,
  gridY: number,
  gridZ: number,
  random: () => number
): Float32Array => {
  const lattice = Float32Array.from({ length: gridX * gridY * gridZ }, () => random());
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
    const slice0 = wrap(zi, gridZ) * gridY;
    const slice1 = wrap(zi + 1, gridZ) * gridY;

    for (let y = 0; y < SIZE; y += 1) {
      const wy = (y / SIZE) * gridY;
      const yi = Math.floor(wy);
      const fy = smooth(wy - yi);
      const yOffset = zOffset + y * SIZE;

      const row00 = (slice0 + wrap(yi, gridY)) * gridX;
      const row10 = (slice0 + wrap(yi + 1, gridY)) * gridX;
      const row01 = (slice1 + wrap(yi, gridY)) * gridX;
      const row11 = (slice1 + wrap(yi + 1, gridY)) * gridX;

      for (let x = 0; x < SIZE; x += 1) {
        const xi = xiArr[x];
        const fx = fxArr[x];
        const xi0 = wrap(xi, gridX);
        const xi1 = wrap(xi + 1, gridX);

        const x00 = lerp(lattice[row00 + xi0], lattice[row00 + xi1], fx);
        const x10 = lerp(lattice[row10 + xi0], lattice[row10 + xi1], fx);
        const y0 = lerp(x00, x10, fy);

        const x01 = lerp(lattice[row01 + xi0], lattice[row01 + xi1], fx);
        const x11 = lerp(lattice[row11 + xi0], lattice[row11 + xi1], fx);
        const y1 = lerp(x01, x11, fy);

        output[yOffset + x] = lerp(y0, y1, fz);
      }
    }
  }

  return output;
};

/**
 * 3 軸すべてで周期的な Worley（セル）ノイズの最短特徴点距離をボリューム全体へ展開する。
 *
 * 【どう実現しているか】
 * 各セルに 1 個の特徴点オフセットを乱数配置し、周囲 3x3x3 セルの特徴点までの距離二乗の最小値を
 * 完全アンロールされたインライン計算で求める。正規化距離（0..1、セル幅単位）を返す。
 *
 * 【なぜ他の方法を採らなかったか】
 * 汎用の 3 重ループ（dx, dy, dz）による 27 セル探索では、2 段の Worley ノイズ計算だけで 160ms 超を費やし
 * 150ms 制限を超過してしまう。X・Y の格子インデックス事前計算と Z 平面・Y 行単位のベースアドレス展開により、
 * 演算を 50ms 前後まで劇的に高速化している。
 */
const createPeriodicWorley = (cells: number, random: () => number): Float32Array => {
  const count = cells ** 3;
  const ox = new Float32Array(count);
  const oy = new Float32Array(count);
  const oz = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    ox[i] = random();
    oy[i] = random();
    oz[i] = random();
  }

  const output = new Float32Array(VOXELS);
  const cellSize = SIZE / cells;
  const invCellSize = 1.0 / cellSize;

  const dxBase = new Float32Array(SIZE * 3);
  const gxArr = new Int32Array(SIZE * 3);
  for (let x = 0; x < SIZE; x += 1) {
    const cx = Math.floor(x * invCellSize);
    for (let di = 0; di < 3; di += 1) {
      const dx = di - 1;
      dxBase[x * 3 + di] = (cx + dx) * cellSize - x;
      gxArr[x * 3 + di] = wrap(cx + dx, cells);
    }
  }

  const dyBase = new Float32Array(SIZE * 3);
  const gyArr = new Int32Array(SIZE * 3);
  for (let y = 0; y < SIZE; y += 1) {
    const cy = Math.floor(y * invCellSize);
    for (let di = 0; di < 3; di += 1) {
      const dy = di - 1;
      dyBase[y * 3 + di] = (cy + dy) * cellSize - y;
      gyArr[y * 3 + di] = wrap(cy + dy, cells);
    }
  }

  for (let z = 0; z < SIZE; z += 1) {
    const cz = Math.floor(z * invCellSize);
    const zOffset = z * SIZE * SIZE;
    const gz0 = wrap(cz - 1, cells) * cells;
    const gz1 = wrap(cz, cells) * cells;
    const gz2 = wrap(cz + 1, cells) * cells;
    const dz0 = (cz - 1) * cellSize - z;
    const dz1 = cz * cellSize - z;
    const dz2 = (cz + 1) * cellSize - z;

    for (let y = 0; y < SIZE; y += 1) {
      const y3 = y * 3;
      const yOffset = zOffset + y * SIZE;

      const gy0 = gyArr[y3];
      const gy1 = gyArr[y3 + 1];
      const gy2 = gyArr[y3 + 2];
      const dy0 = dyBase[y3];
      const dy1 = dyBase[y3 + 1];
      const dy2 = dyBase[y3 + 2];

      const baseG00 = (gz0 + gy0) * cells;
      const baseG01 = (gz0 + gy1) * cells;
      const baseG02 = (gz0 + gy2) * cells;

      const baseG10 = (gz1 + gy0) * cells;
      const baseG11 = (gz1 + gy1) * cells;
      const baseG12 = (gz1 + gy2) * cells;

      const baseG20 = (gz2 + gy0) * cells;
      const baseG21 = (gz2 + gy1) * cells;
      const baseG22 = (gz2 + gy2) * cells;

      for (let x = 0; x < SIZE; x += 1) {
        let minDistSq = 1e9;
        const x3 = x * 3;
        const gx0 = gxArr[x3];
        const gx1 = gxArr[x3 + 1];
        const gx2 = gxArr[x3 + 2];
        const dx0 = dxBase[x3];
        const dx1 = dxBase[x3 + 1];
        const dx2 = dxBase[x3 + 2];

        let g = 0;
        let px = 0;
        let py = 0;
        let pz = 0;
        let d = 0;

        // Z-1 平面 (dz0)
        {
          g = baseG00 + gx0; px = dx0 + ox[g] * cellSize; py = dy0 + oy[g] * cellSize; pz = dz0 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;
          g = baseG00 + gx1; px = dx1 + ox[g] * cellSize; py = dy0 + oy[g] * cellSize; pz = dz0 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;
          g = baseG00 + gx2; px = dx2 + ox[g] * cellSize; py = dy0 + oy[g] * cellSize; pz = dz0 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;

          g = baseG01 + gx0; px = dx0 + ox[g] * cellSize; py = dy1 + oy[g] * cellSize; pz = dz0 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;
          g = baseG01 + gx1; px = dx1 + ox[g] * cellSize; py = dy1 + oy[g] * cellSize; pz = dz0 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;
          g = baseG01 + gx2; px = dx2 + ox[g] * cellSize; py = dy1 + oy[g] * cellSize; pz = dz0 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;

          g = baseG02 + gx0; px = dx0 + ox[g] * cellSize; py = dy2 + oy[g] * cellSize; pz = dz0 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;
          g = baseG02 + gx1; px = dx1 + ox[g] * cellSize; py = dy2 + oy[g] * cellSize; pz = dz0 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;
          g = baseG02 + gx2; px = dx2 + ox[g] * cellSize; py = dy2 + oy[g] * cellSize; pz = dz0 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;
        }
        // Z+0 平面 (dz1)
        {
          g = baseG10 + gx0; px = dx0 + ox[g] * cellSize; py = dy0 + oy[g] * cellSize; pz = dz1 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;
          g = baseG10 + gx1; px = dx1 + ox[g] * cellSize; py = dy0 + oy[g] * cellSize; pz = dz1 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;
          g = baseG10 + gx2; px = dx2 + ox[g] * cellSize; py = dy0 + oy[g] * cellSize; pz = dz1 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;

          g = baseG11 + gx0; px = dx0 + ox[g] * cellSize; py = dy1 + oy[g] * cellSize; pz = dz1 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;
          g = baseG11 + gx1; px = dx1 + ox[g] * cellSize; py = dy1 + oy[g] * cellSize; pz = dz1 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;
          g = baseG11 + gx2; px = dx2 + ox[g] * cellSize; py = dy1 + oy[g] * cellSize; pz = dz1 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;

          g = baseG12 + gx0; px = dx0 + ox[g] * cellSize; py = dy2 + oy[g] * cellSize; pz = dz1 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;
          g = baseG12 + gx1; px = dx1 + ox[g] * cellSize; py = dy2 + oy[g] * cellSize; pz = dz1 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;
          g = baseG12 + gx2; px = dx2 + ox[g] * cellSize; py = dy2 + oy[g] * cellSize; pz = dz1 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;
        }
        // Z+1 平面 (dz2)
        {
          g = baseG20 + gx0; px = dx0 + ox[g] * cellSize; py = dy0 + oy[g] * cellSize; pz = dz2 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;
          g = baseG20 + gx1; px = dx1 + ox[g] * cellSize; py = dy0 + oy[g] * cellSize; pz = dz2 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;
          g = baseG20 + gx2; px = dx2 + ox[g] * cellSize; py = dy0 + oy[g] * cellSize; pz = dz2 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;

          g = baseG21 + gx0; px = dx0 + ox[g] * cellSize; py = dy1 + oy[g] * cellSize; pz = dz2 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;
          g = baseG21 + gx1; px = dx1 + ox[g] * cellSize; py = dy1 + oy[g] * cellSize; pz = dz2 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;
          g = baseG21 + gx2; px = dx2 + ox[g] * cellSize; py = dy1 + oy[g] * cellSize; pz = dz2 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;

          g = baseG22 + gx0; px = dx0 + ox[g] * cellSize; py = dy2 + oy[g] * cellSize; pz = dz2 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;
          g = baseG22 + gx1; px = dx1 + ox[g] * cellSize; py = dy2 + oy[g] * cellSize; pz = dz2 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;
          g = baseG22 + gx2; px = dx2 + ox[g] * cellSize; py = dy2 + oy[g] * cellSize; pz = dz2 + oz[g] * cellSize; d = px * px + py * py + pz * pz; if (d < minDistSq) minDistSq = d;
        }

        output[yOffset + x] = Math.sqrt(minDistSq) * invCellSize;
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
 * generateMipmaps = true、既定の colorSpace（データテクスチャ）で設定する。
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
 * 競馬場の遠景の山（丘）に使う山肌 3D テクスチャ（ソリッドテクスチャ）を生成する。
 *
 * 【どう実現しているか】
 * 1. 決定的な mulberry32 乱数から、植生分布用（3x3x3、6x6x6）、尾根谷筋用（8x2x8、16x4x16、32x8x32）、
 *    岩場クラスタ用（8x8x8、32x32x32）の周期ノイズを事前生成。
 * 2. 樹冠凹凸用に周期 8 と周期 16 の 2 段の Worley ノイズ（中心ほど高いドーム形状）を生成。
 * 3. 細い林道の線として、周期トーラス上で 3 次元のなだらかなランダムウォーク経路を 12 本スプラッティング。
 * 4. 各ボクセルで 4 チャンネル（R: 樹冠、G: 植生、B: 尾根谷、A: 岩・裸地・道）を合成して 1MB バッファに詰める。
 *
 * 【なぜ他の方法を採らなかったか】
 * 単純な 3D バリューノイズの積和のみでは、木々の個別ドーム形状（樹冠）や、
 * 山腹を縫うように走る細い林道の連続的な線を表現できず、全体がぼんやりした雲模様になってしまうため、
 * Worley ドーム・縦長異方性ノイズ・ランダムウォークスプラッティングを組み合わせたハイブリッド手法を採用した。
 */
export const createMountainDetail = (): MountainDetail => {
  const random = seededRandom(20261012);

  // 1. 周期的ノイズマップの事前生成
  const vegCoarse = createPeriodicNoise3D(3, 3, 3, random);
  const vegMid = createPeriodicNoise3D(6, 6, 6, random);

  const ridgeNoiseY1 = createPeriodicNoise3D(8, 2, 8, random);
  const ridgeNoiseY2 = createPeriodicNoise3D(16, 4, 16, random);
  const ridgeNoiseFine = createPeriodicNoise3D(32, 8, 32, random);

  const rockClusterNoise = createPeriodicNoise3D(8, 8, 8, random);
  const rockFineNoise = createPeriodicNoise3D(32, 32, 32, random);

  // 2. 樹冠の 2 段 Worley ノイズ
  const worley8 = createPeriodicWorley(8, random);
  const worley16 = createPeriodicWorley(16, random);

  // 3. 林道のスプラッティング（周期境界上で滑らかにつながる細い線）
  const pathField = new Float32Array(VOXELS);
  const numPaths = 12;
  for (let p = 0; p < numPaths; p += 1) {
    let curX = random() * SIZE;
    let curY = random() * SIZE;
    let curZ = random() * SIZE;
    const numSteps = 45;
    const stepLen = 1.2;
    const width = 1.1; // 半径約 1 ボクセル（幅約 2 ボクセルの細い道）
    const widthInt = Math.ceil(width);
    const width2 = width * width;

    for (let s = 0; s < numSteps; s += 1) {
      const yaw = random() * Math.PI * 2;
      const pitch = (random() - 0.5) * 0.5; // 山腹に沿うなだらかな傾斜
      curX = wrap(curX + Math.cos(yaw) * Math.cos(pitch) * stepLen, SIZE);
      curY = wrap(curY + Math.sin(pitch) * stepLen, SIZE);
      curZ = wrap(curZ + Math.sin(yaw) * Math.cos(pitch) * stepLen, SIZE);

      for (let dz = -widthInt; dz <= widthInt; dz += 1) {
        const z = wrap(Math.floor(curZ + dz), SIZE);
        const zDist = torusDelta(z, curZ, SIZE);
        const z2 = zDist * zDist;
        const isOutsideZ = z2 > width2;
        if (isOutsideZ) continue;
        const zOffset = z * SIZE * SIZE;

        for (let dy = -widthInt; dy <= widthInt; dy += 1) {
          const y = wrap(Math.floor(curY + dy), SIZE);
          const yDist = torusDelta(y, curY, SIZE);
          const y2 = yDist * yDist;
          const yz2 = y2 + z2;
          const isOutsideYZ = yz2 > width2;
          if (isOutsideYZ) continue;
          const yOffset = zOffset + y * SIZE;

          for (let dx = -widthInt; dx <= widthInt; dx += 1) {
            const x = wrap(Math.floor(curX + dx), SIZE);
            const xDist = torusDelta(x, curX, SIZE);
            const dist2 = xDist * xDist + yz2;
            const isInside = dist2 <= width2;
            if (isInside) {
              const idx = yOffset + x;
              const strength = 1.0 - Math.sqrt(dist2) / width;
              pathField[idx] = Math.max(pathField[idx], strength);
            }
          }
        }
      }
    }
  }

  // 4. 各チャンネルの合成と 8bit 配列への格納
  const data = new Uint8Array(VOXELS * 4);

  for (let i = 0; i < VOXELS; i += 1) {
    // --- R: 樹冠の凹凸（平均 0.5） ---
    // Worley 特徴点からの距離 d に対し、中心ほど高いドーム (1 - d) を構成
    const c1 = Math.max(0, 1.0 - worley8[i]);
    const c2 = Math.max(0, 1.0 - worley16[i]);
    const dome1 = smooth(c1);
    const dome2 = smooth(c2);
    const rRaw = dome1 * 0.65 + dome2 * 0.35;
    // 平均 0.5 になるよう中心点を調整
    let rVal = (rRaw - 0.473) * 1.5 + 0.5;
    rVal = Math.min(1.0, Math.max(0.0, rVal));

    // --- G: 植生の種類（0=草地・畑、0.5=落葉広葉樹、1=濃い針葉樹） ---
    // なめらかな塊をつなげる
    const vCoarse = vegCoarse[i];
    const vMid = vegMid[i];
    let gVal = vCoarse * 0.72 + vMid * 0.28;
    gVal = (gVal - 0.5) * 1.5 + 0.5;
    gVal = Math.min(1.0, Math.max(0.0, gVal));

    // --- B: 尾根と谷の筋（0=谷筋・沢、1=尾根） ---
    // Y 方向に長く X/Z 方向に細かく枝分かれする異方性ノイズから沢筋（谷）を形成
    const rFbm = ridgeNoiseY1[i] * 0.50 + ridgeNoiseY2[i] * 0.32 + ridgeNoiseFine[i] * 0.18;
    const valleyDist = Math.abs(rFbm - 0.5) * 4.0;
    let bVal = smooth(Math.min(1.0, valleyDist));
    bVal = Math.min(1.0, Math.max(0.0, bVal));

    // --- A: 岩・裸地・道のマスク（0.6〜1、全体の 5〜8% 程度） ---
    let aVal = 0.0;
    // 岩場・伐採地（小さな塊）
    const rockDensity = rockClusterNoise[i] * 0.65 + rockFineNoise[i] * 0.35;
    const isRockPatch = rockDensity > 0.72;
    if (isRockPatch) {
      const rockStrength = (rockDensity - 0.72) / 0.28;
      aVal = Math.max(aVal, 0.6 + 0.4 * rockStrength);
    }
    // 林道の細い線
    const isPath = pathField[i] > 0.2;
    if (isPath) {
      const pathStrength = (pathField[i] - 0.2) / 0.8;
      aVal = Math.max(aVal, 0.65 + 0.35 * pathStrength);
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
