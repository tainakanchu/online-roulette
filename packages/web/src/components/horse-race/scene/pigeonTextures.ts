import * as THREE from "three";

/**
 * ドバト（灰色の鳩）の羽毛質感用 3D プロシージャルテクスチャ（Data3DTexture）。
 *
 * 【用途】
 * 競馬ゲームのコース上にいるドバトの羽毛の微細な質感を表現するためのソリッドテクスチャ。
 * 鳩のモデル（全長約 0.5 ワールド単位）の全体色や模様（青灰色・翼帯・首の光沢）は頂点カラーで
 * 塗られているため、本テクスチャは羽毛 1 枚 1 枚の立体感・陰影・毛羽立ち・段差のディテールのみを担当する。
 * 30羽ほどの鳩の群れで描画されるため、テクスチャは 1 枚生成して全個体で共有する。
 *
 * 【サンプリング方法】
 * シェーダー内では鳩のローカル座標（モデル空間座標）を 0.12 で除算してサンプリングする:
 *   vec4 feather = texture(uPigeonFeathers, localPos / 0.12);
 * これにより、全長 0.5 の鳩 1 羽に対して長手方向に約 4.16 周期（1 周期あたり 6 枚、計約 25 枚の羽）の
 * 適切な密度で羽毛パターンがマッピングされる。
 *
 * 【各チャンネルの役割】
 * - R: 羽の重なり（鱗状に千鳥配置された羽の明暗。付け根側が暗く、先端の縁が明るい。平均約 0.50）。
 * - G: 羽軸と羽枝の細い筋（中心の縦軸と、斜めに走る高周波な細い線。平均約 0.50）。
 * - B: 羽の縁の柔らかい毛羽立ち（羽の輪郭・縁ほど 1.0、中心部は 0.0。光の透過やリムライト用）。
 * - A: 表面の高さ（羽の重なりの段差。付け根が低く先端が高い鋸歯状の高さマップ。平均約 0.50）。
 */

const SIZE = 48;
const CELLS = 6;
const CELL_SIZE = 8;
const FEATHER_LEN = 12.0;
const FEATHER_WIDTH = 9.2;

/**
 * 決定的擬似乱数生成器（mulberry32）。シード固定により毎回同一のテクスチャを再現する。
 * Why not: Math.random() は非決定的なため、クライアント間やリロードごとの同一性が保証されない。
 */
