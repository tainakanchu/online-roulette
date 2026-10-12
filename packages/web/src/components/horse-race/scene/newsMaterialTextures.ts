import * as THREE from "three";

/**
 * 夜のニュース番組スタジオおよびキャスター質感用 3D プロシージャルテクスチャ（Data3DTexture 群）。
 *
 * 【用途】
 * 競馬ゲームのレース後に放映される夜のニュース番組スタジオ（日本の報道スタジオ: 濃紺 x 白 x ヒノキの木目、
 * 青白い光のライン、艶のある床）とキャスター2人（スーツ、髪、肌）の微細な質感を表現するソリッドテクスチャ。
 * スタジオは単位 = メートル。色そのもの（ベースカラー）はモデルのマテリアルで決めるため、
 * 本テクスチャは色の明暗の揺らぎ・模様・凹凸（高さ）・粗さの揺らぎを担当する。
 *
 * 【提供するテクスチャ関数】
 * 1. createStudioFloorDetail(): スタジオ床（濃紺の艶のある石材 / テラゾー）。96^3。サンプリング: ワールド座標 / 1.6
 * 2. createDeskStoneDetail(): デスク天板（白い人工大理石）。64^3。サンプリング: ローカル座標 / 0.8
 * 3. createHinokiGrain(): ヒノキの木目（腰板・縦格子）。64^3。サンプリング: ローカル座標 / 0.5
 * 4. createWoolTwillDetail(): スーツのウール（綾織り）。64^3。サンプリング: ローカル座標 / 0.05
 * 5. createHairStrandDetail(): 髪の毛束。64^3。サンプリング: ローカル座標 / 0.08
 * 6. createSkinDetail(): 肌（寄りのカット用）。48^3。サンプリング: ローカル座標 / 0.04
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

const wrap = (i: number, period: number): number => ((i % period) + period) % period;
const smooth = (t: number): number => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp = (val: number, min: number, max: number): number => Math.max(min, Math.min(max, val));

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
  const lattice = Float32Array.from({ length: gridX * gridY * gridZ }, () => rng());
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

        const x00 = lattice[row00 + xi0] + (lattice[row00 + xi1] - lattice[row00 + xi0]) * fx;
        const x10 = lattice[row10 + xi0] + (lattice[row10 + xi1] - lattice[row10 + xi0]) * fx;
        const y0 = x00 + (x10 - x00) * fy;

        const x01 = lattice[row01 + xi0] + (lattice[row01 + xi1] - lattice[row01 + xi0]) * fx;
        const x11 = lattice[row11 + xi0] + (lattice[row11 + xi1] - lattice[row11 + xi0]) * fx;
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
 * 1. スタジオの床（濃紺の艶のある石材 / テラゾー）用 3D テクスチャ。
 *
 * 【サンプリング方法】
 * シェーダー内ではワールド座標を 1.6 で除算してサンプリングする（1 周期 1.6m）:
 *   vec4 floorTex = texture(uStudioFloorDetail, worldPos / 1.6);
 *
 * 【サイズ】
 * 96x96x96 ボクセル、RGBA8。
 *
 * 【各チャンネルの役割】
 * - R: 石の明暗のむら（大きめの雲状のむら + 細い白っぽい石目（ベイン）。平均約 0.49〜0.50）。
 * - G: 細かな粒（テラゾーの骨材の粒・きらめき。大半は 0.5 付近、粒が 0.8〜1.0。平均約 0.52）。
 * - B: 粗さの揺らぎ（研磨むら・拭き跡のような低周波。0 = 鏡面、1 = ざらつき。平均約 0.30）。
 * - A: 高さ（ほぼ平ら。粒の縁と石目のごくわずかな段差。平均約 0.50）。
 */
