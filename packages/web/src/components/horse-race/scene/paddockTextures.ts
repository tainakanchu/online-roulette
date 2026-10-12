import * as THREE from "three";

/**
 * 競馬ゲームのパドック（下見所）および出走馬用プロシージャルテクスチャ群。
 *
 * 【用途】
 * レース前の最初の画面で、騎手を乗せていない出走馬が厩務員に引かれて、
 * 楕円の周回路を左回りで周回するパドックシーンを構成するためのテクスチャ群。
 * 周回路（赤茶色のゴムチップ舗装）、内側の芝生（「LUCKY ROULETTE」の刈り込み芝と馬蹄・ルーレットエンブレム）、
 * パドック端の電光掲示板（16:9 の馬番・馬名・馬体重掲示）、騎手控室および装鞍所看板、
 * そして各出走馬の鞍の下に着けるゼッケン（馬番・馬名・枠色）を提供する。
 * 単位系はワールド座標（1m ≒ 1.5 単位）。
 *
 * 【提供するテクスチャ関数】
 * 1. createPaddockTrackDetail(): 周回路ゴムチップ舗装の 3D 質感（Data3DTexture, 64^3）。
 *    - UV / サンプリング: ワールド座標 / 3.0（1 周期 3 単位 = 2m）。
 *    - 各チャンネルの役割:
 *      - R: 色むら（チップの混ざり。大半 0.5、黒チップ 0.15、明チップ 0.8 が点在）＋踏まれた低周波むら
 *      - G: 蹄の跡や擦れ（周回路の歩行ラインに沿う低周波の擦れ・明度変化。平均 0.5）
 *      - B: 粗さの揺らぎ（ゴム舗装のつや消し質感。平均 0.7）
 *      - A: 高さ（チップ粒の細かな凹凸。平均 0.5）
 * 2. createPaddockLawnTexture(): 内側芝生（2048x716、アスペクト比 40:14、CanvasTexture、sRGB）。
 *    - UV: u が長軸方向（X）0..1、v が短軸方向 0..1（v = 1 が奥）。
 *    - 内容: 6〜8 本の芝刈り縞、中央の馬蹄＆ルーレットエンブレム、左右の「LUCKY ROULETTE」ロゴ、微細な芝粒子。
 * 3. createPaddockBoardBackground(): 電光掲示板背景（1920x1080、16:9、CanvasTexture、sRGB）。
 *    - UV: 0..1（正面から見て左上 0,0、右下 1,1）。
 *    - 内容: 微細な黒 LED ドットマトリクス、上 12% の濃緑見出し帯「パドック PADDOCK」、
 *      列見出し帯（馬番 4%、馬名 14%、馬体重 60%、増減 76%、単勝 88%）。下部はデータ描画用に空けておく。
 * 4. createPaddockSignTexture(kind): 施設看板（CanvasTexture、sRGB）。
 *    - kind = "jockeyRoom": 1600x192（10 x 1.2 単位）「騎手控室 JOCKEYS' ROOM」。
 *    - kind = "saddlingGate": 1600x240（6 x 0.9 単位）「装鞍所 SADDLING PADDOCK」。
 *    - UV: 0..1（正面から読める向き）。濃緑地に白文字、金色の二重縁取り。
 * 5. createZekkenTexture(number, name, color): 馬番・馬名入りゼッケン（256x192、CanvasTexture、sRGB）。
 *    - UV: 0..1（馬体側面に貼付、右側面はモデル側で UV 反転）。
 *    - 内容: 枠色ベース、縁のステッチ縫い目、布の綾織り目、中央上の白四角＆太字馬番、下部のカタカナ馬名。
 *
 * 【共通設計方針】
 * - 外部画像・Web フォントには一切依存せず、Three.js と Canvas 2D API、決定的乱数（mulberry32）のみで完全自己完結。
 * - 生成処理はブラウザ（Apple M2 Max 等）で合計 200ms 以下で高速に完了するよう設計。
 */

const SYSTEM_FONT_FAMILY =
  '"Hiragino Sans", "Noto Sans JP", system-ui, -apple-system, sans-serif';

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
 * 3 軸周期境界を持つ 3D バリューノイズテーブルを展開する。
 *
 * Why not: ボクセルループごとに関数呼び出しや剰余算を行う方式だと
 * 64^3 = 262,144 回のオーバーヘッドで実行時間が数十ミリ秒跳ね上がるため、
 * X/Y 軸の格子インデックスと補間重みを事前計算してインライン補間する。
 */
