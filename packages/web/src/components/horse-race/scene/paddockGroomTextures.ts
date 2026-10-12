import * as THREE from "three";

/**
 * 競馬ゲームのパドック（出走馬を引いて周回する厩務員）の服と装具の質感用 3D プロシージャルテクスチャ群。
 *
 * 【用途】
 * JRA のパドックのように、レース前に出走馬を引いて周回する厩務員（groom）の服装と装具の微細な質感を
 * 表現するためのソリッド 3D テクスチャ（Data3DTexture 群）。
 * 厩務員の服装・装具の構成:
 * - 白い半袖のポロシャツ（鹿の子編み）
 * - 紺のスラックス（綾織り・摩擦による光沢）
 * - 黒い運動靴（合成皮革とゴム底・履きじわ）
 * - 黒い保護帽 / 乗馬用ヘルメット（艶のある樹脂・微細な擦り傷・マット部）
 * - 馬の引き手綱（ナイロン撚りロープ）
 * - 緑の腕章（フェルト / 織布の布目と毛羽立ち）
 *
 * 単位系はワールド座標（1m ≒ 1.5 単位）。
 * 色そのもの（ベースカラー）はモデル材質の色で決定するため、本テクスチャは
 * 明暗の揺らぎ・織り目・汚れ・粗さの揺らぎ・凹凸（高さ）を担当する。
 * シーン側のシェーダーにおいて、モデルのローカル座標を各関数の周期で割ってサンプリングする。
 * 中距離（2〜15 単位）で映るため、細かすぎる模様はミップマップで自然に平均化される振れ幅に設計されている。
 *
 * 【提供するテクスチャ関数】
 * 1. createPiqueKnitDetail(): ポロシャツの鹿の子編み（48^3, 周期 0.04）
 *    - R: 編み目の明暗、G: 汗じみ・しわの陰、B: 粗さ、A: 高さ（編み目の凸）
 * 2. createSlacksTwillDetail(): スラックスの綾織り（48^3, 周期 0.05）
 *    - R: 綾線、G: 膝・腿の擦れのてかり、B: 粗さ、A: 高さ
 * 3. createHelmetShellDetail(): 保護帽の殻（48^3, 周期 0.30）
 *    - R: 擦り傷、G: 汚れ、B: 粗さの揺らぎ、A: 高さ（傷の溝）
 * 4. createShoeLeatherDetail(): 黒い運動靴（48^3, 周期 0.15）
 *    - R: 皮のしぼ、G: 履きじわ、B: 粗さ、A: 高さ
 * 5. createLeadRopeDetail(): 引き手綱（48^3, 周期 0.12, Y 軸沿い）
 *    - R: 撚りの螺旋の明暗、G: 繊維の毛羽、B: 粗さ、A: 高さ（撚りの山）
 * 6. createArmbandDetail(): 腕章（48^3, 周期 0.06）
 *    - R: 布目、G: 毛羽、B: 粗さ、A: 高さ
 *
 * 【共通仕様】
 * - 形式: THREE.Data3DTexture (RGBA8, RGBAFormat, UnsignedByteType)
 * - ラップモード: wrapS / wrapT / wrapR = RepeatWrapping（3 軸すべてで完全シームレス・周期境界）
 * - フィルタ: minFilter = LinearMipmapLinearFilter, magFilter = LinearFilter, generateMipmaps = true, needsUpdate = true
 * - 決定性: mulberry32（固定シード）により環境やリロードに依存せず完全同一の結果を保証
 */

/**
 * 決定的擬似乱数生成器（mulberry32）。固定シードにより毎回同一のテクスチャを再現する。
 * Why not: Math.random() は非決定的なため、クライアント間やリロードごとの同一性が保証されない。
 */
