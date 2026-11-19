import * as THREE from "three";

/**
 * 競馬ゲーム（three.js）内馬場パドック（下見所）アセット用 3D プロシージャルテクスチャ群。
 *
 * 【用途】
 * 内馬場に置くパドック（下見所。JRA のパドックのように、赤茶色のゴムチップ舗装の楕円の周回路、
 * 内側の手入れされた芝生、植え込みと花壇、白い手すり、観客の立ち見のコンクリートの段々、
 * 騎手控え室の建物、電光掲示板とその鉄骨の枠、屋根付きの通路、縁石）の、アセットごとの質感を提供する。
 * 色そのもの（ベースカラー）はモデルの材質の色で決定されるため、本テクスチャは明暗の揺らぎ・模様・
 * 汚れ・粗さの揺らぎ・凹凸（高さ）を担当する。
 * 単位系はワールド座標（1m ≒ 1.5 単位）。シーン側（Claude）のシェーダーで、ワールド座標を各周期で割ってサンプリングする。
 *
 * 【提供するテクスチャ関数一覧】
 * 1. createPaddockLawnDetail() — 芝生（パドックの内側、広場の芝の島）。周期 1.2。
 *    - R: 葉の明暗（細かい葉の粒と、刈り込みでできる少し大きなむら）
 *    - G: 枯れた葉・土の見える所（大半 0、まばらに 0.6〜1）
 *    - B: 粗さの揺らぎ
 *    - A: 高さ（葉の粒の凹凸）
 * 2. createFlowerBedDetail() — 花壇の花と葉（花の色は頂点カラー）。周期 0.5。
 *    - R: 花びら・葉の陰影（花のかたまりの中心が明るく、隙間が暗い）
 *    - G: 花びらの筋
 *    - B: 葉の濃淡
 *    - A: 高さ
 * 3. createSoilDetail() — 花壇の土（黒っぽい土と腐葉土）。周期 0.8。
 *    - R: 土の明暗
 *    - G: 小石・木くず（点在）
 *    - B: 湿り（暗く艶が出る所）
 *    - A: 高さ
 * 5. createTerraceConcreteDetail() — 観客の段々・通路のコンクリート（屋外で雨ざらし）。周期 2.5。
 *    - R: 打ち放しのむら・骨材
 *    - G: 雨だれや水たまり跡の黒ずみ（低周波）
 *    - B: 錆のしみ（手すりの支柱の根元や金具周辺の不定形なしみと、地面に沿って水平に薄く広がるにじみ。全体の 6〜10%）
 *    - A: 高さ（ざらつき、ひび）
 * 6. createBuildingWallDetail() — 騎手控え室の壁（外壁パネル）。周期 2.0。
 *    - R: 塗装の明暗むら
 *    - G: 雨だれと錆の垂れ（0〜0.6 は灰色の雨だれの黒ずみ、0.6〜1 は窓枠や金具から垂れた錆色の筋。どちらも -Y 方向に長く伸びる。上端に起点が並ぶ）
 *    - B: パネルの目地（0/1）
 *    - A: 高さ
 * 7. createSteelFrameDetail() — 掲示板の枠・柱・鉄骨・屋根の柱（濃い色の塗装鋼）。周期 1.5。
 *    - R: 塗装のむら
 *    - G: 錆の量（0=塗装、0.3〜0.6=垂れ筋や薄い錆、0.8〜1=塗装が剥げて浮いた錆。低周波の錆びやすい区域に群れる不規則な塊と多数の微小点錆、下（-Y 方向）へ伸びる細い垂れ筋。G > 0.05 は全体の 18〜28%、G > 0.7 は 4〜8%）
 *    - B: 粗さ（錆の所は 0.9 前後でざらつく）
 *    - A: 高さ（錆の膨らみ・塗装の剥がれの段差）
 * 8. createRoofPanelDetail() — 屋根（金属の折板屋根）。周期 3.0。
 *    - R: 折板の波（X 方向）
 *    - G: 錆と苔（谷に溜まる錆の帯と、山の釘まわりの点錆。全体の 20〜30%）
 *    - B: 粗さ
 *    - A: 高さ（折板の山と谷）
 * 9. createCurbStoneDetail() — 縁石（御影石）。周期 0.6。
 *    - R: 石の粒
 *    - G: 雲母のきらめき
 *    - B: 粗さ→錆と土の汚れ（縁石の上面の角に溜まる汚れと点錆。全体の 10% ほど）
 *    - A: 高さ
 *
 * 【共通仕様】
 * - 形式: THREE.Data3DTexture (RGBA8, RGBAFormat, UnsignedByteType)
 * - ラップモード: wrapS / wrapT / wrapR = RepeatWrapping（3 軸すべてで完全シームレス・周期境界）
 * - フィルタ: minFilter = LinearMipmapLinearFilter, magFilter = LinearFilter, generateMipmaps = true, needsUpdate = true
 * - 決定性: mulberry32（固定シード）により環境やリロードに依存せず完全同一の結果を保証
 */