export const createStudioFloorDetail = (): THREE.Data3DTexture => {
  const SIZE = 96;
  const TOTAL = SIZE * SIZE * SIZE;
  const rng = createSeededRandom(987654321);

  // 雲状のむら (低周波) と 石目 (中周波ベイン)、骨材 (高周波)、粗さ (低周波)
  const cloudNoiseCoarse = createPeriodicNoise3D(SIZE, SIZE, SIZE, 3, 3, 3, rng);
  const cloudNoiseMid = createPeriodicNoise3D(SIZE, SIZE, SIZE, 6, 6, 6, rng);
  const veinNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 6, 6, 6, rng);
  const aggregateNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 24, 24, 24, rng);
  const roughnessNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 3, 3, 3, rng);

  const data = new Uint8Array(TOTAL * 4);

  for (let i = 0; i < TOTAL; i += 1) {
    // --- R: 石の明暗のむら (雲状のむら + 細い白っぽいベイン。平均 0.5) ---
    const cloud = cloudNoiseCoarse[i] * 0.65 + cloudNoiseMid[i] * 0.35;
    const veinDist = Math.abs(veinNoise[i] - 0.5) * 2.0;
    const veinSharp = 1.0 - smooth(Math.min(1.0, veinDist * 5.5));
    let r = 0.44 + (cloud - 0.5) * 0.28 + veinSharp * 0.28;
    r = clamp(r, 0.0, 1.0);

    // --- G: 細かな粒（テラゾー骨材の粒・きらめき。大半は 0.5 付近、粒が 0.8〜1.0） ---
    const agg = aggregateNoise[i];
    let g = 0.50 + (agg - 0.5) * 0.05;
    const isAggregate = agg > 0.81;
    if (isAggregate) {
      const t = (agg - 0.81) / 0.19;
      g = 0.80 + 0.20 * t;
    }

    // --- B: 粗さの揺らぎ（研磨むら・拭き跡のような低周波。平均 0.3） ---
    let b = 0.30 + (roughnessNoise[i] - 0.5) * 0.22;
    b = clamp(b, 0.0, 1.0);

    // --- A: 高さ（ほぼ平ら。粒の縁と石目のごくわずかな段差。平均 0.5） ---
    let a = 0.50 + veinSharp * 0.02 + (isAggregate ? 0.03 : -0.005);
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
 * 2. デスクの天板（白い人工大理石）用 3D テクスチャ。
 *
 * 【サンプリング方法】
 * シェーダー内では天板のローカル座標を 0.8 で除算してサンプリングする:
 *   vec4 deskTex = texture(uDeskStoneDetail, localPos / 0.8);
 *
 * 【サイズ】
 * 64x64x64 ボクセル、RGBA8。
 *
 * 【各チャンネルの役割】
 * - R: 薄い灰色の流れるような石目（白地の中に、ごく淡い筋がゆるく流れる。平均約 0.50、振れ幅小さめ）。
 * - G: 細かな粒子（ごく淡いミネラル粒子。平均約 0.50）。
 * - B: 粗さの揺らぎ（鏡面に近い滑らかな仕上げ。平均約 0.20）。
 * - A: 高さ（研磨されたほぼ平らな面。平均約 0.50）。
 */
export const createDeskStoneDetail = (): THREE.Data3DTexture => {
  const SIZE = 64;
  const TOTAL = SIZE * SIZE * SIZE;
  const rng = createSeededRandom(123456789);

  const flowNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 4, 4, 4, rng);
  const grainNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 16, 16, 16, rng);
  const roughNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 2, 2, 2, rng);

  // Math.sin を事前テーブル化 (256 要素)
  // Why not: 26 万回のループ内で Math.sin を直接評価すると関数呼び出し負荷が無視できないため。
  const sinLut = new Float32Array(256);
  for (let i = 0; i < 256; i += 1) {
    sinLut[i] = Math.sin((i / 256) * Math.PI * 4.0) * 0.5 + 0.5;
  }

  const data = new Uint8Array(TOTAL * 4);

  for (let i = 0; i < TOTAL; i += 1) {
    // --- R: 薄い灰色の流れるような石目 (平均 0.5、振れ幅小さめ) ---
    const flow = flowNoise[i];
    const lutIdx = Math.floor(clamp(flow, 0.0, 0.999) * 256);
    const vein = sinLut[lutIdx];
    let r = 0.50 + (vein - 0.5) * 0.12;
    r = clamp(r, 0.0, 1.0);

    // --- G: 細かな粒子（ごく淡い） ---
    let g = 0.50 + (grainNoise[i] - 0.5) * 0.08;
    g = clamp(g, 0.0, 1.0);

    // --- B: 粗さの揺らぎ（平均 0.2） ---
    let b = 0.20 + (roughNoise[i] - 0.5) * 0.10;
    b = clamp(b, 0.0, 1.0);

    // --- A: 高さ（ほぼ平ら） ---
    let a = 0.50 + (grainNoise[i] - 0.5) * 0.02;
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
 * 3. ヒノキの木目（デスクの腰板と縦格子）用 3D テクスチャ。
 *
 * 【サンプリング方法】
 * 木目（年輪の筋）はテクスチャの Y 軸に沿って伸びる。
 * シェーダー側では板の長手方向が Y 軸になるようにローカル座標を配置し、0.5 で除算してサンプリングする:
 *   vec4 hinokiTex = texture(uHinokiGrain, localPos / 0.5);
 *
 * 【サイズ】
 * 64x64x64 ボクセル、RGBA8。
 *
 * 【各チャンネルの役割】
 * - R: 年輪の明暗（夏目・冬目。柾目〜板目の模様になるよう中心軸を揺らがせる。平均約 0.50）。
 * - G: 導管・繊維の細い筋（Y 方向の細かなストリーク。平均約 0.50）。
 * - B: 節や色むら（ごくまれに小さな節。大半は 0.0、節の中心で最大約 0.85）。
 * - A: 高さ（木目に沿ったわずかな凹凸。平均約 0.50）。
 */
export const createHinokiGrain = (): THREE.Data3DTexture => {
  const SIZE = 64;
  const TOTAL = SIZE * SIZE * SIZE;
  const rng = createSeededRandom(314159265);

  // Y 方向の低周波揺らぎテーブル
  const wobbleTableX = new Float32Array(SIZE);
  const wobbleTableZ = new Float32Array(SIZE);
  const yRng = createSeededRandom(555444333);
  const yLatticeX = Float32Array.from({ length: 4 }, () => yRng());
  const yLatticeZ = Float32Array.from({ length: 4 }, () => yRng());

  for (let y = 0; y < SIZE; y += 1) {
    const wy = (y / SIZE) * 4;
    const yi = Math.floor(wy);
    const fy = smooth(wy - yi);
    wobbleTableX[y] = lerp(yLatticeX[yi % 4], yLatticeX[(yi + 1) % 4], fy) * 0.3 - 0.15;
    wobbleTableZ[y] = lerp(yLatticeZ[yi % 4], yLatticeZ[(yi + 1) % 4], fy) * 0.3 - 0.15;
  }

  const fiberNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 16, 2, 16, rng);

  // 年輪波形の事前ルックアップテーブル (512 要素)
  // Why not: 毎ボクセルで Math.sin と Math.pow を実行すると遅延するため、波形を事前展開して高速化。
  const ringLut = new Float32Array(512);
  for (let i = 0; i < 512; i += 1) {
    const rawWave = Math.sin((i / 512) * Math.PI * 2.0) * 0.5 + 0.5;
    ringLut[i] = Math.pow(rawWave, 2.5);
  }

  const data = new Uint8Array(TOTAL * 4);

  // トーラス上で周期的な三角関数座標を事前計算
  const cosX = new Float32Array(SIZE);
  const sinZ = new Float32Array(SIZE);
  for (let i = 0; i < SIZE; i += 1) {
    const angle = (i / SIZE) * Math.PI * 2.0;
    cosX[i] = Math.cos(angle);
    sinZ[i] = Math.sin(angle);
  }

  // 1 箇所だけ小さな節 (knot) を配置 (大半は 0)
  const knotX = 28;
  const knotY = 32;
  const knotZ = 36;
  const knotRadius = 4.0;
  const halfSize = SIZE * 0.5;

  for (let z = 0; z < SIZE; z += 1) {
    let dzKnot = (z - knotZ) % SIZE;
    const isDzOverPositive = dzKnot > halfSize;
    if (isDzOverPositive) {
      dzKnot -= SIZE;
    } else {
      const isDzOverNegative = dzKnot < -halfSize;
      if (isDzOverNegative) {
        dzKnot += SIZE;
      }
    }

    const zOffset = z * SIZE * SIZE;

    for (let y = 0; y < SIZE; y += 1) {
      let dyKnot = (y - knotY) % SIZE;
      const isDyOverPositive = dyKnot > halfSize;
      if (isDyOverPositive) {
        dyKnot -= SIZE;
      } else {
        const isDyOverNegative = dyKnot < -halfSize;
        if (isDyOverNegative) {
          dyKnot += SIZE;
        }
      }
      dyKnot *= 1.5;

      const yOffset = zOffset + y * SIZE;
      const wobbleX = wobbleTableX[y];
      const wobbleZ = wobbleTableZ[y];

      // 年輪中心のオフセット（板目を模した位置）
      const centerX = 0.65 + wobbleX;
      const centerZ = 0.50 + wobbleZ;

      for (let x = 0; x < SIZE; x += 1) {
        let dxKnot = (x - knotX) % SIZE;
        const isDxOverPositive = dxKnot > halfSize;
        if (isDxOverPositive) {
          dxKnot -= SIZE;
        } else {
          const isDxOverNegative = dxKnot < -halfSize;
          if (isDxOverNegative) {
            dxKnot += SIZE;
          }
        }

        const knotDist = Math.sqrt(dxKnot * dxKnot + dyKnot * dyKnot + dzKnot * dzKnot);

        // トーラス空間でのシームレスな距離
        const px = cosX[x] - centerX;
        const pz = sinZ[z] - centerZ;
        const rDist = Math.sqrt(px * px + pz * pz);

        const ringPhase = rDist * 11.0;
        const lutIdx = Math.floor((ringPhase - Math.floor(ringPhase)) * 512);
        const winterGrain = ringLut[lutIdx];

        // R: 年輪の明暗（白っぽい地に淡い筋。平均約 0.50）
        let r = 0.58 - winterGrain * 0.22;
        r = clamp(r, 0.0, 1.0);

        // G: 導管・繊維の細い筋（平均約 0.50）
        const fiber = fiberNoise[yOffset + x];
        let g = 0.50 + (fiber - 0.5) * 0.18;
        g = clamp(g, 0.0, 1.0);

        // B: 節や色むら（ごくまれに小さな節。大半は 0）
        let b = 0.0;
        const isInsideKnot = knotDist < knotRadius;
        if (isInsideKnot) {
          const t = 1.0 - knotDist / knotRadius;
          b = smooth(t) * 0.85;
        }

        // A: 高さ（木目に沿ったわずかな凹凸。平均約 0.50）
        let a = 0.50 + (winterGrain - 0.25) * 0.08;
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
 * 4. スーツのウール（綾織り）用 3D テクスチャ。
 *
 * 【サンプリング方法】
 * シェーダー内では衣服のローカル座標を 0.05 で除算してサンプリングする（1 周期 5cm、綾目ピッチ約 2mm）:
 *   vec4 woolTex = texture(uWoolTwillDetail, localPos / 0.05);
 *
 * 【サイズ】
 * 64x64x64 ボクセル、RGBA8。
 *
 * 【各チャンネルの役割】
 * - R: 織り目（綾線の明暗。3D のどの断面でも斜めの綾線が見える。平均約 0.50）。
 * - G: 繊維の毛羽（高周波のノイズ。平均約 0.50）。
 * - B: 糸の色むら（低周波。平均約 0.50）。
 * - A: 高さ（綾線の凹凸。平均約 0.50）。
 */
export const createWoolTwillDetail = (): THREE.Data3DTexture => {
  const SIZE = 64;
  const TOTAL = SIZE * SIZE * SIZE;
  const rng = createSeededRandom(271828182);

  const fuzzNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 32, 32, 32, rng);
  const yarnNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 4, 4, 4, rng);

  // ピッチ 2mm 前後（64 ボクセルで 24 周期）
  const K = 24;
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

        // 3D のどの断面でも斜めの綾線が見える対角波の合成
        const twill1 = cosTable[phXY];
        const twill2 = cosTable[phYZ];
        const twill3 = cosTable[phZX];
        const twill = (twill1 + twill2 + twill3) * (1.0 / 3.0);

        // 経糸と緯糸の微細な交差感
        const yarnGrid =
          (cosTable[x] * cosTable[y] + cosTable[y] * cosTable[z] + cosTable[z] * cosTable[x]) *
          (1.0 / 3.0);

        // R: 織り目（綾線の明暗。平均約 0.50）
        let r = 0.50 + twill * 0.28 + yarnGrid * 0.08;
        r = clamp(r, 0.0, 1.0);

        // G: 繊維の毛羽（高周波ノイズ。平均約 0.50）
        let g = 0.50 + (fuzzNoise[yOffset + x] - 0.5) * 0.35;
        g = clamp(g, 0.0, 1.0);

        // B: 糸の色むら（低周波。平均約 0.50）
        let b = 0.50 + (yarnNoise[yOffset + x] - 0.5) * 0.25;
        b = clamp(b, 0.0, 1.0);

        // A: 高さ（綾線の凹凸。平均約 0.50）
        let a = 0.50 + twill * 0.26;
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
 * 5. 髪の毛束用 3D テクスチャ。
 *
 * 【サンプリング方法】
 * 毛の流れはテクスチャの Y 軸に沿う。
 * シェーダー内では頭部・髪のローカル座標を 0.08 で除算してサンプリングする:
 *   vec4 hairTex = texture(uHairStrandDetail, localPos / 0.08);
 *
 * 【サイズ】
 * 64x64x64 ボクセル、RGBA8。
 *
 * 【各チャンネルの役割】
 * - R: 毛束の明暗（Y 方向に長く伸びた細い筋の束。束ごとに明るさが異なる。平均約 0.50）。
 * - G: 束の境目の暗い溝（0 = 溝、1 = 束の中央。平均約 0.38）。
 * - B: 異方性ハイライトのずらし量（束ごとのランダムなオフセット。平均約 0.50）。
 * - A: 高さ（束の膨らみ。平均約 0.55）。
 */
export const createHairStrandDetail = (): THREE.Data3DTexture => {
  const SIZE = 64;
  const TOTAL = SIZE * SIZE * SIZE;
  const rng = createSeededRandom(8675309);

  // XZ 平面の毛束グリッド (8x8 = 64 束)
  const CELLS_XZ = 8;
  const CELL_SIZE = SIZE / CELLS_XZ; // 8
  const strandOffsetX = new Float32Array(CELLS_XZ * CELLS_XZ);
  const strandOffsetZ = new Float32Array(CELLS_XZ * CELLS_XZ);
  const strandBright = new Float32Array(CELLS_XZ * CELLS_XZ);
  const strandShift = new Float32Array(CELLS_XZ * CELLS_XZ);

  for (let i = 0; i < CELLS_XZ * CELLS_XZ; i += 1) {
    strandOffsetX[i] = (rng() - 0.5) * 3.5;
    strandOffsetZ[i] = (rng() - 0.5) * 3.5;
    strandBright[i] = 0.35 + rng() * 0.30;
    strandShift[i] = 0.25 + rng() * 0.50;
  }

  // XZ 平面の毛束プロファイルを 64x64 で事前展開
  // Why not: 3D ループ内で 26 万ボクセル x 9 セル探索（235 万回）を実行すると著しく遅延するため、
  // XZ 断面の毛束幾何を事前計算して参照し、Y 方向のうねりオフセットを加えることで劇的に高速化する。
  const xzGroove = new Float32Array(SIZE * SIZE);
  const xzHeight = new Float32Array(SIZE * SIZE);
  const xzShift = new Float32Array(SIZE * SIZE);
  const xzBright = new Float32Array(SIZE * SIZE);
  const halfSize = SIZE * 0.5;

  for (let z = 0; z < SIZE; z += 1) {
    const cellZ = Math.floor(z / CELL_SIZE);
    const zRow = z * SIZE;

    for (let x = 0; x < SIZE; x += 1) {
      const cellX = Math.floor(x / CELL_SIZE);

      let minDistSq = 1e9;
      let bestCellIdx = 0;

      for (let cz = -1; cz <= 1; cz += 1) {
        const gz = wrap(cellZ + cz, CELLS_XZ);
        const baseZ = (cellZ + cz) * CELL_SIZE + CELL_SIZE * 0.5;

        for (let cx = -1; cx <= 1; cx += 1) {
          const gx = wrap(cellX + cx, CELLS_XZ);
          const cIdx = gz * CELLS_XZ + gx;
          const baseX = (cellX + cx) * CELL_SIZE + CELL_SIZE * 0.5;

          const targetX = baseX + strandOffsetX[cIdx];
          const targetZ = baseZ + strandOffsetZ[cIdx];

          let dx = (x - targetX) % SIZE;
          const isDxOverPositive = dx > halfSize;
          if (isDxOverPositive) {
            dx -= SIZE;
          } else {
            const isDxOverNegative = dx < -halfSize;
            if (isDxOverNegative) {
              dx += SIZE;
            }
          }

          let dz = (z - targetZ) % SIZE;
          const isDzOverPositive = dz > halfSize;
          if (isDzOverPositive) {
            dz -= SIZE;
          } else {
            const isDzOverNegative = dz < -halfSize;
            if (isDzOverNegative) {
              dz += SIZE;
            }
          }

          const distSq = dx * dx + dz * dz;
          const isCloser = distSq < minDistSq;
          if (isCloser) {
            minDistSq = distSq;
            bestCellIdx = cIdx;
          }
        }
      }

      const dist = Math.sqrt(minDistSq);
      const normDist = clamp(dist / (CELL_SIZE * 0.65), 0.0, 1.0);

      const idx = zRow + x;
      xzGroove[idx] = smooth(1.0 - normDist);
      xzHeight[idx] = clamp(0.18 + 0.64 * (1.0 - normDist * normDist), 0.0, 1.0);
      xzShift[idx] = strandShift[bestCellIdx];
      xzBright[idx] = strandBright[bestCellIdx];
    }
  }

  // Y 方向のゆるやかなうねり (周期ノイズ)
  const waveTableX = new Int32Array(SIZE);
  const waveTableZ = new Int32Array(SIZE);
  const yRng = createSeededRandom(11223344);
  const yLattX = Float32Array.from({ length: 4 }, () => yRng());
  const yLattZ = Float32Array.from({ length: 4 }, () => yRng());
  for (let y = 0; y < SIZE; y += 1) {
    const wy = (y / SIZE) * 4;
    const yi = Math.floor(wy);
    const fy = smooth(wy - yi);
    waveTableX[y] = Math.round(lerp(yLattX[yi % 4], yLattX[(yi + 1) % 4], fy) * 2.0 - 1.0);
    waveTableZ[y] = Math.round(lerp(yLattZ[yi % 4], yLattZ[(yi + 1) % 4], fy) * 2.0 - 1.0);
  }

  const subStrandNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 32, 4, 32, rng);

  const data = new Uint8Array(TOTAL * 4);

  for (let z = 0; z < SIZE; z += 1) {
    const zOffset = z * SIZE * SIZE;

    for (let y = 0; y < SIZE; y += 1) {
      const yOffset = zOffset + y * SIZE;
      const wx = waveTableX[y];
      const wz = waveTableZ[y];
      const lookupZ = wrap(z - wz, SIZE) * SIZE;

      for (let x = 0; x < SIZE; x += 1) {
        const lookupX = wrap(x - wx, SIZE);
        const p2d = lookupZ + lookupX;

        const groove = xzGroove[p2d];
        const height = xzHeight[p2d];
        const shift = xzShift[p2d];
        const baseBright = xzBright[p2d];

        const sub = subStrandNoise[yOffset + x];
        let r = baseBright + (sub - 0.5) * 0.16 + (groove - 0.45) * 0.12;
        r = clamp(r, 0.0, 1.0);

        const idx = (yOffset + x) * 4;
        data[idx] = Math.round(r * 255);
        data[idx + 1] = Math.round(groove * 255);
        data[idx + 2] = Math.round(shift * 255);
        data[idx + 3] = Math.round(height * 255);
      }
    }
  }

  return createData3D(data, SIZE, SIZE, SIZE);
};

/**
 * 6. 肌（寄りのカット用）用 3D テクスチャ。
 *
 * 【サンプリング方法】
 * シェーダー内では顔・首・手のローカル座標を 0.04 で除算してサンプリングする:
 *   vec4 skinTex = texture(uSkinDetail, localPos / 0.04);
 *
 * 【サイズ】
 * 48x48x48 ボクセル、RGBA8。
 *
 * 【各チャンネルの役割】
 * - R: 血色のむら（低周波、平均約 0.50、振れ幅は小さめ）。
 * - G: 毛穴（小さな点。大半は 0.50、毛穴の位置で 0.30。平均約 0.50）。
 * - B: 粗さの揺らぎ（皮脂やキメによるむら。平均約 0.50）。
 * - A: 高さ（毛穴のくぼみ。大半は 0.50、毛穴でわずかに凹む。平均約 0.50）。
 */
export const createSkinDetail = (): THREE.Data3DTexture => {
  const SIZE = 48;
  const TOTAL = SIZE * SIZE * SIZE;
  const rng = createSeededRandom(99887766);

  const bloodNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 3, 3, 3, rng);
  const roughNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 4, 4, 4, rng);

  // 毛穴マップ（デフォルト 0.5）
  const poreField = new Float32Array(TOTAL);
  poreField.fill(0.5);

  const CELLS = 6;
  const CELL_SIZE = SIZE / CELLS; // 8
  const poreRadius = 1.4;
  const poreRadiusSq = poreRadius * poreRadius;
  const rBound = 2; // スプラット探索範囲 (ボクセル)

  // Why not: 全 48^3 ボクセルから 216 個の毛穴を全探索すると数百万回の計算オーバーヘッドが生じるため、
  // 毛穴側から影響半径内の近傍ボクセルへスプラッティングすることで数千回の高速処理で完了させる。
  for (let cz = 0; cz < CELLS; cz += 1) {
    for (let cy = 0; cy < CELLS; cy += 1) {
      for (let cx = 0; cx < CELLS; cx += 1) {
        const pxCenter = cx * CELL_SIZE + CELL_SIZE * 0.5 + (rng() - 0.5) * (CELL_SIZE * 0.6);
        const pyCenter = cy * CELL_SIZE + CELL_SIZE * 0.5 + (rng() - 0.5) * (CELL_SIZE * 0.6);
        const pzCenter = cz * CELL_SIZE + CELL_SIZE * 0.5 + (rng() - 0.5) * (CELL_SIZE * 0.6);

        const ix = Math.round(pxCenter);
        const iy = Math.round(pyCenter);
        const iz = Math.round(pzCenter);

        for (let bz = -rBound; bz <= rBound; bz += 1) {
          const vz = wrap(iz + bz, SIZE);
          const dz = vz - pzCenter;
          const zOff = vz * SIZE * SIZE;

          for (let by = -rBound; by <= rBound; by += 1) {
            const vy = wrap(iy + by, SIZE);
            const dy = vy - pyCenter;
            const yOff = zOff + vy * SIZE;

            for (let bx = -rBound; bx <= rBound; bx += 1) {
              const vx = wrap(ix + bx, SIZE);
              const dx = vx - pxCenter;

              const d2 = dx * dx + dy * dy + dz * dz;
              const isInside = d2 < poreRadiusSq;
              if (isInside) {
                const d = Math.sqrt(d2);
                const t = 1.0 - d / poreRadius;
                const poreDepth = smooth(t);
                const val = 0.50 - 0.20 * poreDepth;
                const vIdx = yOff + vx;
                const isDeeper = val < poreField[vIdx];
                if (isDeeper) {
                  poreField[vIdx] = val;
                }
              }
            }
          }
        }
      }
    }
  }

  const data = new Uint8Array(TOTAL * 4);

  for (let i = 0; i < TOTAL; i += 1) {
    let r = 0.50 + (bloodNoise[i] - 0.5) * 0.12;
    r = clamp(r, 0.0, 1.0);

    const g = poreField[i];
    // 毛穴で少し凹む（A: 高さ）
    const poreDepression = (0.50 - g) * 0.9;
    const a = 0.50 - poreDepression;

    let b = 0.50 + (roughNoise[i] - 0.5) * 0.16;
    b = clamp(b, 0.0, 1.0);

    const idx = i * 4;
    data[idx] = Math.round(r * 255);
    data[idx + 1] = Math.round(g * 255);
    data[idx + 2] = Math.round(b * 255);
    data[idx + 3] = Math.round(a * 255);
  }

  return createData3D(data, SIZE, SIZE, SIZE);
};