const createSeededRandom = (initialSeed: number): (() => number) => {
  let seed = initialSeed;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const clamp = (val: number, min: number, max: number): number =>
  Math.max(min, Math.min(max, val));

const smooth = (t: number): number => t * t * (3 - 2 * t);

/**
 * 3 軸すべてで周期的な 3D バリューノイズテーブルをボリューム全体へ展開する高速ルーチン。
 *
 * 【どう実現しているか】
 * 格子点の乱数をトリリニア補間して Float32Array に展開する。
 * X 軸の格子インデックスと補間係数、Y 軸のラインオフセットを事前計算し、
 * スライス（Z）およびライン（Y）の外側ループで行ベースインデックスを算出することで内側ループを単純化。
 *
 * 【なぜ他の方法を採らなかったか】
 * ボクセルごとに関数呼び出しを行って格子点を参照・補間する方式では、
 * 数十万〜数百万回の呼び出しオーバーヘッドで 100ms 以上消費してしまうが、
 * 事前展開インデックスとインライン補間により数ミリ秒で全格子展開が完了するため。
 */
const createPeriodicNoise3D = (
  sizeX: number,
  sizeY: number,
  sizeZ: number,
  gridX: number,
  gridY: number,
  gridZ: number,
  rng: () => number
): Float32Array => {
  const lattice = Float32Array.from(
    { length: gridX * gridY * gridZ },
    () => rng()
  );
  const total = sizeX * sizeY * sizeZ;
  const output = new Float32Array(total);

  const xi0Arr = new Int32Array(sizeX);
  const xi1Arr = new Int32Array(sizeX);
  const fxArr = new Float32Array(sizeX);
  for (let x = 0; x < sizeX; x += 1) {
    const wx = (x / sizeX) * gridX;
    const xi = Math.floor(wx);
    xi0Arr[x] = xi % gridX;
    xi1Arr[x] = (xi + 1) % gridX;
    fxArr[x] = smooth(wx - xi);
  }

  const yi0Arr = new Int32Array(sizeY);
  const yi1Arr = new Int32Array(sizeY);
  const fyArr = new Float32Array(sizeY);
  for (let y = 0; y < sizeY; y += 1) {
    const wy = (y / sizeY) * gridY;
    const yi = Math.floor(wy);
    yi0Arr[y] = (yi % gridY) * gridX;
    yi1Arr[y] = ((yi + 1) % gridY) * gridX;
    fyArr[y] = smooth(wy - yi);
  }

  const gridSlice = gridY * gridX;

  for (let z = 0; z < sizeZ; z += 1) {
    const wz = (z / sizeZ) * gridZ;
    const zi = Math.floor(wz);
    const fz = smooth(wz - zi);
    const zOffset = z * sizeX * sizeY;
    const slice0 = (zi % gridZ) * gridSlice;
    const slice1 = ((zi + 1) % gridZ) * gridSlice;

    for (let y = 0; y < sizeY; y += 1) {
      const fy = fyArr[y];
      const yOffset = zOffset + y * sizeX;

      const row00 = slice0 + yi0Arr[y];
      const row10 = slice0 + yi1Arr[y];
      const row01 = slice1 + yi0Arr[y];
      const row11 = slice1 + yi1Arr[y];

      for (let x = 0; x < sizeX; x += 1) {
        const fx = fxArr[x];
        const xi0 = xi0Arr[x];
        const xi1 = xi1Arr[x];

        const x00 =
          lattice[row00 + xi0] +
          (lattice[row00 + xi1] - lattice[row00 + xi0]) * fx;
        const x10 =
          lattice[row10 + xi0] +
          (lattice[row10 + xi1] - lattice[row10 + xi0]) * fx;
        const y0 = x00 + (x10 - x00) * fy;

        const x01 =
          lattice[row01 + xi0] +
          (lattice[row01 + xi1] - lattice[row01 + xi0]) * fx;
        const x11 =
          lattice[row11 + xi0] +
          (lattice[row11 + xi1] - lattice[row11 + xi0]) * fx;
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
 * Why not: カラー空間（SRGBColorSpace）を適用するとシェーダー側で暗黙のガンマ補正が掛かり
 * 粗さや高さ、マスクなどの数値データが歪んでしまうため、既定の NoColorSpace（生データ）として設定する。
 */
const createData3D = (
  data: Uint8Array,
  width: number,
  height: number,
  depth: number
): THREE.Data3DTexture => {
  const texture = new THREE.Data3DTexture(data, width, height, depth);
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
 * 1. ポロシャツの鹿の子編み用 3D テクスチャ。
 *
 * 【サンプリング方法】
 * シェーダー内では衣服のローカル座標を 0.04 で除算してサンプリングする（1 周期 4cm、約 2.5mm ピッチ）:
 *   vec4 piqueTex = texture(uPiqueKnitDetail, localPos / 0.04);
 *
 * 【サイズ】
 * 48x48x48 ボクセル、RGBA8。
 *
 * 【各チャンネルの役割】
 * - R: 編み目の明暗（凸部のハイライトと凹みの影。平均約 0.50）。
 * - G: 汗じみ・しわの陰（低周波の自然な陰影・湿り気のむら。平均約 0.51）。
 * - B: 粗さ（綿ポロシャツ特有の乾いたざらつき。平均約 0.72）。
 * - A: 高さ（鹿の子編みのハニカム / 格子状凸凹。平均約 0.50）。
 */
export const createPiqueKnitDetail = (): THREE.Data3DTexture => {
  const SIZE = 48;
  const TOTAL = SIZE * SIZE * SIZE;
  const rng = createSeededRandom(1013904223);

  // 汗じみ・しわの陰（低周波ノイズ）
  const sweatNoiseCoarse = createPeriodicNoise3D(SIZE, SIZE, SIZE, 2, 2, 2, rng);
  const sweatNoiseFine = createPeriodicNoise3D(SIZE, SIZE, SIZE, 4, 4, 4, rng);
  // 糸の粗さ揺らぎ
  const yarnNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 8, 8, 8, rng);

  // 鹿の子編み（48 ボクセル中に 12 周期の格子凸凹）
  // Why not: 3D ループ内で Math.cos を 11 万回 x 複数回呼ぶと低速化するため、事前計算テーブルを利用する。
  const K = 12;
  const cosTable = new Float32Array(SIZE);
  for (let i = 0; i < SIZE; i += 1) {
    cosTable[i] = Math.cos(((i * K) / SIZE) * Math.PI * 2.0);
  }

  const data = new Uint8Array(TOTAL * 4);

  for (let z = 0; z < SIZE; z += 1) {
    const zOffset = z * SIZE * SIZE;
    const cz = cosTable[z];

    for (let y = 0; y < SIZE; y += 1) {
      const yOffset = zOffset + y * SIZE;
      const cy = cosTable[y];

      for (let x = 0; x < SIZE; x += 1) {
        const cx = cosTable[x];

        // 3D どの切断面でも等方的な鹿の子のハニカム・格子状凸凹
        // 対角波の合成により千鳥状の突起と窪みを表現
        const patternXY = cx * cy;
        const patternYZ = cy * cz;
        const patternZX = cz * cx;
        const pique = (patternXY + patternYZ + patternZX) * (1.0 / 3.0);

        // 低周波の汗じみ・しわ陰
        const sweat =
          sweatNoiseCoarse[yOffset + x] * 0.7 + sweatNoiseFine[yOffset + x] * 0.3;

        // R: 編み目の明暗（凸部が明るく、谷間が暗い）
        let r = 0.50 + pique * 0.30;
        r = clamp(r, 0.0, 1.0);

        // G: 汗じみ・しわの陰（低周波の明暗変化）
        let g = 0.40 + sweat * 0.20;
        g = clamp(g, 0.0, 1.0);

        // B: 粗さ（綿鹿の子の乾いた質感、凸部でわずかに粗い）
        let b = 0.72 + (yarnNoise[yOffset + x] - 0.5) * 0.14 + pique * 0.08;
        b = clamp(b, 0.0, 1.0);

        // A: 高さ（編み目の凸凹）
        let a = 0.50 + pique * 0.32;
        a = clamp(a, 0.0, 1.0);

        const idx = (yOffset + x) * 4;
        data[idx] = Math.round(r * 255);
        data[idx + 1] = Math.round(g * 255);
        data[idx + 2] = Math.round(b * 255);
        data[idx + 3] = Math.round(a * 255);
      }
    }
  }

  return createData3D(data, SIZE, SIZE, SIZE);
};

/**
 * 2. スラックスの綾織り用 3D テクスチャ。
 *
 * 【サンプリング方法】
 * シェーダー内では衣服のローカル座標を 0.05 で除算してサンプリングする（1 周期 5cm、綾線ピッチ約 2.5mm）:
 *   vec4 slacksTex = texture(uSlacksTwillDetail, localPos / 0.05);
 *
 * 【サイズ】
 * 48x48x48 ボクセル、RGBA8。
 *
 * 【各チャンネルの役割】
 * - R: 綾線（斜めに走るシャープな綾目の筋。平均約 0.50）。
 * - G: 膝・腿の擦れのてかり（低周波の摩擦領域マスク。平均約 0.47）。
 * - B: 粗さ（通常ウール/ポリエステル混紡は 0.65 付近、擦れ箇所で低下。平均約 0.58）。
 * - A: 高さ（綾線の細かな畝。平均約 0.50）。
 */
export const createSlacksTwillDetail = (): THREE.Data3DTexture => {
  const SIZE = 48;
  const TOTAL = SIZE * SIZE * SIZE;
  const rng = createSeededRandom(1664525);

  // 膝・腿の擦れ・てかり（低周波ノイズ）
  const sheenNoiseCoarse = createPeriodicNoise3D(SIZE, SIZE, SIZE, 2, 2, 2, rng);
  const sheenNoiseFine = createPeriodicNoise3D(SIZE, SIZE, SIZE, 4, 4, 4, rng);
  // 生地の毛羽・繊維むら
  const yarnNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 12, 12, 12, rng);

  // 綾線（48 ボクセル中に 16 周期の斜め波）
  // Why not: 周期境界を満たすため整数周期 K = 16 の余弦波を事前計算。
  const K = 16;
  const cosTable = new Float32Array(SIZE);
  for (let i = 0; i < SIZE; i += 1) {
    cosTable[i] = Math.cos(((i * K) / SIZE) * Math.PI * 2.0);
  }

  const data = new Uint8Array(TOTAL * 4);

  for (let z = 0; z < SIZE; z += 1) {
    const zOffset = z * SIZE * SIZE;

    for (let y = 0; y < SIZE; y += 1) {
      const yOffset = zOffset + y * SIZE;
      const phYZ = (y + z) % SIZE;

      for (let x = 0; x < SIZE; x += 1) {
        const phXY = (x + y) % SIZE;
        const phZX = (z + x) % SIZE;

        // 3D どの面でも斜めの綾線が現れる対角波
        const twill =
          (cosTable[phXY] + cosTable[phYZ] + cosTable[phZX]) * (1.0 / 3.0);

        // 擦れのてかり（低周波の大きなむら）
        const sheen =
          sheenNoiseCoarse[yOffset + x] * 0.7 + sheenNoiseFine[yOffset + x] * 0.3;

        // R: 綾線（畝の明暗）
        let r = 0.50 + twill * 0.28;
        r = clamp(r, 0.0, 1.0);

        // G: 擦れのてかり（低周波、擦れた部分は明るい光沢）
        let g = 0.30 + sheen * 0.40;
        g = clamp(g, 0.0, 1.0);

        // B: 粗さ（基底 0.65 から、擦れ箇所(sheen)で滑らかになり、綾線の谷でわずかに変化）
        let b = 0.68 - sheen * 0.24 + (yarnNoise[yOffset + x] - 0.5) * 0.10;
        b = clamp(b, 0.0, 1.0);

        // A: 高さ（綾線の畝）
        let a = 0.50 + twill * 0.25;
        a = clamp(a, 0.0, 1.0);

        const idx = (yOffset + x) * 4;
        data[idx] = Math.round(r * 255);
        data[idx + 1] = Math.round(g * 255);
        data[idx + 2] = Math.round(b * 255);
        data[idx + 3] = Math.round(a * 255);
      }
    }
  }

  return createData3D(data, SIZE, SIZE, SIZE);
};

/**
 * 3. 保護帽（乗馬用ヘルメット）の殻用 3D テクスチャ。
 *
 * 【サンプリング方法】
 * シェーダー内ではヘルメットのローカル座標を 0.30 で除算してサンプリングする（1 周期 30cm）:
 *   vec4 helmetTex = texture(uHelmetShellDetail, localPos / 0.30);
 *
 * 【サイズ】
 * 48x48x48 ボクセル、RGBA8。
 *
 * 【各チャンネルの役割】
 * - R: 擦り傷（細い線が点在するシャープな傷跡。大半は 0.0、傷で 0.8〜1.0。平均約 0.04）。
 * - G: 汚れ（砂埃・指紋などの低周波の汚れ。平均約 0.46）。
 * - B: 粗さの揺らぎ（艶のある樹脂部 0.10、マット部や擦れ箇所 0.50。平均約 0.13）。
 * - A: 高さ（傷の微細な溝。大半は 0.50、傷で 0.35〜0.40 に凹む。平均約 0.50）。
 */
export const createHelmetShellDetail = (): THREE.Data3DTexture => {
  const SIZE = 48;
  const TOTAL = SIZE * SIZE * SIZE;
  const rng = createSeededRandom(2246822519);

  // 汚れ（低周波ノイズ）
  const dirtNoiseCoarse = createPeriodicNoise3D(SIZE, SIZE, SIZE, 3, 3, 3, rng);
  const dirtNoiseFine = createPeriodicNoise3D(SIZE, SIZE, SIZE, 6, 6, 6, rng);

  // つや消しカバー・擦れ領域（中周波ノイズ）
  const matteNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 4, 4, 4, rng);

  // 擦り傷用ノイズ（細い線状のリッジノイズ）
  // Why not: 単純なボロノイ探索よりも周期 3D ノイズのリッジ（折れ線）を抽出する方が
  // 3 軸すべてでシームレスかつ高速に細い傷のネットワークを生成できるため。
  const scratchNoise1 = createPeriodicNoise3D(SIZE, SIZE, SIZE, 8, 8, 8, rng);
  const scratchNoise2 = createPeriodicNoise3D(SIZE, SIZE, SIZE, 12, 12, 12, rng);

  const data = new Uint8Array(TOTAL * 4);

  for (let i = 0; i < TOTAL; i += 1) {
    // 擦り傷の検出: ノイズ値の中心近傍を鋭角にマスク
    const sDist1 = Math.abs(scratchNoise1[i] - 0.5) * 2.0;
    const sDist2 = Math.abs(scratchNoise2[i] - 0.5) * 2.0;
    const scratchLine1 = sDist1 > 0.90 ? (sDist1 - 0.90) / 0.10 : 0.0;
    const scratchLine2 = sDist2 > 0.91 ? (sDist2 - 0.91) / 0.09 : 0.0;
    const scratch = Math.max(scratchLine1, scratchLine2);

    // 汚れ（低周波）
    const dirt = dirtNoiseCoarse[i] * 0.7 + dirtNoiseFine[i] * 0.3;

    // マット部・擦れ領域
    const matte = matteNoise[i];
    const isMatteArea = matte > 0.65;
    const matteFactor = isMatteArea ? (matte - 0.65) / 0.35 : 0.0;

    // R: 擦り傷（細い線が点在）
    let r = scratch;
    r = clamp(r, 0.0, 1.0);

    // G: 汚れ（低周波）
    let g = 0.35 + dirt * 0.26;
    g = clamp(g, 0.0, 1.0);

    // B: 粗さの揺らぎ（基本 0.10、マット部で 0.50、傷でわずかに粗い）
    let b = 0.10 + matteFactor * 0.40 + scratch * 0.25;
    b = clamp(b, 0.0, 1.0);

    // A: 高さ（傷の溝: 大半は 0.50、傷部分でわずかに凹む）
    let a = 0.50 - scratch * 0.15;
    a = clamp(a, 0.0, 1.0);

    const idx = i * 4;
    data[idx] = Math.round(r * 255);
    data[idx + 1] = Math.round(g * 255);
    data[idx + 2] = Math.round(b * 255);
    data[idx + 3] = Math.round(a * 255);
  }

  return createData3D(data, SIZE, SIZE, SIZE);
};

/**
 * 4. 黒い運動靴（合成皮革とゴム底）用 3D テクスチャ。
 *
 * 【サンプリング方法】
 * シェーダー内では靴のローカル座標を 0.15 で除算してサンプリングする（1 周期 15cm）:
 *   vec4 shoeTex = texture(uShoeLeatherDetail, localPos / 0.15);
 *
 * 【サイズ】
 * 48x48x48 ボクセル、RGBA8。
 *
 * 【各チャンネルの役割】
 * - R: 皮のしぼ（細かい粒状の凹凸パターン。平均約 0.50）。
 * - G: 履きじわ（屈曲部に生じる線状のしわ。大半は 0.0、しわで 0.7〜1.0。平均約 0.10）。
 * - B: 粗さ（合皮ベース 0.45、履きじわや擦れで 0.65。平均約 0.48）。
 * - A: 高さ（しぼの粒と履きじわの溝。平均約 0.48）。
 */
export const createShoeLeatherDetail = (): THREE.Data3DTexture => {
  const SIZE = 48;
  const TOTAL = SIZE * SIZE * SIZE;
  const rng = createSeededRandom(324398421);

  // 皮のしぼ（高周波セル・粒状ノイズ）
  const grainNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 16, 16, 16, rng);
  const grainNoise2 = createPeriodicNoise3D(SIZE, SIZE, SIZE, 12, 12, 12, rng);

  // 履きじわ（屈曲方向に走る異方的な折れ線）
  // 周期境界を満たす格子分割（X: 3, Y: 6, Z: 3）でしわの筋を生成
  const creaseNoise1 = createPeriodicNoise3D(SIZE, SIZE, SIZE, 3, 6, 3, rng);

  // 粗さの低周波むら
  const roughNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 3, 3, 3, rng);

  const data = new Uint8Array(TOTAL * 4);

  for (let i = 0; i < TOTAL; i += 1) {
    // 皮のしぼ（細かい粒）
    const grain = grainNoise[i] * 0.65 + grainNoise2[i] * 0.35;

    // 履きじわ（しわの溝の抽出）
    const cDist = Math.abs(creaseNoise1[i] - 0.5) * 2.0;
    const crease = cDist > 0.75 ? (cDist - 0.75) / 0.25 : 0.0;

    // R: 皮のしぼ（細かい粒の明暗）
    let r = 0.50 + (grain - 0.5) * 0.32;
    r = clamp(r, 0.0, 1.0);

    // G: 履きじわ（線状の溝マスク）
    let g = crease;
    g = clamp(g, 0.0, 1.0);

    // B: 粗さ（合皮の落ち着いた艶 0.45、しわと粒で揺らぐ）
    let b = 0.45 + (roughNoise[i] - 0.5) * 0.10 + crease * 0.20;
    b = clamp(b, 0.0, 1.0);

    // A: 高さ（しぼの粒凹凸 + しわの溝凹み）
    let a = 0.50 + (grain - 0.5) * 0.16 - crease * 0.18;
    a = clamp(a, 0.0, 1.0);

    const idx = i * 4;
    data[idx] = Math.round(r * 255);
    data[idx + 1] = Math.round(g * 255);
    data[idx + 2] = Math.round(b * 255);
    data[idx + 3] = Math.round(a * 255);
  }

  return createData3D(data, SIZE, SIZE, SIZE);
};

/**
 * 5. 引き手綱（ナイロンの撚りロープ）用 3D テクスチャ。
 *
 * 【サンプリング方法】
 * ロープの中心軸はテクスチャの Y 軸に沿う。
 * シェーダー内ではロープのローカル座標を 0.12 で除算してサンプリングする（1 周期 12cm、撚りピッチ約 2.4cm）:
 *   vec4 ropeTex = texture(uLeadRopeDetail, localPos / 0.12);
 *
 * 【サイズ】
 * 48x48x48 ボクセル、RGBA8。
 *
 * 【各チャンネルの役割】
 * - R: 撚りの螺旋の明暗（Y 方向に斜めに巻く 3 本撚り筋の明暗。平均約 0.50）。
 * - G: 繊維の毛羽（ナイロン繊維の細かな毛羽立ち・高周波ノイズ。平均約 0.50）。
 * - B: 粗さ（ナイロン撚り糸の粗さ。平均約 0.60）。
 * - A: 高さ（撚りの山と谷の凹凸。平均約 0.50）。
 */
export const createLeadRopeDetail = (): THREE.Data3DTexture => {
  const SIZE = 48;
  const TOTAL = SIZE * SIZE * SIZE;
  const rng = createSeededRandom(77889911);

  // 繊維の毛羽（高周波ノイズ）
  const fuzzNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 16, 16, 16, rng);
  // 色・粗さのうねり（中低周波ノイズ）
  const yarnNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 4, 8, 4, rng);

  // Y 軸に沿って螺旋状に巻く 3 本撚りロープの幾何
  // 周期境界を満たすため、Y 方向ピッチは SIZE 中に 5 周期（K_Y = 5）とし、
  // XZ 平面の角度 theta に対して 3 本のストランド（3 * theta）を合成する。
  const K_Y = 5;
  const TWO_PI = Math.PI * 2.0;

  // XZ 平面の角度 theta を事前計算
  // Why not: 内側ループ内で Math.atan2 を 11 万回呼ぶと低速化するため、XZ 断面でテーブル化する。
  const angleXZ = new Float32Array(SIZE * SIZE);
  for (let z = 0; z < SIZE; z += 1) {
    const pz = (z / SIZE - 0.5) * 2.0;
    const zRow = z * SIZE;
    for (let x = 0; x < SIZE; x += 1) {
      const px = (x / SIZE - 0.5) * 2.0;
      let th = Math.atan2(pz, px);
      if (th < 0) {
        th += TWO_PI;
      }
      angleXZ[zRow + x] = th;
    }
  }

  const data = new Uint8Array(TOTAL * 4);

  for (let y = 0; y < SIZE; y += 1) {
    // Y 方向の螺旋位相オフセット（周期境界を満たす）
    const yPhase = (y / SIZE) * K_Y * TWO_PI;

    for (let z = 0; z < SIZE; z += 1) {
      const zOffset = z * SIZE * SIZE;
      const zRow = z * SIZE;

      for (let x = 0; x < SIZE; x += 1) {
        const th = angleXZ[zRow + x];
        // 3 本撚りストランドの螺旋位相
        const spiralPhase = 3.0 * th + yPhase;
        const strandProfile = Math.cos(spiralPhase);

        // 高周波のナイロン毛羽
        const vIdx = zOffset + y * SIZE + x;
        const fuzz = fuzzNoise[vIdx];

        // R: 撚りの螺旋の明暗（山のハイライトと谷のシャドウ）
        let r = 0.50 + strandProfile * 0.32;
        r = clamp(r, 0.0, 1.0);

        // G: 繊維の毛羽（高周波の明暗変動）
        let g = 0.50 + (fuzz - 0.5) * 0.32;
        g = clamp(g, 0.0, 1.0);

        // B: 粗さ（ナイロンの粗さ 0.60 付近 + 谷間でわずかに粗さ上昇）
        let b = 0.60 + (yarnNoise[vIdx] - 0.5) * 0.12 - strandProfile * 0.06;
        b = clamp(b, 0.0, 1.0);

        // A: 高さ（撚りの山の突出と谷間の窪み）
        let a = 0.50 + strandProfile * 0.30;
        a = clamp(a, 0.0, 1.0);

        const idx = vIdx * 4;
        data[idx] = Math.round(r * 255);
        data[idx + 1] = Math.round(g * 255);
        data[idx + 2] = Math.round(b * 255);
        data[idx + 3] = Math.round(a * 255);
      }
    }
  }

  return createData3D(data, SIZE, SIZE, SIZE);
};