/**
 * 決定的擬似乱数生成器（mulberry32）。固定シード値により常に同一のテクスチャを再現する。
 *
 * Why not: Math.random() は実行環境や呼び出し順序によって結果が非決定的に変化し、
 * クライアント間や再描画ごとの見た目の揺らぎやテストの再現性低下を招くため。
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
 * X/Y 軸の格子インデックスと補間重みを事前計算し、スライス（Z）およびライン（Y）の
 * 外側ループでバッファオフセットを算出することで内側ループの演算を最適化する。
 *
 * 【なぜ他の方法を採らなかったか】
 * ボクセルごとに関数呼び出しを行って格子点を参照・補間する方式では、
 * 呼び出しオーバーヘッドにより数万〜数十万ボクセルの生成で数十ミリ秒以上を浪費してしまうため、
 * 事前展開インデックスとインライン補間により数ミリ秒で全格子展開を完了させる。
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
          (lattice[row11 + xi1] - lattice[row01 + xi0]) * fx;
        const y1 = x01 + (x11 - x01) * fy;

        output[yOffset + x] = y0 + (y1 - y0) * fz;
      }
    }
  }

  return output;
};

/**
 * Three.js の Data3DTexture を構築する共通関数。
 *
 * Why not: カラー空間（SRGBColorSpace）を適用するとシェーダー側で暗黙のガンマ補正が掛かり
 * 粗さや高さ、マスクなどの数値データが非線形に歪んでしまうため、既定の NoColorSpace（生データ）として設定する。
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

// =============================================================================
// 1. 芝生 (createPaddockLawnDetail) — 周期 1.2
// =============================================================================

/**
 * 芝生（パドックの内側、広場の芝の島）用 3D テクスチャを生成する。
 *
 * 【サンプリング方法】
 * シェーダー内ではワールド座標を 1.2 で除算してサンプリングする:
 *   vec4 lawnDetail = texture(uLawnDetail, worldPos / 1.2);
 *
 * 【サイズ・形式】
 * 64x64x64 ボクセル、RGBA8。3 軸すべて RepeatWrapping、generateMipmaps = true。
 *
 * 【各チャンネルの役割】
 * - R: 葉の明暗（細かい葉の粒と、刈り込みでできる少し大きなむら。平均約 0.50）
 * - G: 枯れた葉・土の見える所（大半 0、まばらに 0.6〜1.0）
 * - B: 粗さの揺らぎ（葉の微細な反射揺らぎ。平均約 0.65）
 * - A: 高さ（葉の粒の凹凸。平均約 0.50）
 *
 * Why not: 刈り込み筋や葉の重なりを 2D テクスチャの UV だけで処理すると、
 * 楕円形パドックの芝生の縁や起伏部分でテクスチャの歪みや継ぎ目が目立つため、
 * 3D プロシージャルボリュームによりどの角度・起伏でも均質な芝質感を保つ。
 */
export const createPaddockLawnDetail = (): THREE.Data3DTexture => {
  const SIZE = 64;
  const TOTAL = SIZE * SIZE * SIZE;
  const rng = createSeededRandom(30192847);

  // 刈り込みむら（低周波 3 周期）、葉の塊むら（中周波 8 周期）、土・枯葉スポット（中周波 6 周期）、粗さ（4 周期）
  const mowMottle = createPeriodicNoise3D(SIZE, SIZE, SIZE, 3, 3, 3, rng);
  const clumpNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 8, 8, 8, rng);
  const soilSpotNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 6, 6, 6, rng);
  const roughNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 4, 4, 4, rng);

  const data = new Uint8Array(TOTAL * 4);

  for (let i = 0; i < TOTAL; i += 1) {
    const bladeRand = rng();

    // --- R: 葉の明暗（微細な葉の粒 + 刈り込みむら + 葉塊） ---
    const mow = (mowMottle[i] - 0.5) * 0.24;
    const clump = (clumpNoise[i] - 0.5) * 0.20;
    const blade = (bladeRand - 0.5) * 0.22;
    let r = 0.50 + mow + clump + blade;
    r = clamp(r, 0.0, 1.0);

    // --- G: 枯れた葉・土の見える所（大半 0、まばらに 0.6〜1.0） ---
    // soilSpotNoise が一定閾値を超えた箇所に土や枯葉が露出
    const spotVal = soilSpotNoise[i];
    let g = 0.0;
    const isDeadSpot = spotVal > 0.76;
    if (isDeadSpot) {
      const t = (spotVal - 0.76) / 0.24;
      g = 0.60 + 0.40 * (t * 0.7 + bladeRand * 0.3);
    }
    g = clamp(g, 0.0, 1.0);

    // --- B: 粗さの揺らぎ（平均約 0.65、土・枯葉露出部は少しざらつきが増す） ---
    let b = 0.65 + (roughNoise[i] - 0.5) * 0.20 + (bladeRand - 0.5) * 0.08;
    if (isDeadSpot) {
      b += 0.12;
    }
    b = clamp(b, 0.0, 1.0);

    // --- A: 高さ（葉の粒の凹凸。平均約 0.50、枯葉・土は沈み込む） ---
    let a = 0.50 + (bladeRand - 0.5) * 0.24 + (clumpNoise[i] - 0.5) * 0.14;
    if (isDeadSpot) {
      a -= 0.14;
    }
    a = clamp(a, 0.0, 1.0);

    const idx = i * 4;
    data[idx] = Math.round(r * 255);
    data[idx + 1] = Math.round(g * 255);
    data[idx + 2] = Math.round(b * 255);
    data[idx + 3] = Math.round(a * 255);
  }

  return createData3D(data, SIZE, SIZE, SIZE);
};

// =============================================================================
// 2. 花壇の花と葉 (createFlowerBedDetail) — 周期 0.5
// =============================================================================

/**
 * 花壇の花と葉（花の色は頂点カラー）用 3D テクスチャを生成する。
 *
 * 【サンプリング方法】
 * シェーダー内ではワールド座標を 0.5 で除算してサンプリングする:
 *   vec4 flowerDetail = texture(uFlowerBedDetail, worldPos / 0.5);
 *
 * 【サイズ・形式】
 * 64x64x64 ボクセル、RGBA8。3 軸すべて RepeatWrapping、generateMipmaps = true。
 *
 * 【各チャンネルの役割】
 * - R: 花びら・葉の陰影（花のかたまりの中心が明るく、隙間が暗い。平均約 0.50）
 * - G: 花びらの筋（周期的な花弁の放射状テクスチャを想起させる微細筋。平均約 0.48）
 * - B: 葉の濃淡（緑葉の塊の色の深み。平均約 0.50）
 * - A: 高さ（花弁や小葉の重なり凹凸。平均約 0.50）
 *
 * Why not: 花壇は花の色が頂点カラー等で指定されるため、テクスチャ側ではカラーを固定せず、
 * 花弁・葉塊のボリューム陰影と花びらの筋、葉の深み陰影に特化させることで任意色の花壇に対応する。
 */
