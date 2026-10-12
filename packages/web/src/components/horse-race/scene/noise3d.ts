import * as THREE from "three";

// 共有の 3D ノイズテクスチャ（Data3DTexture、各辺 64 ボクセル、座標 0..1 で 1 周期・3 方向とも繰り返す）。
//   R: なめらかなノイズ（fBm）  G: 細かいノイズ  B: セル（Worley）の特徴点からの距離  A: セルごとの乱数
// シェーダーではワールド座標やローカル座標をそのまま当てる（ソリッドテクスチャ）。
// UV や面ごとの投影（トライプラナー）が要らず、部品の継ぎ目でも模様がつながり、
// ピクセルごとにハッシュでノイズを計算するよりテクスチャ 1 回の読み出しで済むぶん軽い。

const SIZE = 64;

/** 種から決まる乱数（mulberry32）。毎回同じテクスチャを作る */
const seededRandom = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const wrap = (i: number, period: number) => ((i % period) + period) % period;
const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** 周期 period の格子点に乱数を置いたバリューノイズ。入力は格子単位（0..period で 1 周期） */
const periodicValueNoise = (period: number, random: () => number) => {
  const lattice = Float32Array.from({ length: period ** 3 }, () => random());
  const at = (x: number, y: number, z: number) =>
    lattice[(wrap(z, period) * period + wrap(y, period)) * period + wrap(x, period)];
  return (x: number, y: number, z: number) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const fx = smooth(x - xi);
    const fy = smooth(y - yi);
    const fz = smooth(z - zi);
    const x0 = lerp(lerp(at(xi, yi, zi), at(xi + 1, yi, zi), fx), lerp(at(xi, yi + 1, zi), at(xi + 1, yi + 1, zi), fx), fy);
    const x1 = lerp(
      lerp(at(xi, yi, zi + 1), at(xi + 1, yi, zi + 1), fx),
      lerp(at(xi, yi + 1, zi + 1), at(xi + 1, yi + 1, zi + 1), fx),
      fy
    );
    return lerp(x0, x1, fz);
  };
};

/** 周期 cells の Worley ノイズ。最も近い特徴点までの距離（セル幅単位）と、そのセルの乱数を返す */
const periodicWorley = (cells: number, random: () => number) => {
  const count = cells ** 3;
  const offsets = Float32Array.from({ length: count * 3 }, () => random());
  const ids = Float32Array.from({ length: count }, () => random());
  return (x: number, y: number, z: number): [number, number] => {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    const cz = Math.floor(z);
    let best = Infinity;
    let bestId = 0;
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const index = (wrap(cz + dz, cells) * cells + wrap(cy + dy, cells)) * cells + wrap(cx + dx, cells);
          const px = cx + dx + offsets[index * 3] - x;
          const py = cy + dy + offsets[index * 3 + 1] - y;
          const pz = cz + dz + offsets[index * 3 + 2] - z;
          const d = px * px + py * py + pz * pz;
          if (d < best) {
            best = d;
            bestId = ids[index];
          }
        }
      }
    }
    return [Math.sqrt(best), bestId];
  };
};

/** 値の分布を 0..1 いっぱいに引き伸ばす（8bit の精度を無駄にしない） */
const normalize = (values: Float32Array) => {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    min = Math.min(min, v);
    max = Math.max(max, v);
  }
  const range = max - min || 1;
  return values.map((v) => (v - min) / range);
};

export const createNoise3DTexture = (): THREE.Data3DTexture => {
  const random = seededRandom(20261012);
  const coarse = [periodicValueNoise(4, random), periodicValueNoise(8, random), periodicValueNoise(16, random)];
  const fine = [periodicValueNoise(32, random), periodicValueNoise(64, random)];
  const worley = periodicWorley(8, random);
  const voxels = SIZE ** 3;
  const smoothChannel = new Float32Array(voxels);
  const fineChannel = new Float32Array(voxels);
  const data = new Uint8Array(voxels * 4);
  for (let z = 0; z < SIZE; z += 1) {
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const i = (z * SIZE + y) * SIZE + x;
        // テクセルの中心で評価する
        const u = (x + 0.5) / SIZE;
        const v = (y + 0.5) / SIZE;
        const w = (z + 0.5) / SIZE;
        smoothChannel[i] =
          coarse[0](u * 4, v * 4, w * 4) * 0.5 + coarse[1](u * 8, v * 8, w * 8) * 0.3 + coarse[2](u * 16, v * 16, w * 16) * 0.2;
        fineChannel[i] = fine[0](u * 32, v * 32, w * 32) * 0.6 + fine[1](u * 64, v * 64, w * 64) * 0.4;
        const [distance, id] = worley(u * 8, v * 8, w * 8);
        data[i * 4 + 2] = Math.min(255, distance * 255);
        data[i * 4 + 3] = id * 255;
      }
    }
  }
  const r = normalize(smoothChannel);
  const g = normalize(fineChannel);
  for (let i = 0; i < voxels; i += 1) {
    data[i * 4] = r[i] * 255;
    data[i * 4 + 1] = g[i] * 255;
  }

  const texture = new THREE.Data3DTexture(data, SIZE, SIZE, SIZE);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.wrapR = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  // 遠くで細かい模様がちらつかないよう、3D でもミップマップを作る
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
};

// ----- 共有 -----

let shared: THREE.Data3DTexture | null = null;
let users = 0;

/** 共有の 3D ノイズテクスチャ。マテリアルの作成時に呼ぶ（なければ作る） */
export const getNoise3D = (): THREE.Data3DTexture => {
  shared ??= createNoise3DTexture();
  return shared;
};

/** シーンが使い始めるときに呼ぶ。最後の利用者が release したらテクスチャを破棄する */
export const acquireNoise3D = (): THREE.Data3DTexture => {
  users += 1;
  return getNoise3D();
};

export const releaseNoise3D = () => {
  users = Math.max(0, users - 1);
  if (users > 0 || !shared) return;
  shared.dispose();
  shared = null;
};

/**
 * シェーダー側の宣言と読み出し関数。ユニフォーム uNoise3D には getNoise3D() を渡す。
 * noise3(p) は p = 1 で 1 周期（R: なめらか G: 細かい B: セル距離 A: セルの乱数）
 */
export const NOISE3D_GLSL = /* glsl */ `
  uniform sampler3D uNoise3D;
  vec4 noise3(vec3 p) {
    return texture(uNoise3D, p);
  }
`;

/** onBeforeCompile で shader.uniforms に足すユニフォーム */
export const noise3DUniform = () => ({ uNoise3D: { value: getNoise3D() } });