/**
 * 6. 腕章（フェルト / 布）用 3D テクスチャ。
 *
 * 【サンプリング方法】
 * シェーダー内では腕章のローカル座標を 0.06 で除算してサンプリングする（1 周期 6cm、布目ピッチ約 3mm）:
 *   vec4 armTex = texture(uArmbandDetail, localPos / 0.06);
 *
 * 【サイズ】
 * 48x48x48 ボクセル、RGBA8。
 *
 * 【各チャンネルの役割】
 * - R: 布目（平織り / フェルト地の細かな直交織り目。平均約 0.50）。
 * - G: 毛羽（フェルト特有のふわりとしたランダム毛羽立ち。平均約 0.50）。
 * - B: 粗さ（布・フェルトのマットな高い粗さ。平均約 0.78）。
 * - A: 高さ（布目の微細な起伏。平均約 0.50）。
 */
export const createArmbandDetail = (): THREE.Data3DTexture => {
  const SIZE = 48;
  const TOTAL = SIZE * SIZE * SIZE;
  const rng = createSeededRandom(55443322);

  // 毛羽立ち（高周波ノイズ）
  const fuzzNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 24, 24, 24, rng);
  // 布の染め・密度むら（低周波ノイズ）
  const weaveNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 4, 4, 4, rng);

  // 布目の直交グリッド波（48 ボクセル中に 16 周期、ピッチ 3mm）
  const K = 16;
  const cosTable = new Float32Array(SIZE);
  for (let i = 0; i < SIZE; i += 1) {
    cosTable[i] = Math.cos(((i * K) / SIZE) * Math.PI * 2.0);
  }

  const data = new Uint8Array(TOTAL * 4);

  for (let z = 0; z < SIZE; z += 1) {
    const zOffset = z * SIZE * SIZE;
    const cz = cosTable[z];

    for (let y = 0; y < SIZE; y += 1) {
      const yOffset = zOffset + y * SIZE;
      const cy = cosTable[y];

      for (let x = 0; x < SIZE; x += 1) {
        const cx = cosTable[x];

        // 3D どの切断面でも均質に見える織り目グリッド
        const gridXY = cx * cy;
        const gridYZ = cy * cz;
        const gridZX = cz * cx;
        const weave = (gridXY + gridYZ + gridZX) * (1.0 / 3.0);

        const vIdx = yOffset + x;
        const fuzz = fuzzNoise[vIdx];
        const density = weaveNoise[vIdx];

        // R: 布目（織り目の明暗）
        let r = 0.50 + weave * 0.22 + (density - 0.5) * 0.10;
        r = clamp(r, 0.0, 1.0);

        // G: 毛羽（フェルト特有の高周波毛羽立ち）
        let g = 0.50 + (fuzz - 0.5) * 0.32;
        g = clamp(g, 0.0, 1.0);

        // B: 粗さ（フェルト布の強いマット質感、平均 0.78 付近）
        let b = 0.78 + (fuzz - 0.5) * 0.12 - weave * 0.05;
        b = clamp(b, 0.0, 1.0);

        // A: 高さ（布目の細かな凹凸）
        let a = 0.50 + weave * 0.20 + (fuzz - 0.5) * 0.08;
        a = clamp(a, 0.0, 1.0);

        const idx = vIdx * 4;
        data[idx] = Math.round(r * 255);
        data[idx + 1] = Math.round(g * 255);
        data[idx + 2] = Math.round(b * 255);
        data[idx + 3] = Math.round(a * 255);
      }
    }
  }

  return createData3D(data, SIZE, SIZE, SIZE);
};