export const createFlowerBedDetail = (): THREE.Data3DTexture => {
  const SIZE = 64;
  const TOTAL = SIZE * SIZE * SIZE;
  const rng = createSeededRandom(84920153);

  // 花塊のセルラー状陰影（4 周期）、小葉・花弁分布（8 周期）、微細筋（16 周期）、葉の濃淡（6 周期）
  const clusterNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 4, 4, 4, rng);
  const petalNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 8, 8, 8, rng);
  const veinNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 16, 16, 16, rng);
  const leafToneNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 6, 6, 6, rng);

  const data = new Uint8Array(TOTAL * 4);

  for (let i = 0; i < TOTAL; i += 1) {
    const microRand = rng();

    // --- R: 花びら・葉の陰影（かたまりの中心が明るく、隙間・奥が暗い） ---
    // clusterNoise と petalNoise の二段重ねで花塊の膨らみと隙間を表現
    const cluster = clusterNoise[i];
    const petal = petalNoise[i];
    // 中心が明るく隙間が急峻に落ちる S 字カーブ
    const shading = smooth(cluster) * 0.65 + petal * 0.35;
    let r = shading + (microRand - 0.5) * 0.08;
    r = clamp(r, 0.0, 1.0);

    // --- G: 花びらの筋（細い筋の凹凸・明暗） ---
    // 三角波的な筋模様 + 高周波ノイズ
    const veinMod = Math.abs(veinNoise[i] - 0.5) * 2.0;
    let g = 0.25 + veinMod * 0.45 + (microRand - 0.5) * 0.12;
    g = clamp(g, 0.0, 1.0);

    // --- B: 葉の濃淡（葉の茂みの深みむら） ---
    let b = 0.50 + (leafToneNoise[i] - 0.5) * 0.36 + (microRand - 0.5) * 0.10;
    b = clamp(b, 0.0, 1.0);

    // --- A: 高さ（花弁やかたまりの膨らみと隙間の落ち込み） ---
    let a = 0.28 + cluster * 0.38 + petal * 0.24 + (microRand - 0.5) * 0.10;
    a = clamp(a, 0.0, 1.0);

    const idx = i * 4;
    data[idx] = Math.round(r * 255);
    data[idx + 1] = Math.round(g * 255);
    data[idx + 2] = Math.round(b * 255);
    data[idx + 3] = Math.round(a * 255);
  }

  return createData3D(data, SIZE, SIZE, SIZE);
};

// =============================================================================
// 3. 花壇の土 (createSoilDetail) — 周期 0.8
// =============================================================================

/**
 * 花壇の土（黒っぽい土と腐葉土）用 3D テクスチャを生成する。
 *
 * 【サンプリング方法】
 * シェーダー内ではワールド座標を 0.8 で除算してサンプリングする:
 *   vec4 soilDetail = texture(uSoilDetail, worldPos / 0.8);
 *
 * 【サイズ・形式】
 * 64x64x64 ボクセル、RGBA8。3 軸すべて RepeatWrapping、generateMipmaps = true。
 *
 * 【各チャンネルの役割】
 * - R: 土の明暗（粒土や腐葉土の細かな混ざりむら。平均約 0.50）
 * - G: 小石・木くず（大半 0、点在して 0.7〜1.0）
 * - B: 湿り（暗く艶が出る濡れだまり。大半 0.3、湿った箇所が 0.7〜1.0）
 * - A: 高さ（土塊の起伏や小石の突起。平均約 0.50）
 *
 * Why not: 土壌の粒度と湿り気（水分保持）を別チャンネルに分離することで、
 * シェーダー側で雨天時や散水直後の濡れ感（Specular/Roughness 制御）を直感的に変調可能にする。
 */
export const createSoilDetail = (): THREE.Data3DTexture => {
  const SIZE = 64;
  const TOTAL = SIZE * SIZE * SIZE;
  const rng = createSeededRandom(61524389);

  // 腐葉土の大きな塊（4 周期）、土粒のざらつき（10 周期）、湿りだまり（3 周期）、小石分布（8 周期）
  const clumpNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 4, 4, 4, rng);
  const grainNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 10, 10, 10, rng);
  const moistureNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 3, 3, 3, rng);
  const pebbleNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 8, 8, 8, rng);

  const data = new Uint8Array(TOTAL * 4);

  for (let i = 0; i < TOTAL; i += 1) {
    const soilRand = rng();

    // --- R: 土の明暗（腐葉土の黒み塊 + 粒土の明暗） ---
    const clump = (clumpNoise[i] - 0.5) * 0.28;
    const grain = (grainNoise[i] - 0.5) * 0.24;
    const micro = (soilRand - 0.5) * 0.18;
    let r = 0.50 + clump + grain + micro;
    r = clamp(r, 0.0, 1.0);

    // --- G: 小石・木くず（点在。大半 0、小石・木片が 0.7〜1.0） ---
    // pebbleNoise と高周波スパイクでまばらな粒子を生成
    let g = 0.0;
    const isPebble = pebbleNoise[i] > 0.82 && soilRand > 0.40;
    if (isPebble) {
      g = 0.70 + 0.30 * soilRand;
    }
    g = clamp(g, 0.0, 1.0);

    // --- B: 湿り（暗く艶が出る所。ベース約 0.25、水分だまりが 0.7〜1.0） ---
    const moistVal = moistureNoise[i];
    let b = 0.22 + moistVal * 0.32;
    const isPuddle = moistVal > 0.68;
    if (isPuddle) {
      b += (moistVal - 0.68) * 1.2;
    }
    b = clamp(b, 0.0, 1.0);

    // --- A: 高さ（土塊の起伏 + 小石の突起） ---
    let a = 0.48 + clump * 0.7 + grain * 0.4 + micro * 0.3;
    if (isPebble) {
      a += 0.22;
    }
    a = clamp(a, 0.0, 1.0);

    const idx = i * 4;
    data[idx] = Math.round(r * 255);
    data[idx + 1] = Math.round(g * 255);
    data[idx + 2] = Math.round(b * 255);
    data[idx + 3] = Math.round(a * 255);
  }

  return createData3D(data, SIZE, SIZE, SIZE);
};

// =============================================================================
// 5. 観客の段々・通路のコンクリート (createTerraceConcreteDetail) — 周期 2.5
// =============================================================================