const createSeededRandom = (initialSeed: number) => {
  let seed = initialSeed;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const clamp = (val: number, min: number, max: number): number => {
  return Math.max(min, Math.min(max, val));
};

interface EvaluatedFeather {
  readonly tv: number;
  readonly tu: number;
  readonly du: number;
  readonly vy: number;
  readonly dx: number;
  readonly height: number;
  readonly jitter: number;
}

/**
 * ドバトの羽毛ディテール用 3D テクスチャ（Data3DTexture）を生成する。
 * 48x48x48 ボクセル、RGBA8、3 軸完全周期（シームレス）。
 */
export const createPigeonFeatherDetail = (): THREE.Data3DTexture => {
  const rng = createSeededRandom(12345);
  const cellJitter = new Float32Array(CELLS * CELLS * CELLS);
  for (let i = 0; i < cellJitter.length; i += 1) {
    cellJitter[i] = (rng() - 0.5) * 2.0;
  }

  const getJitter = (ci: number, cj: number, ck: number): number => {
    const wrappedI = ((ci % CELLS) + CELLS) % CELLS;
    const wrappedJ = ((cj % CELLS) + CELLS) % CELLS;
    const wrappedK = ((ck % CELLS) + CELLS) % CELLS;
    return cellJitter[(wrappedK * CELLS + wrappedJ) * CELLS + wrappedI];
  };

  const totalVoxels = SIZE * SIZE * SIZE;
  const data = new Uint8Array(totalVoxels * 4);
  let pixelIndex = 0;

  for (let z = 0; z < SIZE; z += 1) {
    const kCurr = Math.floor(z / CELL_SIZE);

    for (let y = 0; y < SIZE; y += 1) {
      const jCurr = Math.floor(y / CELL_SIZE);
      const jPrev = (jCurr + CELLS - 1) % CELLS;

      for (let x = 0; x < SIZE; x += 1) {
        let bestFeather: EvaluatedFeather | null = null;
        let maxEvaluationHeight = -1.0;

        // 手前の行の羽(jPrev)と現在の行の羽(jCurr)の2候補を比較して瓦状の重なりを求める。
        // Why not: 全セル探索は 48^3 ボクセルに対して重すぎるため、近傍の幾何学的候補に絞る。
        const candidateRows = [jPrev, jCurr];
        for (let candidateIndex = 0; candidateIndex < 2; candidateIndex += 1) {
          const cj = candidateRows[candidateIndex];
          const ck = kCurr;

          // 行・層ごとの千鳥配置（鱗状の互い違いパターン）
          const shiftX = ((cj + ck) & 1) * 4;
          const rx = x - shiftX;
          const ci = Math.round(rx / CELL_SIZE);
          let dx = rx - ci * CELL_SIZE;
          dx = ((dx + 24) % 48 + 48) % 48 - 24;

          let vy = y - cj * CELL_SIZE;
          vy = ((vy % 48) + 48) % 48;

          const isExceedingLength = vy > FEATHER_LEN;
          if (isExceedingLength) {
            continue;
          }

          const tv = vy / FEATHER_LEN;
          const cz = ck * CELL_SIZE + CELL_SIZE * 0.5;
          let dz = z - cz;
          dz = ((dz + 24) % 48 + 48) % 48 - 24;
          const tw = dz / (CELL_SIZE * 0.5);

          // 先端が丸いヘラ状の羽プロファイル
          const tu = dx / (FEATHER_WIDTH * 0.5);
          const wShape = Math.sin(Math.PI * Math.pow(tv, 0.55)) * 1.05 + 0.15;
          const du = Math.abs(tu) / wShape;

          const tipProfile = tv + 0.25 * du * du;
          const isOutsideFeatherBounds = tipProfile > 1.12 || Math.abs(tw) > 1.1;
          if (isOutsideFeatherBounds) {
            continue;
          }

          const hSlope = 0.25 + 0.60 * tv;
          const hCross = Math.max(0, 1.0 - 0.40 * du * du - 0.35 * tw * tw);
          const height = hSlope * hCross;

          // 手前の羽の先端が現在の羽の付け根の上に優先して重なるよう微小バイアスを付与
          const isPreviousRowFeather = candidateIndex === 0;
          const priorityBias = isPreviousRowFeather ? 0.04 : 0.0;
          const evaluatedHeightWithBias = height + priorityBias;

          const isHigherThanCurrentBest = evaluatedHeightWithBias > maxEvaluationHeight;
          if (isHigherThanCurrentBest) {
            maxEvaluationHeight = evaluatedHeightWithBias;
            bestFeather = {
              tv,
              tu,
              du,
              vy,
              dx,
              height,
              jitter: getJitter(ci, cj, ck),
            };
          }
        }

        let rVal = 0.5;
        let gVal = 0.5;
        let bVal = 0.0;
        let aVal = 0.5;

        const feather = bestFeather;
        const hasFeather = feather !== null;
        if (hasFeather) {

          // A チャンネル: 表面の高さ（付け根が低く先端が高い。平均約 0.50）
          aVal = clamp(feather.height * 0.90 + 0.11, 0.15, 0.90);

          // R チャンネル: 羽の重なり（付け根側が暗く、先端の縁が明るい。平均約 0.50）
          const baseR = 0.28 + 0.38 * feather.tv;
          const isTipArea = feather.tv > 0.75;
          const tipHighlight = isTipArea
            ? (feather.tv - 0.75) * 1.1 * (0.8 + 0.3 * feather.du)
            : 0.0;
          const isBaseArea = feather.tv < 0.28;
          const baseShadow = isBaseArea ? (0.28 - feather.tv) * 0.35 : 0.0;
          rVal = clamp(
            baseR + tipHighlight - baseShadow + feather.jitter * 0.04,
            0.15,
            0.95,
          );

          // G チャンネル: 羽軸と羽枝（羽 1 枚ごとの中心軸と斜めの細い筋。高周波。平均約 0.50）
          const shaftDist = Math.abs(feather.tu);
          const isShaftCenter = shaftDist < 0.09;
          const isShaftEdge = shaftDist < 0.18;
          let shaftContribution = 0.0;
          if (isShaftCenter) {
            shaftContribution = (1.0 - shaftDist / 0.09) * 0.22;
          } else if (isShaftEdge) {
            shaftContribution = -0.05;
          }
          const barbPhase =
            2.0 * Math.PI * (feather.vy * 0.95 - Math.abs(feather.dx) * 0.8);
          const barbs = Math.cos(barbPhase) * 0.18;
          gVal = clamp(0.425 + barbs + shaftContribution, 0.12, 0.88);

          // B チャンネル: 羽の縁の柔らかい毛羽立ち（縁ほど 1.0、中心部は 0.0）
          const edgeU = Math.max(0, (feather.du - 0.42) / 0.58);
          const edgeV = Math.max(0, (feather.tv - 0.65) / 0.35);
          const edgeDist = Math.max(edgeU, edgeV);
          const barbFringe = 0.85 + 0.15 * Math.max(0, Math.cos(barbPhase));
          bVal = clamp(Math.pow(edgeDist, 1.25) * barbFringe, 0.0, 1.0);
        }

        data[pixelIndex] = Math.round(rVal * 255);
        data[pixelIndex + 1] = Math.round(gVal * 255);
        data[pixelIndex + 2] = Math.round(bVal * 255);
        data[pixelIndex + 3] = Math.round(aVal * 255);
        pixelIndex += 4;
      }
    }
  }

  const texture = new THREE.Data3DTexture(data, SIZE, SIZE, SIZE);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.wrapR = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  // 遠距離でのモアレ・ちらつきを防ぐため、WebGL2 の gl.generateMipmap(TEXTURE_3D) を利用したミップマップを有効化
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;

  return texture;
};