const createPeriodicNoise3D = (
  size: number,
  gridX: number,
  gridY: number,
  gridZ: number,
  rng: () => number
): Float32Array => {
  const lattice = Float32Array.from(
    { length: gridX * gridY * gridZ },
    () => rng()
  );
  const total = size * size * size;
  const output = new Float32Array(total);

  const xi0Arr = new Int32Array(size);
  const xi1Arr = new Int32Array(size);
  const fxArr = new Float32Array(size);
  for (let x = 0; x < size; x += 1) {
    const wx = (x / size) * gridX;
    const xi = Math.floor(wx);
    xi0Arr[x] = xi % gridX;
    xi1Arr[x] = (xi + 1) % gridX;
    fxArr[x] = smooth(wx - xi);
  }

  const yi0Arr = new Int32Array(size);
  const yi1Arr = new Int32Array(size);
  const fyArr = new Float32Array(size);
  for (let y = 0; y < size; y += 1) {
    const wy = (y / size) * gridY;
    const yi = Math.floor(wy);
    yi0Arr[y] = (yi % gridY) * gridX;
    yi1Arr[y] = ((yi + 1) % gridY) * gridX;
    fyArr[y] = smooth(wy - yi);
  }

  const gridSlice = gridY * gridX;

  for (let z = 0; z < size; z += 1) {
    const wz = (z / size) * gridZ;
    const zi = Math.floor(wz);
    const fz = smooth(wz - zi);
    const zOffset = z * size * size;

    const slice0 = (zi % gridZ) * gridSlice;
    const slice1 = ((zi + 1) % gridZ) * gridSlice;

    for (let y = 0; y < size; y += 1) {
      const fy = fyArr[y];
      const yOffset = zOffset + y * size;

      const row00 = slice0 + yi0Arr[y];
      const row10 = slice0 + yi1Arr[y];
      const row01 = slice1 + yi0Arr[y];
      const row11 = slice1 + yi1Arr[y];

      for (let x = 0; x < size; x += 1) {
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
 * 2D Canvas 要素とそのコンテキストを生成する。
 */
const makeCanvas = (
  width: number,
  height: number
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const isContextUnavailable = ctx === null;
  if (isContextUnavailable) {
    throw new Error("2D canvas not available");
  }
  return { canvas, ctx };
};

/**
 * Canvas から sRGB 色空間の CanvasTexture を生成する。
 *
 * Why not: 呼び出し側で個別に設定すると colorSpace や needsUpdate の指定漏れが起き、
 * リニア色空間変換の抜けによって白飛びや暗部沈みが発生するため。
 */
const toPaddockCanvasTexture = (canvas: HTMLCanvasElement): THREE.CanvasTexture => {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
};

// =============================================================================
// 1. 周回路ゴムチップ舗装 3D テクスチャ (createPaddockTrackDetail)
// =============================================================================

/**
 * 周回路のゴムチップ舗装の質感を表現する 3D テクスチャを生成する。
 *
 * 【サンプリング方法】
 * シェーダー内ではワールド座標を 3.0 で除算してサンプリングする（1 周期 3 単位 = 2m）:
 *   vec4 trackDetail = texture(uTrackDetail, worldPos / 3.0);
 *
 * 【サイズ・形式】
 * 64x64x64 ボクセル、RGBA8 (UnsignedByteType, RGBAFormat)。
 * 3 軸すべて RepeatWrapping、LinearMipmapLinearFilter / LinearFilter、generateMipmaps = true。
 *
 * 【各チャンネルの役割】
 * - R: 色むら（チップの色の混ざり。大半 0.5 付近、黒いチップ 0.15、明るいチップ 0.8 が点在）＋低周波の踏まれむら
 * - G: 蹄の跡や擦れ（馬がいつも歩く所が少し明るく擦れる低周波のむら。平均 0.5）
 * - B: 粗さの揺らぎ（平均 0.7、ゴム舗装なのでつや消し）
 * - A: 高さ（チップの粒の凹凸。平均 0.5）
 *
 * Why not: NoColorSpace（生データ）として設定する。sRGB を指定するとシェーダー側で
 * ガンマ補正が掛かり、高さや粗さの物理パラメータが非線形に歪むため。
 */
export const createPaddockTrackDetail = (): THREE.Data3DTexture => {
  const SIZE = 64;
  const TOTAL = SIZE * SIZE * SIZE;
  const rng = createSeededRandom(4271983);

  // 周波数ごとの周期ノイズ:
  // - 低周波（踏まれむら・歩行トレース）: 4 周期
  // - 中周波（擦れ・蹄の摩耗帯）: 8 周期
  // - 粗さの揺らぎ: 4 周期
  const trampledNoise = createPeriodicNoise3D(SIZE, 4, 4, 4, rng);
  const scuffNoise = createPeriodicNoise3D(SIZE, 8, 8, 8, rng);
  const roughnessNoise = createPeriodicNoise3D(SIZE, 4, 4, 4, rng);

  const data = new Uint8Array(TOTAL * 4);

  for (let i = 0; i < TOTAL; i += 1) {
    // 高周波の微小チップ粒子（ボクセル単位の決定的擬似乱数）
    const chipRand = rng();
    const isDarkChip = chipRand < 0.12;
    const isBrightChip = chipRand > 0.88;

    let chipBase = 0.50 + (chipRand - 0.5) * 0.12;
    if (isDarkChip) {
      chipBase = 0.15 + (chipRand / 0.12) * 0.05;
    } else if (isBrightChip) {
      chipBase = 0.80 + ((chipRand - 0.88) / 0.12) * 0.06;
    }

    // --- R: 色むら（チップの混ざり + 低周波の踏まれたむら） ---
    const tr = (trampledNoise[i] - 0.5) * 0.22;
    let r = chipBase + tr;
    r = clamp(r, 0.0, 1.0);

    // --- G: 蹄の跡や擦れ（低周波の擦れ・歩行ライン。平均 0.5） ---
    const sc = (scuffNoise[i] - 0.5) * 0.28;
    const hoofImpression = (trampledNoise[i] > 0.65 ? 0.08 : 0.0);
    let g = 0.50 + sc + hoofImpression;
    g = clamp(g, 0.0, 1.0);

    // --- B: 粗さの揺らぎ（平均 0.7、ゴム舗装のマット感） ---
    let b = 0.70 + (roughnessNoise[i] - 0.5) * 0.18;
    // 黒チップや擦れた部分はわずかに粗さが異なる
    if (isDarkChip) {
      b -= 0.04;
    }
    b = clamp(b, 0.0, 1.0);

    // --- A: 高さ（チップ粒の凹凸。平均 0.5） ---
    // チップ粒ごとにわずかな段差。暗いチップは沈み、明るいチップは浮き出る傾向
    let a = 0.50 + (chipRand - 0.5) * 0.20;
    if (isDarkChip) {
      a -= 0.08;
    } else if (isBrightChip) {
      a += 0.08;
    }
    a = clamp(a, 0.0, 1.0);

    const idx = i * 4;
    data[idx] = Math.round(r * 255);
    data[idx + 1] = Math.round(g * 255);
    data[idx + 2] = Math.round(b * 255);
    data[idx + 3] = Math.round(a * 255);
  }

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

// =============================================================================
// 2. 内側芝生グラフィックテクスチャ (createPaddockLawnTexture)
// =============================================================================

/**
 * 馬蹄とルーレットを組み合わせた円形エンブレムを Canvas に描画する。
 *
 * @param ctx 描画先 2D コンテキスト
 * @param cx 中心の X 座標
 * @param cy 中心の Y 座標
 * @param radius エンブレムの外半径
 */
const drawPaddockEmblem = (
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number
): void => {
  ctx.save();
  ctx.translate(cx, cy);

  // 外枠リング（二重の刈り込みライン）
  ctx.strokeStyle = "rgba(144, 238, 126, 0.82)";
  ctx.lineWidth = radius * 0.04;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = "rgba(180, 248, 160, 0.65)";
  ctx.lineWidth = radius * 0.02;
  ctx.beginPath();
  ctx.arc(0, 0, radius * 0.94, 0, Math.PI * 2);
  ctx.stroke();

  // ルーレットのポケット分割（外周リング内の 24 分割セパレータ）
  const pocketCount = 24;
  const rOuter = radius * 0.92;
  const rInner = radius * 0.74;
  ctx.lineWidth = radius * 0.015;
  ctx.strokeStyle = "rgba(160, 240, 140, 0.75)";

  for (let i = 0; i < pocketCount; i += 1) {
    const angle = (i * Math.PI * 2) / pocketCount;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    ctx.beginPath();
    ctx.moveTo(cosA * rInner, sinA * rInner);
    ctx.lineTo(cosA * rOuter, sinA * rOuter);
    ctx.stroke();

    // 交互のトーンでセクタを淡く色分け
    const isAlt = i % 2 === 0;
    if (isAlt) {
      ctx.fillStyle = "rgba(170, 245, 150, 0.18)";
      ctx.beginPath();
      ctx.arc(0, 0, rOuter, angle, angle + (Math.PI * 2) / pocketCount);
      ctx.arc(0, 0, rInner, angle + (Math.PI * 2) / pocketCount, angle, true);
      ctx.closePath();
      ctx.fill();
    }
  }

  // 中央寄りの境界サークル
  ctx.beginPath();
  ctx.arc(0, 0, rInner, 0, Math.PI * 2);
  ctx.stroke();

  // 馬蹄（Horseshoe）の描画: 上部が開いた U 字形の肉厚な蹄鉄
  const rShoe = radius * 0.54;
  ctx.lineWidth = radius * 0.12;
  ctx.strokeStyle = "rgba(215, 255, 205, 0.88)";
  ctx.lineCap = "round";

  // 下部中心を円弧、上部左右へ立ち上がり
  ctx.beginPath();
  ctx.arc(0, -radius * 0.02, rShoe, Math.PI * 0.22, Math.PI * 0.78, false);
  ctx.stroke();

  // 蹄鉄の左右の枝（上に向かって垂直に伸びる）
  const branchX = rShoe * Math.cos(Math.PI * 0.22);
  const bottomY = -radius * 0.02 + rShoe * Math.sin(Math.PI * 0.22);
  const topY = -radius * 0.38;

  ctx.beginPath();
  ctx.moveTo(branchX, bottomY);
  ctx.lineTo(branchX, topY);
  ctx.moveTo(-branchX, bottomY);
  ctx.lineTo(-branchX, topY);
  ctx.stroke();

  // 蹄鉄の鋲穴（Nail holes）: 左右 3 箇所ずつ
  ctx.fillStyle = "rgba(40, 85, 30, 0.85)";
  const holeRadius = radius * 0.022;
  const holeYs = [-radius * 0.26, -radius * 0.10, radius * 0.08];
  for (const hy of holeYs) {
    ctx.beginPath();
    ctx.arc(branchX, hy, holeRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(-branchX, hy, holeRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  // ルーレットのセンターターレット（中心軸と放射状ハンドル）
  ctx.fillStyle = "rgba(230, 255, 220, 0.92)";
  ctx.beginPath();
  ctx.arc(0, -radius * 0.02, radius * 0.11, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "rgba(45, 95, 35, 0.80)";
  ctx.lineWidth = radius * 0.02;
  ctx.beginPath();
  ctx.arc(0, -radius * 0.02, radius * 0.11, 0, Math.PI * 2);
  ctx.stroke();

  // 4 本の放射状ハンドル
  ctx.strokeStyle = "rgba(220, 255, 210, 0.90)";
  ctx.lineWidth = radius * 0.035;
  ctx.lineCap = "round";
  for (let k = 0; k < 4; k += 1) {
    const handleAngle = (k * Math.PI) / 2 + Math.PI / 4;
    ctx.beginPath();
    ctx.moveTo(0, -radius * 0.02);
    ctx.lineTo(
      Math.cos(handleAngle) * radius * 0.24,
      -radius * 0.02 + Math.sin(handleAngle) * radius * 0.24
    );
    ctx.stroke();
  }

  // 中央の小さな宝石/ボール
  ctx.fillStyle = "rgba(255, 255, 255, 0.95)";
  ctx.beginPath();
  ctx.arc(0, -radius * 0.02, radius * 0.045, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
};

/**
 * 2. 内側の芝生の中央に貼るグラフィックテクスチャを生成する。
 *
 * 【仕様】
 * - 解像度: 2048 x 716（縦横比 40:14 ≒ 2.857）。
 * - UV: u は長軸方向（X）0..1、v は短軸方向 0..1（v = 1 が奥）。
 * - 色空間: sRGB (THREE.SRGBColorSpace)。
 * - 描画内容: 手入れされた美しい緑の芝生ベース、平行な芝刈り縞（7 本）、
 *   微細な芝目ノイズ、中央の馬蹄＆ルーレットエンブレム、左右の「LUCKY」「ROULETTE」刈り分け文字。
 */
export const createPaddockLawnTexture = (): THREE.CanvasTexture => {
  const WIDTH = 2048;
  const HEIGHT = 716;
  const { canvas, ctx } = makeCanvas(WIDTH, HEIGHT);
  const rng = createSeededRandom(8912345);

  // 1. ベースの芝生グラデーション（手入れされた鮮やかな緑）
  const baseGrad = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  baseGrad.addColorStop(0, "#3c762b");
  baseGrad.addColorStop(0.5, "#438230");
  baseGrad.addColorStop(1, "#366d27");
  ctx.fillStyle = baseGrad;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // 2. 芝刈りの縞（長軸に平行な 7 本の明暗ストライプ）
  const stripeCount = 7;
  const stripeH = HEIGHT / stripeCount;
  for (let i = 0; i < stripeCount; i += 1) {
    const isAlternate = i % 2 === 1;
    if (isAlternate) {
      ctx.fillStyle = "rgba(78, 150, 52, 0.28)";
      ctx.fillRect(0, i * stripeH, WIDTH, stripeH);
    } else {
      ctx.fillStyle = "rgba(32, 70, 22, 0.18)";
      ctx.fillRect(0, i * stripeH, WIDTH, stripeH);
    }
  }

  // 3. 微細な芝生の粒（決定的なスプリンクルで質感向上）
  // Why not: fillStyle を都度切り替えながら矩形を何万回も描画すると Canvas 2D の描画オーバーヘッドで
  // 500ms 以上要してしまうため、明色・暗色それぞれをまとめてバッチ描画し、生成時間を数ミリ秒に抑える。
  ctx.fillStyle = "rgba(180, 240, 140, 0.12)";
  for (let i = 0; i < 2500; i += 1) {
    const px = rng() * WIDTH;
    const py = rng() * HEIGHT;
    ctx.fillRect(px, py, 1.5, 2.5 + rng() * 2.0);
  }

  ctx.fillStyle = "rgba(18, 48, 14, 0.15)";
  for (let i = 0; i < 2500; i += 1) {
    const px = rng() * WIDTH;
    const py = rng() * HEIGHT;
    ctx.fillRect(px, py, 1.5, 2.5 + rng() * 2.0);
  }

  // 4. 中央の馬蹄＆ルーレットエンブレム
  const emblemCenterX = WIDTH / 2;
  const emblemCenterY = HEIGHT / 2;
  const emblemRadius = HEIGHT * 0.38; // 約 272px
  drawPaddockEmblem(ctx, emblemCenterX, emblemCenterY, emblemRadius);

  // 5. 左右の芝刈りロゴ文字「LUCKY」「ROULETTE」
  // 芝を刈り分けたような明るいトーン（白に近い薄緑）
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `900 112px ${SYSTEM_FONT_FAMILY}`;

  // 刈り込みシャドウ（芝の窪み感を出す暗い縁取り）
  ctx.lineWidth = 14;
  ctx.strokeStyle = "rgba(26, 60, 20, 0.70)";
  ctx.lineJoin = "round";

  const leftTextX = WIDTH * 0.22;
  const rightTextX = WIDTH * 0.78;
  const textY = HEIGHT * 0.50;

  // 左文字: "LUCKY"
  ctx.strokeText("LUCKY", leftTextX, textY);
  ctx.fillStyle = "rgba(215, 255, 195, 0.90)";
  ctx.fillText("LUCKY", leftTextX, textY);

  // 右文字: "ROULETTE"
  ctx.strokeText("ROULETTE", rightTextX, textY);
  ctx.fillStyle = "rgba(215, 255, 195, 0.90)";
  ctx.fillText("ROULETTE", rightTextX, textY);

  // 文字の下に小さな補助装飾ライン
  ctx.fillStyle = "rgba(180, 240, 160, 0.65)";
  ctx.fillRect(leftTextX - 160, textY + 70, 320, 5);
  ctx.fillRect(rightTextX - 210, textY + 70, 420, 5);

  return toPaddockCanvasTexture(canvas);
};

// =============================================================================
// 3. 電光掲示板背景テクスチャ (createPaddockBoardBackground)
// =============================================================================

/**
 * 3. パドック端の電光掲示板（16:9）用背景テクスチャを生成する。
 *
 * 【仕様】
 * - 解像度: 1920 x 1080（16:9）。
 * - 色空間: sRGB (THREE.SRGBColorSpace)。
 * - 描画内容:
 *   - 黒い LED パネルの微細画素格子とわずかなムラ。
 *   - 上 12%（0〜130px）: 濃い緑の見出し帯（#0c381e）と白い「パドック PADDOCK」文字。
 *   - その下（130〜192px）: 列見出し帯。
 *     x = 4%「馬番」、14%「馬名」、60%「馬体重」、76%「増減」、88%「単勝」。
 *   - 見出し帯より下は、Claude が馬番・馬名・オッズ・体重を行単位で重ねるため空けておく。
 */
export const createPaddockBoardBackground = (): THREE.CanvasTexture => {
  const WIDTH = 1920;
  const HEIGHT = 1080;
  const { canvas, ctx } = makeCanvas(WIDTH, HEIGHT);
  const rng = createSeededRandom(6723419);

  // 1. 黒い LED パネル下地
  ctx.fillStyle = "#0d1012";
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // パネルの微小ムラ（ブロックごとの輝度差）
  const blockW = 60;
  const blockH = 40;
  const cols = Math.ceil(WIDTH / blockW);
  const rows = Math.ceil(HEIGHT / blockH);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const panelNoise = (rng() - 0.5) * 0.04;
      if (panelNoise > 0) {
        ctx.fillStyle = `rgba(255, 255, 255, ${panelNoise.toFixed(3)})`;
        ctx.fillRect(c * blockW, r * blockH, blockW, blockH);
      } else {
        ctx.fillStyle = `rgba(0, 0, 0, ${(-panelNoise).toFixed(3)})`;
        ctx.fillRect(c * blockW, r * blockH, blockW, blockH);
      }
    }
  }

  // LED パネルの格子ライン（水平・垂直の微細な走査線・画素スリット）
  ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
  for (let y = 0; y < HEIGHT; y += 4) {
    ctx.fillRect(0, y, WIDTH, 1);
  }
  for (let x = 0; x < WIDTH; x += 4) {
    ctx.fillRect(x, 0, 1, HEIGHT);
  }

  // 2. 最上部 12%（約 130px）の濃緑見出し帯
  const titleHeight = Math.round(HEIGHT * 0.12); // 130px
  const titleGrad = ctx.createLinearGradient(0, 0, 0, titleHeight);
  titleGrad.addColorStop(0, "#082613");
  titleGrad.addColorStop(0.5, "#0e3a1f");
  titleGrad.addColorStop(1, "#092915");
  ctx.fillStyle = titleGrad;
  ctx.fillRect(0, 0, WIDTH, titleHeight);

  // 金色の細いトリムライン
  ctx.fillStyle = "#d4af37";
  ctx.fillRect(0, titleHeight - 3, WIDTH, 3);

  // 見出し帯文字「パドック PADDOCK」
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `bold 62px ${SYSTEM_FONT_FAMILY}`;
  ctx.fillStyle = "#ffffff";
  ctx.fillText("パドック  PADDOCK", WIDTH / 2, titleHeight / 2 - 2);

  // 3. 列見出し帯（タイトル帯の下 62px、130px〜192px）
  const headerY = titleHeight;
  const headerHeight = 62;
  ctx.fillStyle = "#161b20";
  ctx.fillRect(0, headerY, WIDTH, headerHeight);

  // 列見出しの下線
  ctx.fillStyle = "#2c343e";
  ctx.fillRect(0, headerY + headerHeight - 2, WIDTH, 2);

  // 列見出し文字
  ctx.font = `bold 30px ${SYSTEM_FONT_FAMILY}`;
  ctx.fillStyle = "#e0e6ed";
  ctx.textBaseline = "middle";

  const columns = [
    { text: "馬番", xRatio: 0.04, align: "left" as CanvasTextAlign },
    { text: "馬名", xRatio: 0.14, align: "left" as CanvasTextAlign },
    { text: "馬体重", xRatio: 0.60, align: "center" as CanvasTextAlign },
    { text: "増減", xRatio: 0.76, align: "center" as CanvasTextAlign },
    { text: "単勝", xRatio: 0.88, align: "center" as CanvasTextAlign },
  ];

  for (const col of columns) {
    ctx.textAlign = col.align;
    const posX = WIDTH * col.xRatio;
    const posY = headerY + headerHeight / 2;
    ctx.fillText(col.text, posX, posY);
  }

  // 4. データ表示エリア（見出し下）の薄い水平グリッドガイド
  // 行の区切り線をごく淡く入れておき、テキスト描画時の視認性を高める
  const dataStartY = headerY + headerHeight;
  const rowH = 68;
  const maxRows = Math.floor((HEIGHT - dataStartY) / rowH);
  ctx.fillStyle = "rgba(255, 255, 255, 0.03)";
  for (let r = 0; r < maxRows; r += 1) {
    const ry = dataStartY + r * rowH;
    ctx.fillRect(0, ry, WIDTH, 1);
  }

  return toPaddockCanvasTexture(canvas);
};

// =============================================================================
// 4. 施設看板テクスチャ (createPaddockSignTexture)
// =============================================================================

export type PaddockSignKind = "jockeyRoom" | "saddlingGate";

/**
 * 4. 騎手控室または装鞍所の看板テクスチャを生成する。
 *
 * 【仕様】
 * - kind = "jockeyRoom": 1600 x 192（壁面用 10 x 1.2 単位）。
 *   「騎手控室 JOCKEYS' ROOM」（アポストロフィ付き）。
 * - kind = "saddlingGate": 1600 x 240（門用 6 x 0.9 単位）。
 *   「装鞍所 SADDLING PADDOCK」。
 * - 色空間: sRGB (THREE.SRGBColorSpace)。
 * - 意匠: 格式ある JRA 競馬場サインを踏襲した濃緑地、白文字、細い金の二重縁取り。
 */
export const createPaddockSignTexture = (
  kind: PaddockSignKind
): THREE.CanvasTexture => {
  const isJockeyRoom = kind === "jockeyRoom";
  const WIDTH = 1600;
  const HEIGHT = isJockeyRoom ? 192 : 240;
  const { canvas, ctx } = makeCanvas(WIDTH, HEIGHT);

  // 1. 深い濃緑のグラデーション背景
  const bgGrad = ctx.createLinearGradient(0, 0, 0, HEIGHT);
  bgGrad.addColorStop(0, "#0a2615");
  bgGrad.addColorStop(0.5, "#0f381f");
  bgGrad.addColorStop(1, "#082112");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // 2. 上質な金の縁取り（外枠 + 内側細線）
  // 外側の金枠
  ctx.strokeStyle = "#c59d3f";
  ctx.lineWidth = 6;
  ctx.strokeRect(6, 6, WIDTH - 12, HEIGHT - 12);

  // 内側の細い金枠
  ctx.strokeStyle = "rgba(235, 204, 112, 0.65)";
  ctx.lineWidth = 2;
  ctx.strokeRect(14, 14, WIDTH - 28, HEIGHT - 28);

  // 4 隅の装飾コーナーピン
  const pinRadius = 4;
  ctx.fillStyle = "#dfba5a";
  const pinOffsets = [
    [14, 14],
    [WIDTH - 14, 14],
    [14, HEIGHT - 14],
    [WIDTH - 14, HEIGHT - 14],
  ];
  for (const [px, py] of pinOffsets) {
    ctx.beginPath();
    ctx.arc(px, py, pinRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  // 3. 看板テキストの描画
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (isJockeyRoom) {
    // 「騎手控室 JOCKEYS' ROOM」
    // 日本語（大きめ）と英語（小さめ）を均整の取れたレイアウトで配置
    const centerY = HEIGHT / 2;

    ctx.font = `bold 76px ${SYSTEM_FONT_FAMILY}`;
    ctx.fillStyle = "#ffffff";
    ctx.fillText("騎手控室", WIDTH * 0.35, centerY);

    ctx.font = `600 52px ${SYSTEM_FONT_FAMILY}`;
    ctx.fillStyle = "rgba(240, 248, 240, 0.92)";
    ctx.fillText("JOCKEYS' ROOM", WIDTH * 0.70, centerY);

    // 中央の縦仕切りピン
    ctx.fillStyle = "rgba(212, 175, 55, 0.6)";
    ctx.fillRect(WIDTH * 0.51 - 1, centerY - 32, 2, 64);
  } else {
    // 「装鞍所 SADDLING PADDOCK」
    const jpY = HEIGHT * 0.38;
    const enY = HEIGHT * 0.75;

    ctx.font = `bold 92px ${SYSTEM_FONT_FAMILY}`;
    ctx.fillStyle = "#ffffff";
    ctx.fillText("装鞍所", WIDTH / 2, jpY);

    ctx.font = `600 44px ${SYSTEM_FONT_FAMILY}`;
    ctx.fillStyle = "rgba(235, 245, 235, 0.92)";
    ctx.fillText("SADDLING PADDOCK", WIDTH / 2, enY);
  }

  return toPaddockCanvasTexture(canvas);
};

// =============================================================================
// 5. 馬番・馬名入りゼッケン (createZekkenTexture)
// =============================================================================

/**
 * 5. 馬の鞍の下に着けるゼッケン（馬番・馬名・枠色）用テクスチャを生成する。
 *
 * 【仕様】
 * - 解像度: 256 x 192（CanvasTexture）。
 * - 色空間: sRGB (THREE.SRGBColorSpace)。
 * - UV: 0..1（馬体側面にそのまま貼付。右側面はシーン側で鏡像反転される）。
 * - 描画内容:
 *   - 枠色の地（指定された color）
 *   - 外周の縫い目ステッチライン
 *   - 布らしいごく微細な綾織り（ツイル）テクスチャ
 *   - 中央上の白い四角プレート＋太字黒文字の馬番
 *   - 下部の白太字の馬名（カタカナ最大 9 文字。長い場合は長体をかけて収める）
 */
export const createZekkenTexture = (
  number: number,
  name: string,
  color: string
): THREE.CanvasTexture => {
  const WIDTH = 256;
  const HEIGHT = 192;
  const { canvas, ctx } = makeCanvas(WIDTH, HEIGHT);
  const rng = createSeededRandom(number * 10007 + 389);

  // 1. 枠色の地塗り
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // 微細な布繊維ノイズ（質感向上）
  for (let i = 0; i < 600; i += 1) {
    const fx = rng() * WIDTH;
    const fy = rng() * HEIGHT;
    const isBright = rng() < 0.5;
    ctx.fillStyle = isBright
      ? "rgba(255, 255, 255, 0.04)"
      : "rgba(0, 0, 0, 0.04)";
    ctx.fillRect(fx, fy, 1, 1);
  }

  // 外枠のわずかな立体感（外周シャドウ・ハイライト）
  ctx.fillStyle = "rgba(0, 0, 0, 0.18)";
  ctx.fillRect(0, HEIGHT - 5, WIDTH, 5);
  ctx.fillRect(WIDTH - 5, 0, 5, HEIGHT);
  ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
  ctx.fillRect(0, 0, WIDTH, 4);
  ctx.fillRect(0, 0, 4, HEIGHT);

  // 2. 布らしい弱い綾織り目（45 度斜めのストライプと微小ノイズ）
  // Why not: 全ピクセル走査を行わず、低不透明度の 45 度線と決定的ノイズを組み合わせることで
  // 1 枚あたり 1ms 未満で高品質な織り目質感を再現する。
  ctx.strokeStyle = "rgba(0, 0, 0, 0.05)";
  ctx.lineWidth = 1;
  const step = 4;
  for (let x = -HEIGHT; x < WIDTH; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + HEIGHT, HEIGHT);
    ctx.stroke();
  }

  // 3. 外周のステッチ（縫い目）
  ctx.strokeStyle = "rgba(255, 255, 255, 0.35)";
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(8, 8, WIDTH - 16, HEIGHT - 16);
  ctx.setLineDash([]); // リセット

  // 内側の薄い糸穴シャドウ
  ctx.strokeStyle = "rgba(0, 0, 0, 0.20)";
  ctx.lineWidth = 1;
  ctx.strokeRect(9, 9, WIDTH - 18, HEIGHT - 18);

  // 4. 馬番プレート（中央上の白い四角プレート）
  const plateW = 120;
  const plateH = 92;
  const plateX = (WIDTH - plateW) / 2;
  const plateY = 16;
  const plateRadius = 8;

  // 白四角プレートの角丸矩形
  ctx.save();
  ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
  ctx.beginPath();
  ctx.roundRect(plateX, plateY, plateW, plateH, plateRadius);
  ctx.fill();

  // プレートの外周細枠
  ctx.strokeStyle = "rgba(0, 0, 0, 0.18)";
  ctx.lineWidth = 2;
  ctx.stroke();

  // 大きな馬番数字
  ctx.fillStyle = "#111111";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const numStr = String(number);
  const isSingleDigit = number < 10;
  ctx.font = isSingleDigit
    ? `bold 76px ${SYSTEM_FONT_FAMILY}`
    : `bold 64px ${SYSTEM_FONT_FAMILY}`;
  ctx.fillText(numStr, WIDTH / 2, plateY + plateH / 2 + 2);
  ctx.restore();

  // 5. 下部の馬名（カタカナ 9 文字まで）
  // 枠色によらず明瞭に読めるよう、黒のドロップシャドウ/アウトライン付きの白文字で印字
  const nameY = 148;
  const maxNameWidth = WIDTH - 36; // 左右 18px マージン

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `bold 32px ${SYSTEM_FONT_FAMILY}`;

  // 文字幅を測定し、枠を超える場合は scale で長体をかけて収める
  const measured = ctx.measureText(name);
  ctx.save();
  if (measured.width > maxNameWidth) {
    const scaleFactor = maxNameWidth / measured.width;
    ctx.translate(WIDTH / 2, nameY);
    ctx.scale(scaleFactor, 1.0);
    ctx.translate(-WIDTH / 2, -nameY);
  }

  // 視認性を担保する黒の太い輪郭
  ctx.lineWidth = 6;
  ctx.strokeStyle = "rgba(10, 10, 10, 0.85)";
  ctx.lineJoin = "round";
  ctx.strokeText(name, WIDTH / 2, nameY);

  // 本文の白文字
  ctx.fillStyle = "#ffffff";
  ctx.fillText(name, WIDTH / 2, nameY);

  ctx.restore();

  return toPaddockCanvasTexture(canvas);
};