/**
 * 観客の立ち見のコンクリートの段々・通路・広場（屋外で雨ざらし）用 3D テクスチャを生成する。
 *
 * 【サンプリング方法】
 * シェーダー内ではワールド座標を 2.5 で除算してサンプリングする:
 *   vec4 concreteDetail = texture(uTerraceConcreteDetail, worldPos / 2.5);
 *
 * 【サイズ・形式】
 * 64x64x64 ボクセル、RGBA8。3 軸すべて RepeatWrapping、generateMipmaps = true。
 *
 * 【各チャンネルの役割】
 * - R: 打ち放しのむら・骨材（砂利粒とセメントペーストの濃淡。平均約 0.49）
 * - G: 雨だれや水たまり跡の黒ずみ（低周波の経年汚れ。平均約 0.34）
 * - B: 錆のしみ（手すりの支柱根元や金具周辺の不定形なしみと、地面に沿って水平に薄く広がるにじみ。B > 0.05 は全体の 6〜10%）
 * - A: 高さ（ざらつき、ひび。平均約 0.46）
 *
 * 【どう実現しているか】
 * 矢印状パターンの周期反復を防ぐため、互いに素な非調和周期（3, 7, 13）のノイズ合成で不定形なしみとコア（B 0.70〜0.95）を
 * 形成し、さらに地面（XZ 平面）に沿って広がる水平低周波ノイズ（周期 4, 1, 4）を重ねて薄いにじみ（B 0.10〜0.30）を生成する。
 *
 * 【なぜ他の方法を採らなかったか】
 * 整数倍の調和比（4 と 8 周期）のノイズ直積では位相が同期して矢印のような幾何学的模様が規則正しく並んでしまうため、
 * 非調和な周波数配分と Y 周期 1 の水平異方性ノイズにより、地面に沿った物理的に自然な風化にじみを再現する。
 */
export const createTerraceConcreteDetail = (): THREE.Data3DTexture => {
  const SIZE = 64;
  const TOTAL = SIZE * SIZE * SIZE;
  const rng = createSeededRandom(51428390);

  // 打ち放し型枠むら（3 周期）、骨材の微細粒（16 周期）、雨だれ・黒ずみ（2 周期）、ひび（8 周期）
  const formworkNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 3, 3, 3, rng);
  const aggregateNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 16, 16, 16, rng);
  const rainStainNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 2, 2, 2, rng);
  const crackNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 8, 8, 8, rng);

  // 錆のしみ用ノイズ（非調和な周期で同じ形の繰り返しを根絶）:
  // 1. しみ発生中心（低周波 3 周期: 金具や支柱根元）
  const stainCenterNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 3, 3, 3, rng);
  // 2. 不定形輪郭（非調和な 7 周期）
  const stainShapeNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 7, 5, 7, rng);
  // 3. ぎざぎざディテール（13 周期）
  const stainDetailNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 13, 9, 13, rng);
  // 4. 水平に広がる低周波のにじみ（X: 4, Y: 1, Z: 4: 地面に沿って広がる）
  const horizontalBleedNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 4, 1, 4, rng);

  const data = new Uint8Array(TOTAL * 4);

  for (let i = 0; i < TOTAL; i += 1) {
    const concRand = rng();

    // --- R: 打ち放しのむら・骨材 ---
    const form = (formworkNoise[i] - 0.5) * 0.22;
    const agg = (aggregateNoise[i] - 0.5) * 0.26;
    let r = 0.50 + form + agg + (concRand - 0.5) * 0.08;
    r = clamp(r, 0.0, 1.0);

    // --- G: 雨だれや水たまり跡の黒ずみ（低周波） ---
    const stain = rainStainNoise[i];
    let g = 0.22 + stain * 0.38;
    g = clamp(g, 0.0, 1.0);

    // --- B: 錆のしみ ---
    const centerVal = stainCenterNoise[i];
    const shapeVal = stainShapeNoise[i];
    const detailVal = stainDetailNoise[i];
    const bleedVal = horizontalBleedNoise[i];

    // 非調和合成で不定形な輪郭を生成
    const stainComposite = centerVal * 0.50 + shapeVal * 0.35 + detailVal * 0.15;

    let b = 0.0;
    const isStainRegion = centerVal > 0.68;
    if (isStainRegion) {
      const isStainBody = stainComposite > 0.72;
      const isHorizontalBleed = bleedVal > 0.78;

      if (isStainBody) {
        const isStainCore = stainComposite > 0.78;
        if (isStainCore) {
          // コア: 濃い錆 B 0.70 〜 0.95
          const t = (stainComposite - 0.78) / 0.22;
          b = 0.70 + t * 0.25;
        } else {
          // しみ本体（不定形・ぎざぎざ）: B 0.35 〜 0.65
          const t = (stainComposite - 0.72) / 0.06;
          b = 0.35 + t * 0.30;
        }
      } else if (isHorizontalBleed) {
        // 地面に沿って薄く広がる水平のにじみ: B 0.10 〜 0.30
        const t = ((centerVal - 0.68) / 0.32) * ((bleedVal - 0.78) / 0.22);
        b = 0.10 + t * 0.20;
      }
    }

    const isSubThresholdB = b < 0.05;
    if (isSubThresholdB) {
      b = 0.0;
    } else {
      b = clamp(b, 0.0, 1.0);
    }

    // --- A: 高さ（ざらつき、ひび） ---
    const crackDist = Math.abs(crackNoise[i] - 0.5) * 2.0;
    const isCrack = crackDist < 0.08;
    let a = 0.50 + agg * 0.30 + (concRand - 0.5) * 0.10;
    if (isCrack) {
      a -= 0.25;
    }
    const hasDeepRustStain = b > 0.40;
    if (hasDeepRustStain) {
      a -= 0.05;
    }
    a = clamp(a, 0.0, 1.0);

    const idx = i << 2;
    data[idx] = (r * 255 + 0.5) | 0;
    data[idx + 1] = (g * 255 + 0.5) | 0;
    data[idx + 2] = (b * 255 + 0.5) | 0;
    data[idx + 3] = (a * 255 + 0.5) | 0;
  }

  return createData3D(data, SIZE, SIZE, SIZE);
};

// =============================================================================
// 6. 騎手控え室の壁 (createBuildingWallDetail) — 周期 2.0
// =============================================================================

/**
 * 騎手控え室の壁（塗装した外壁パネル）用 3D テクスチャを生成する。
 *
 * 【サンプリング方法】
 * シェーダー内ではワールド座標を 2.0 で除算してサンプリングする:
 *   vec4 wallDetail = texture(uBuildingWallDetail, worldPos / 2.0);
 *
 * 【サイズ・形式】
 * 64x64x64 ボクセル、RGBA8。3 軸すべて RepeatWrapping、generateMipmaps = true。
 *
 * 【各チャンネルの役割】
 * - R: 塗装の明暗むら（パネル塗装のわずかなロールむら。平均約 0.51）
 * - G: 雨だれと錆の垂れ（0〜0.6 は灰色の雨だれの黒ずみ、0.6〜1 は窓枠や金具から垂れた錆色の筋。どちらもテクスチャの -Y 方向に長く伸びる。上端に起点が並ぶ）
 * - B: パネルの目地（一定間隔の細い溝 0/1。目地部で 1.0、平滑面で 0.0）
 * - A: 高さ（目地溝と微細な凹凸、錆筋の微細な盛り上がり。平均約 0.47）
 *
 * Why not: 外壁パネルでは窓サッシや換気ガラリ、パネル上部目地金物から雨水が集まり、
 * 灰色の雨水汚れとともに赤錆の筋が下方向（-Y）に長く流下するため、
 * 上端を起点とする下向きの流下フィルタにより物理的に自然な雨だれと錆垂れを表現する。
 */
export const createBuildingWallDetail = (): THREE.Data3DTexture => {
  const SIZE = 64;
  const TOTAL = SIZE * SIZE * SIZE;
  const rng = createSeededRandom(17283940);

  // 塗装ロールむら（4 周期）、雨だれの縦筋（X: 10, Y: 1, Z: 10）、錆起点（8 周期）
  const paintRollNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 4, 4, 4, rng);
  const streakNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 10, 1, 10, rng);
  const rustOriginNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 8, 2, 8, rng);

  // -Y 方向への流下伝播（上端 panelY >= 28 から下方へ流れる）
  const rainDownStreak = new Float32Array(TOTAL);
  const rustDownStreak = new Float32Array(TOTAL);

  for (let z = 0; z < SIZE; z += 1) {
    const zBase = z * SIZE * SIZE;
    for (let x = 0; x < SIZE; x += 1) {
      const colBase = zBase + x;
      let rainAccum = 0;
      let rustAccum = 0;
      for (let y = SIZE - 1; y >= 0; y -= 1) {
        const idx = colBase + y * SIZE;
        const panelY = y % 32;
        const isNearTop = panelY >= 28;

        const streakBase = streakNoise[idx];
        const rainSrc = isNearTop && streakBase > 0.44 ? (streakBase - 0.44) * 1.78571429 : 0.0;
        rainAccum = rainSrc + rainAccum * 0.94;

        const rVal = rustOriginNoise[idx];
        const rustSrc = isNearTop && rVal > 0.70 ? (rVal - 0.70) * 3.33333333 : 0.0;
        rustAccum = rustSrc + rustAccum * 0.91;
      }
      for (let y = SIZE - 1; y >= 0; y -= 1) {
        const idx = colBase + y * SIZE;
        const panelY = y % 32;
        const isNearTop = panelY >= 28;

        const streakBase = streakNoise[idx];
        const rainSrc = isNearTop && streakBase > 0.44 ? (streakBase - 0.44) * 1.78571429 : 0.0;
        rainAccum = rainSrc + rainAccum * 0.94;

        const rVal = rustOriginNoise[idx];
        const rustSrc = isNearTop && rVal > 0.70 ? (rVal - 0.70) * 3.33333333 : 0.0;
        rustAccum = rustSrc + rustAccum * 0.91;

        rainDownStreak[idx] = rainAccum;
        rustDownStreak[idx] = rustAccum;
      }
    }
  }

  const data = new Uint8Array(TOTAL * 4);

  for (let z = 0; z < SIZE; z += 1) {
    for (let y = 0; y < SIZE; y += 1) {
      const isSeamY = (y % 32) < 2;
      const rowOffset = (z * SIZE + y) * SIZE;
      for (let x = 0; x < SIZE; x += 1) {
        const i = rowOffset + x;
        const microRand = rng();

        // --- R: 塗装の明暗むら ---
        const roll = (paintRollNoise[i] - 0.5) * 0.20;
        let r = 0.50 + roll + (microRand - 0.5) * 0.06;
        r = clamp(r, 0.0, 1.0);

        // --- G: 雨だれと錆の垂れ（0〜0.6: 灰色の雨だれ黒ずみ、0.6〜1: 窓枠・金具から垂れた錆色の筋） ---
        const streakBase = streakNoise[i];
        let rainDarkness = 0.0;
        const rDown = rainDownStreak[i];
        if (rDown > 0.08) {
          const t = Math.min(1.0, rDown * (0.50 + streakBase * 0.60));
          rainDarkness = Math.min(0.58, t * 0.55);
        }

        let rustStreak = 0.0;
        const ruDown = rustDownStreak[i];
        if (ruDown > 0.12 && streakBase > 0.40) {
          const t = Math.min(1.0, (ruDown - 0.12) * 1.33333333);
          rustStreak = 0.60 + t * 0.40;
        }

        const g = clamp(Math.max(rainDarkness, rustStreak), 0.0, 1.0);

        // --- B: パネルの目地（一定間隔の細い溝 0/1） ---
        const isSeamX = (x % 32) < 2;
        const isSeam = isSeamX || isSeamY;
        const b = isSeam ? 1.0 : 0.0;

        // --- A: 高さ ---
        let a = 0.50 + roll * 0.15 + (microRand - 0.5) * 0.04;
        if (isSeam) {
          a = 0.15;
        }
        if (rustStreak >= 0.60) {
          a += 0.06;
        }
        a = clamp(a, 0.0, 1.0);

        const idx = i << 2;
        data[idx] = (r * 255 + 0.5) | 0;
        data[idx + 1] = (g * 255 + 0.5) | 0;
        data[idx + 2] = (b * 255 + 0.5) | 0;
        data[idx + 3] = (a * 255 + 0.5) | 0;
      }
    }
  }

  return createData3D(data, SIZE, SIZE, SIZE);
};

// =============================================================================
// 7. 掲示板の枠・鉄骨 (createSteelFrameDetail) — 周期 1.5
// =============================================================================

/**
 * 掲示板の枠・柱・鉄骨・屋根の柱（濃い色の塗装鋼）用 3D テクスチャを生成する。
 *
 * 【サンプリング方法】
 * シェーダー内ではワールド座標を 1.5 で除算してサンプリングする:
 *   vec4 steelDetail = texture(uSteelFrameDetail, worldPos / 1.5);
 *
 * 【サイズ・形式】
 * 64x64x64 ボクセル、RGBA8。3 軸すべて RepeatWrapping、generateMipmaps = true。
 *
 * 【各チャンネルの役割】
 * - R: 塗装のむら（濃色ウレタン・フッ素樹脂塗装の微小な梨地むら。平均約 0.49）
 * - G: 錆の量（0=塗装、0.3〜0.6=垂れ筋や薄い錆、0.8〜1.0=塗装が剥げて浮いた錆。G > 0.05 は全体の 18〜28%、G > 0.7 は 4〜8%）
 * - B: 粗さ（錆の所は 0.9 前後でざらつく、通常塗装部は 0.42 前後。平均約 0.48）
 * - A: 高さ（錆の膨らみ・塗装の剥がれの段差。平均約 0.53）
 *
 * 【どう実現しているか】
 * 低周波（2 周期）の錆区域ノイズで「群れ」を作り、中周波（5 周期）と高周波（15 周期）の合成で輪郭がぎざぎざで大きさが
 * まちまちな塊と多数の微小点錆を生成する。塊から下方（-Y 方向）へ列ごとに太さと減衰率（長さ）が異なる流下 IIR フィルタを
 * 2 パス適用して雨だれ筋（G 0.3〜0.56）を伸ばし、濃い錆（G 0.8〜1.0）は塊の芯部だけに限定する。
 *
 * 【なぜ他の方法を採らなかったか】
 * 単一周波数のバリューノイズ閾値では等間隔の球状塊となり、均一な流下減衰と合わさってヒョウ柄や水玉模様に見えてしまうため、
 * 錆区域による局在化・高周波による不規則化・列ごとの減衰率可変流下によって本物の塗装鉄骨の自然な錆を再現する。
 */
export const createSteelFrameDetail = (): THREE.Data3DTexture => {
  const SIZE = 64;
  const TOTAL = SIZE * SIZE * SIZE;
  const rng = createSeededRandom(73829104);

  // 塗装むら（4 周期）、錆区域（低周波 2 周期: 群れを作る）、不規則塊（中周波 5 周期）、
  // 輪郭ぎざぎざ & 小さな点錆（高周波 15 周期）、垂れ筋マスク（X: 12, Y: 1, Z: 12）、粗さ（6 周期）
  const paintNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 4, 4, 4, rng);
  const rustZoneNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 2, 2, 2, rng);
  const clumpNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 5, 5, 5, rng);
  const detailNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 15, 15, 15, rng);
  const streakNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 12, 1, 12, rng);
  const roughNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 6, 6, 6, rng);

  // 下へ垂れる細い筋 (-Y 方向): 雨水流下の IIR フィルタ (2 パスで周期境界定常化)
  // 列ごとに長さ・太さ・発生源がまちまち
  const downStreak = new Float32Array(TOTAL);
  for (let z = 0; z < SIZE; z += 1) {
    const zBase = z * SIZE * SIZE;
    for (let x = 0; x < SIZE; x += 1) {
      const colBase = zBase + x;
      // 列マスク: 細い筋だけが残るよう整形
      const colMask = streakNoise[colBase];
      const isStreakCol = colMask > 0.44;
      // 列ごとの減衰率 (0.75 〜 0.91): 長さがまちまち
      const decay = 0.75 + (colMask - 0.44) * 0.28;
      let accum = 0;

      for (let pass = 0; pass < 2; pass += 1) {
        for (let y = SIZE - 1; y >= 0; y -= 1) {
          const idx = colBase + y * SIZE;
          const zone = rustZoneNoise[idx];
          const clump = clumpNoise[idx];
          const detail = detailNoise[idx];

          // 塊の存在度 (ぎざぎざ輪郭)
          const clumpFBM = clump * 0.62 + detail * 0.38;
          // 錆びやすい区域かつ塊の上部・芯から垂れ筋が発生
          const isSource = zone > 0.46 && clumpFBM > 0.56 && isStreakCol;
          const srcVal = isSource
            ? (clumpFBM - 0.56) * (colMask - 0.44) * 6.5
            : 0.0;

          accum = srcVal + accum * decay;
          const isFinalPass = pass === 1;
          if (isFinalPass) {
            downStreak[idx] = accum;
          }
        }
      }
    }
  }

  const data = new Uint8Array(TOTAL * 4);

  for (let i = 0; i < TOTAL; i += 1) {
    const steelRand = rng();

    // --- R: 塗装のむら ---
    const paint = (paintNoise[i] - 0.5) * 0.20;
    let r = 0.50 + paint + (steelRand - 0.5) * 0.06;
    r = clamp(r, 0.0, 1.0);

    // --- G: 錆の量 ---
    const zone = rustZoneNoise[i];
    const clump = clumpNoise[i];
    const detail = detailNoise[i];
    const streak = downStreak[i];

    // 錆びやすい区域の強度（群れ）
    const inZone = zone > 0.46;

    // 1. 不規則な塊（輪郭ぎざぎざ）
    const clumpFBM = clump * 0.62 + detail * 0.38;
    let clumpRust = 0.0;
    const isClumpCandidate = inZone && clumpFBM > 0.55;
    if (isClumpCandidate) {
      clumpRust = (clumpFBM - 0.55) / 0.45;
    }

    // 2. 小さな点錆（大きな塊は少なく、小さな点錆が多い）
    let pitRust = 0.0;
    const isPitCandidate = detail > 0.74 && zone > 0.41;
    if (isPitCandidate) {
      pitRust = (detail - 0.74) / 0.26;
    }

    // 3. 垂れ筋（雨で錆が流れた跡: G 0.3〜0.6 くらいの薄い錆）
    let streakRust = 0.0;
    const hasStreakFlow = streak > 0.03;
    if (hasStreakFlow) {
      streakRust = clamp(streak * 0.68, 0.0, 0.56);
    }

    let g = 0.0;
    // 濃い錆（G 0.8〜1、塗装が剥げて浮いた錆は塊の芯だけ）
    const isCore = inZone && clumpRust > 0.28;
    const hasClump = clumpRust > 0.0;
    const hasStreak = streakRust > 0.0;
    const hasPit = pitRust > 0.0;

    if (isCore) {
      const coreT = clamp((clumpRust - 0.28) / 0.72, 0.0, 1.0);
      g = 0.80 + coreT * 0.20;
    } else if (hasClump) {
      // 塊の周辺
      g = 0.42 + clumpRust * 0.34;
    } else if (hasStreak) {
      // 垂れ筋（G 0.3〜0.56 の薄い錆）
      g = 0.30 + streakRust * 0.46;
    } else if (hasPit) {
      // 小さな点錆
      g = 0.25 + pitRust * 0.35;
    }

    const isSubThresholdG = g < 0.05;
    if (isSubThresholdG) {
      g = 0.0;
    } else {
      g = clamp(g, 0.0, 1.0);
    }

    // --- B: 粗さ（錆の所は 0.9 前後でざらつく、通常塗装部は 0.42 前後） ---
    const roughMottle = (roughNoise[i] - 0.5) * 0.14;
    let b = (1.0 - g) * (0.42 + roughMottle) + g * (0.90 + (steelRand - 0.5) * 0.08);
    b = clamp(b, 0.0, 1.0);

    // --- A: 高さ（錆の膨らみ・塗装の剥がれの段差） ---
    let a = 0.50 + paint * 0.12;
    const hasRustHeight = g > 0.0;
    if (hasRustHeight) {
      a += g * 0.22 + (steelRand - 0.5) * 0.06;
    }
    a = clamp(a, 0.0, 1.0);

    const idx = i << 2;
    data[idx] = (r * 255 + 0.5) | 0;
    data[idx + 1] = (g * 255 + 0.5) | 0;
    data[idx + 2] = (b * 255 + 0.5) | 0;
    data[idx + 3] = (a * 255 + 0.5) | 0;
  }

  return createData3D(data, SIZE, SIZE, SIZE);
};

// =============================================================================
// 8. 屋根の折板 (createRoofPanelDetail) — 周期 3.0
// =============================================================================

/**
 * 屋根（金属の折板屋根）用 3D テクスチャを生成する。
 *
 * 【サンプリング方法】
 * シェーダー内ではワールド座標を 3.0 で除算してサンプリングする:
 *   vec4 roofDetail = texture(uRoofPanelDetail, worldPos / 3.0);
 *
 * 【サイズ・形式】
 * 64x64x64 ボクセル、RGBA8。3 軸すべて RepeatWrapping、generateMipmaps = true。
 *
 * 【各チャンネルの役割】
 * - R: 折板の波（X 方向。山が明るく、斜面・谷が陰影で暗い。平均約 0.50）
 * - G: 錆と苔（谷に溜まる錆の帯と、山の釘まわりの点錆。全体の 20〜30%）
 * - B: 粗さ（金属面 0.35、谷の苔・錆および釘まわりで 0.88 前後。平均約 0.43）
 * - A: 高さ（折板の山と谷、釘・錆の微小な突出。平均約 0.50）
 *
 * Why not: 工業用折板屋根（ルーフデッキ）は X 軸方向に等間隔の山谷波を形成し、
 * 雨水が滞留する谷底には濃い赤錆と苔の帯が形成され、山頂の固定用ボルト・釘頭周辺にも点錆が発生するため、
 * 折板ハイトと連動して谷底帯錆と山頂点錆を配分し、全体の 20〜30% に風化を再現する。
 */
export const createRoofPanelDetail = (): THREE.Data3DTexture => {
  const SIZE = 64;
  const TOTAL = SIZE * SIZE * SIZE;
  const rng = createSeededRandom(38472910);

  // 谷の汚れ・苔（4 周期）、山の釘まわりの点錆（8 周期）、微細金属ロール傷（8 周期）
  const grimeNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 4, 4, 4, rng);
  const nailRustNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 8, 8, 8, rng);
  const microNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 8, 8, 8, rng);

  const data = new Uint8Array(TOTAL * 4);

  // X 軸方向 16 ボクセル周期の折板波テーブル
  const waveArr = new Float32Array(SIZE);
  for (let x = 0; x < SIZE; x += 1) {
    const phase = (x % 16) * 0.0625;
    waveArr[x] = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
  }

  for (let z = 0; z < SIZE; z += 1) {
    for (let y = 0; y < SIZE; y += 1) {
      const rowOffset = (z * SIZE + y) * SIZE;
      for (let x = 0; x < SIZE; x += 1) {
        const i = rowOffset + x;
        const microRand = rng();
        const wave = waveArr[x];

        // --- R: 折板の波(X方向) ---
        let r = 0.25 + wave * 0.50 + (microNoise[i] - 0.5) * 0.08;
        r = clamp(r, 0.0, 1.0);

        // --- G: 錆と苔(谷に溜まる錆の帯と、山の釘まわりの点錆。全体の20〜30%) ---
        let valleyRustMoss = 0.0;
        if (wave < 0.25) {
          const vFactor = (0.25 - wave) * 4.0;
          const grime = grimeNoise[i];
          if (grime > 0.28) {
            valleyRustMoss = vFactor * (0.35 + grime * 0.65);
          }
        }

        let nailRust = 0.0;
        if (wave > 0.78) {
          const nVal = nailRustNoise[i];
          if (nVal > 0.76) {
            const t = (nVal - 0.76) * 4.16666667;
            nailRust = 0.55 + t * 0.45;
          }
        }

        const g = clamp(Math.max(valleyRustMoss, nailRust), 0.0, 1.0);

        // --- B: 粗さ ---
        let b = (1.0 - g) * (0.35 + (microNoise[i] - 0.5) * 0.10) + g * (0.88 + (microRand - 0.5) * 0.08);
        b = clamp(b, 0.0, 1.0);

        // --- A: 高さ(折板の山と谷) ---
        let a = 0.12 + wave * 0.76 + (microRand - 0.5) * 0.03;
        if (nailRust > 0.0) {
          a += nailRust * 0.06;
        }
        a = clamp(a, 0.0, 1.0);

        const idx = i << 2;
        data[idx] = (r * 255 + 0.5) | 0;
        data[idx + 1] = (g * 255 + 0.5) | 0;
        data[idx + 2] = (b * 255 + 0.5) | 0;
        data[idx + 3] = (a * 255 + 0.5) | 0;
      }
    }
  }

  return createData3D(data, SIZE, SIZE, SIZE);
};

// =============================================================================
// 9. 縁石 (createCurbStoneDetail) — 周期 0.6
// =============================================================================

/**
 * 縁石（御影石・花崗岩）用 3D テクスチャを生成する。
 *
 * 【サンプリング方法】
 * シェーダー内ではワールド座標を 0.6 で除算してサンプリングする:
 *   vec4 curbDetail = texture(uCurbStoneDetail, worldPos / 0.6);
 *
 * 【サイズ・形式】
 * 64x64x64 ボクセル、RGBA8。3 軸すべて RepeatWrapping、generateMipmaps = true。
 *
 * 【各チャンネルの役割】
 * - R: 石の粒（黒・白・灰の粒の混ざり。平均約 0.53）
 * - G: 雲母のきらめき（点在。大半 0、きらめき結晶部 0.8〜1.0）
 * - B: 粗さ→錆と土の汚れ（縁石の上面の角に溜まる汚れと点錆。全体の 10% ほど）
 * - A: 高さ（石の結晶粒ごとの微小な起伏、汚れ付着の盛り上がり。平均約 0.50）
 *
 * Why not: 御影石の縁石は、雨水や歩行者の靴から運ばれた泥土が上面の角（エッジ部）に滞留し、
 * 付近の金属柵や落ち葉・金具から流れた点錆が沈着するため、
 * B チャンネルを単なる粗さから「上面角の土汚れ＋点錆」に切り替えてリアルな屋外経年感を演出する。
 */
export const createCurbStoneDetail = (): THREE.Data3DTexture => {
  const SIZE = 64;
  const TOTAL = SIZE * SIZE * SIZE;
  const rng = createSeededRandom(49102835);

  // 石材結晶ノイズ（16 周期）、低周波むら（3 周期）、雲母スポット（12 周期）、土汚れ（6 周期）、点錆（10 周期）
  const crystalNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 16, 16, 16, rng);
  const stoneMottle = createPeriodicNoise3D(SIZE, SIZE, SIZE, 3, 3, 3, rng);
  const micaNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 12, 12, 12, rng);
  const grimeNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 6, 6, 6, rng);
  const rustSpotNoise = createPeriodicNoise3D(SIZE, SIZE, SIZE, 10, 10, 10, rng);

  const data = new Uint8Array(TOTAL * 4);

  for (let z = 0; z < SIZE; z += 1) {
    for (let y = 0; y < SIZE; y += 1) {
      const yTopBias = y * 0.015625;
      const edgeFactor = yTopBias > 0.68 ? (yTopBias - 0.68) * 3.125 : 0.0;
      const rowOffset = (z * SIZE + y) * SIZE;

      for (let x = 0; x < SIZE; x += 1) {
        const i = rowOffset + x;
        const crystalRand = rng();

        // --- R: 石の粒（黒・白・灰の粒の混ざり） ---
        const isBlackGrain = crystalRand < 0.18;
        const isWhiteGrain = crystalRand > 0.78;
        let baseTone = 0.50 + (crystalNoise[i] - 0.5) * 0.15;
        if (isBlackGrain) {
          baseTone = 0.18 + crystalRand * 0.4444444;
        } else if (isWhiteGrain) {
          baseTone = 0.82 + (crystalRand - 0.78) * 0.4545455;
        }
        const mottle = (stoneMottle[i] - 0.5) * 0.14;
        let r = baseTone + mottle;
        r = clamp(r, 0.0, 1.0);

        // --- G: 雲母のきらめき（点在。大半 0、結晶部で 0.8〜1.0） ---
        let g = 0.0;
        const isMicaGlitter = micaNoise[i] > 0.84 && crystalRand > 0.55;
        if (isMicaGlitter) {
          g = 0.80 + 0.20 * rng();
        }

        // --- B: 粗さ→錆と土の汚れ（縁石の上面の角に溜まる汚れと点錆。全体の 10% ほど） ---
        const grimeVal = grimeNoise[i];
        const rustVal = rustSpotNoise[i];

        let dirt = 0.0;
        if (edgeFactor > 0.0 && grimeVal > 0.58) {
          dirt = edgeFactor * (grimeVal - 0.58) * 2.142857;
        }

        let rust = 0.0;
        if (rustVal > 0.80 && crystalRand > 0.38) {
          rust = 0.65 + 0.35 * crystalRand;
        }

        const b = clamp(Math.max(dirt, rust), 0.0, 1.0);

        // --- A: 高さ（結晶粒の微細な凹凸、汚れ付着の盛り上がり） ---
        let a = 0.50 + (crystalRand - 0.5) * 0.20 + (crystalNoise[i] - 0.5) * 0.12;
        if (isBlackGrain) {
          a -= 0.06;
        } else if (isWhiteGrain) {
          a += 0.06;
        }
        if (b > 0.40) {
          a += 0.05;
        }
        a = clamp(a, 0.0, 1.0);

        const idx = i << 2;
        data[idx] = (r * 255 + 0.5) | 0;
        data[idx + 1] = (g * 255 + 0.5) | 0;
        data[idx + 2] = (b * 255 + 0.5) | 0;
        data[idx + 3] = (a * 255 + 0.5) | 0;
      }
    }
  }

  return createData3D(data, SIZE, SIZE, SIZE);
};
