import * as THREE from "three";

// 競馬場コース上の標識（ハロン棒・ゴール板）用テクスチャを手続き生成する。
// 外部画像やフォントファイルは使用せず、Canvas 2D API で直接描画することで
// ネットワーク読み込み待ちやアセットの欠損を防いでいる。

/**
 * 2D Canvas 要素とそのコンテキストを初期化して返す
 */
const makeCanvas = (width: number, height: number) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("2D canvas not available");
  }
  return { canvas, ctx };
};

/**
 * Canvas から標識用 Three.js テクスチャを生成して共通設定を適用する
 */
const toSignTexture = (canvas: HTMLCanvasElement): THREE.CanvasTexture => {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
};

// =============================================================================
// 1. ハロン棒の数字アトラス (createFurlongNumberAtlas)
// =============================================================================

const FURLONG_ATLAS_SIZE = 2048;
const FURLONG_GRID_COUNT = 6;
const FURLONG_CELL_SIZE = FURLONG_ATLAS_SIZE / FURLONG_GRID_COUNT; // 341.333...

/**
 * ハロン棒（残り距離標示板）用の数字アトラス（1〜36）を生成する。
 * 6x6 マスの 2048x2048 テクスチャに、残り距離 100m〜3600m に対応する数字を配置する。
 */
export const createFurlongNumberAtlas = (): {
  texture: THREE.CanvasTexture;
  cellUv: (meters: number) => { offset: THREE.Vector2; repeat: THREE.Vector2 };
  dispose: () => void;
} => {
  const { canvas, ctx } = makeCanvas(FURLONG_ATLAS_SIZE, FURLONG_ATLAS_SIZE);

  // 白地ベース
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, FURLONG_ATLAS_SIZE, FURLONG_ATLAS_SIZE);

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";

  // 1 から 36 までの数字を 6x6 のセルに描画
  for (let i = 0; i < 36; i += 1) {
    const num = i + 1;
    const col = i % FURLONG_GRID_COUNT;
    const row = Math.floor(i / FURLONG_GRID_COUNT);
    const cx = (col + 0.5) * FURLONG_CELL_SIZE;
    const cy = (row + 0.5) * FURLONG_CELL_SIZE;

    const isSingleDigit = num < 10;
    const text = String(num);

    // 円の内側に収めるため、2桁の場合はフォントサイズと最大描画幅を詰める。
    // Why not: 単一フォントサイズで描画しなかったのは、2桁数字（特に 20〜36）が
    // 標示板形状である円の内接領域からはみ出して外周赤枠と重なるのを防ぐため。
    ctx.font = isSingleDigit ? "900 216px sans-serif" : "900 196px sans-serif";
    const maxWidth = isSingleDigit
      ? FURLONG_CELL_SIZE * 0.72
      : FURLONG_CELL_SIZE * 0.76;

    // 遠景での視認性向上のため、暗い赤の太い縁取りを施した後に鮮やかな赤で塗りつぶす
    ctx.lineWidth = 14;
    ctx.strokeStyle = "#9a0007";
    ctx.strokeText(text, cx, cy + 4, maxWidth);

    ctx.fillStyle = "#d32f2f";
    ctx.fillText(text, cx, cy + 4, maxWidth);
  }

  const texture = toSignTexture(canvas);

  // 事前に 36 パターン分の UV を事前計算してテーブルに保持する。
  // Why not: cellUv 呼び出しのたびに new THREE.Vector2 を動的生成しなかったのは、
  // アニメーションループ内や距離更新時の不要な GC プレッシャーをゼロにするため。
  const repeat = new THREE.Vector2(1 / FURLONG_GRID_COUNT, 1 / FURLONG_GRID_COUNT);
  const uvCache: Array<{ offset: THREE.Vector2; repeat: THREE.Vector2 }> = [];

  for (let i = 0; i < 36; i += 1) {
    const col = i % FURLONG_GRID_COUNT;
    const row = Math.floor(i / FURLONG_GRID_COUNT);

    // Three.js の CanvasTexture は flipY = true（デフォルト）で反転される。
    // Canvas 上で最上段 (row = 0) のマスは UV 空間の v = 1 に対応するため、
    // マスの下端 offset.y は (GRID_COUNT - 1 - row) / GRID_COUNT となる。
    // これにより、メッシュの v=0..1 に正立した数字がテクスチャマッピングされる。
    const offset = new THREE.Vector2(
      col / FURLONG_GRID_COUNT,
      (FURLONG_GRID_COUNT - 1 - row) / FURLONG_GRID_COUNT
    );
    uvCache.push({ offset, repeat });
  }

  const cellUv = (meters: number) => {
    // 100m 単位に丸め、1〜36 のインデックス範囲内にクランプする
    const num = Math.min(36, Math.max(1, Math.round(meters / 100)));
    return uvCache[num - 1];
  };

  const dispose = () => {
    texture.dispose();
  };

  return { texture, cellUv, dispose };
};

// =============================================================================
// 2. ゴール板看板の絵 (createFinishPostArt)
// =============================================================================

const FINISH_WIDTH = 1024;
const FINISH_HEIGHT = 2048;

/**
 * 蹄鉄の U 字パス（上向き開口）を Canvas に作成する
 */
const buildHorseshoePath = (
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rOut: number,
  rIn: number,
  armH: number
) => {
  ctx.beginPath();
  // 左アーム外側上端からスタート
  ctx.moveTo(cx - rOut, cy - armH);
  // 左アーム先端の丸み
  ctx.arc(cx - (rOut + rIn) / 2, cy - armH, (rOut - rIn) / 2, Math.PI, 0, false);
  // 左アーム内側を下方へ
  ctx.lineTo(cx - rIn, cy);
  // 内側アーチ（0 -> PI）
  ctx.arc(cx, cy, rIn, Math.PI, 0, true);
  // 右アーム内側を上方へ
  ctx.lineTo(cx + rIn, cy - armH);
  // 右アーム先端の丸み
  ctx.arc(cx + (rOut + rIn) / 2, cy - armH, (rOut - rIn) / 2, Math.PI, 0, false);
  // 右アーム外側を下方へ
  ctx.lineTo(cx + rOut, cy);
  // 外側アーチ（0 -> PI）
  ctx.arc(cx, cy, rOut, 0, Math.PI, false);
  ctx.closePath();
};

/**
 * ゴール板（ゴール線上の大型アーチ看板）用の縦長アートテクスチャを生成する。
 * - 上から下へ深いワインレッド〜鮮烈な赤〜アンバーゴールドのグラデーション
 * - 放射状サンバースト光線
 * - 中央部: ルーレットの円盤と蹄鉄を組み合わせたオリジナル図案
 * - 上部: 小さく「LUCKY ROULETTE」
 * - 下部: 大きく縁取られた「GOAL」の文字
 * ※ 中央の縦スリット帯（u = 0.47〜0.53、x ≒ 481〜543）に文字や重要モチーフが重ならないよう左右に配分している。
 */
export const createFinishPostArt = (): {
  texture: THREE.CanvasTexture;
  dispose: () => void;
} => {
  const { canvas, ctx } = makeCanvas(FINISH_WIDTH, FINISH_HEIGHT);

  // ---------------------------------------------------------------------------
  // 1. 地色: 深い赤〜金色の垂直グラデーション
  // ---------------------------------------------------------------------------
  const bgGrad = ctx.createLinearGradient(0, 0, 0, FINISH_HEIGHT);
  bgGrad.addColorStop(0.0, "#2c0409"); // 頂部: ディープバーガンディ
  bgGrad.addColorStop(0.18, "#6d0d1b"); // 上部: クラシックワイン
  bgGrad.addColorStop(0.48, "#a31824"); // 中央: クリムゾンレッド
  bgGrad.addColorStop(0.72, "#d48113"); // 中下部: アンバーゴールド
  bgGrad.addColorStop(0.88, "#804008"); // 下部: リッチブロンズ
  bgGrad.addColorStop(1.0, "#220e03"); // 最下部: ダークウッド
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, FINISH_WIDTH, FINISH_HEIGHT);

  // ---------------------------------------------------------------------------
  // 2. 放射状の光のすじ（サンバースト）
  // ---------------------------------------------------------------------------
  const rayCenter = { x: FINISH_WIDTH / 2, y: 880 };
  const rayCount = 32;
  const rayStep = (Math.PI * 2) / rayCount;
  const rayRadius = 1400;

  ctx.save();
  for (let i = 0; i < rayCount; i += 2) {
    const startAngle = i * rayStep;
    const endAngle = (i + 1) * rayStep;
    const rayGrad = ctx.createRadialGradient(
      rayCenter.x,
      rayCenter.y,
      120,
      rayCenter.x,
      rayCenter.y,
      rayRadius
    );
    rayGrad.addColorStop(0, "rgba(255, 235, 160, 0.22)");
    rayGrad.addColorStop(0.5, "rgba(255, 215, 0, 0.10)");
    rayGrad.addColorStop(1, "rgba(255, 190, 0, 0)");

    ctx.fillStyle = rayGrad;
    ctx.beginPath();
    ctx.moveTo(rayCenter.x, rayCenter.y);
    ctx.arc(rayCenter.x, rayCenter.y, rayRadius, startAngle, endAngle);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // ---------------------------------------------------------------------------
  // 3. クラシカルな外枠ゴールドボーダー
  // ---------------------------------------------------------------------------
  ctx.save();
  ctx.strokeStyle = "rgba(255, 215, 0, 0.75)";
  ctx.lineWidth = 6;
  ctx.strokeRect(32, 32, FINISH_WIDTH - 64, FINISH_HEIGHT - 64);
  ctx.strokeStyle = "rgba(255, 240, 180, 0.45)";
  ctx.lineWidth = 2;
  ctx.strokeRect(44, 44, FINISH_WIDTH - 88, FINISH_HEIGHT - 88);
  ctx.restore();

  // ---------------------------------------------------------------------------
  // 4. 最上部: 「LUCKY ROULETTE」
  // ---------------------------------------------------------------------------
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const topTextGrad = ctx.createLinearGradient(0, 110, 0, 170);
  topTextGrad.addColorStop(0, "#fffbe6");
  topTextGrad.addColorStop(0.5, "#ffd700");
  topTextGrad.addColorStop(1, "#b38600");

  ctx.shadowColor = "rgba(0, 0, 0, 0.8)";
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 4;

  ctx.font = "bold 44px sans-serif";
  ctx.fillStyle = topTextGrad;
  ctx.fillText("★  LUCKY ROULETTE  ★", FINISH_WIDTH / 2, 140);
  ctx.restore();

  // タイトル下のゴールド装飾バー（中央のスリット帯を避けて左右に分割）
  ctx.save();
  ctx.strokeStyle = "rgba(255, 215, 0, 0.7)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(90, 185);
  ctx.lineTo(440, 185);
  ctx.moveTo(584, 185);
  ctx.lineTo(934, 185);
  ctx.stroke();
  ctx.restore();

  // ---------------------------------------------------------------------------
  // 5. 中ほど: ルーレットの円盤と蹄鉄を組み合わせた図案 (cx = 512, cy = 880)
  // ---------------------------------------------------------------------------
  const wheelCenter = { x: 512, y: 880 };

  // 5-A: 背面の蹄鉄（ラッキーホースシュー）
  ctx.save();
  const hsOut = 310;
  const hsIn = 210;
  const hsArm = 240;

  // 蹄鉄の影
  ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 12;

  // 蹄鉄のグラデーション塗り
  const hsGrad = ctx.createLinearGradient(
    wheelCenter.x - hsOut,
    wheelCenter.y - hsArm,
    wheelCenter.x + hsOut,
    wheelCenter.y + hsOut
  );
  hsGrad.addColorStop(0.0, "#fff5cc");
  hsGrad.addColorStop(0.3, "#e6b800");
  hsGrad.addColorStop(0.6, "#ffda44");
  hsGrad.addColorStop(1.0, "#996f00");

  buildHorseshoePath(ctx, wheelCenter.x, wheelCenter.y, hsOut, hsIn, hsArm);
  ctx.fillStyle = hsGrad;
  ctx.fill();

  ctx.shadowColor = "transparent";
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#ffeaa0";
  ctx.stroke();

  // 蹄鉄の鋲穴（ネイルホール。左右のアームと弧に各4箇所配置）
  const nailHoles = [
    { x: wheelCenter.x - 260, y: wheelCenter.y - 170 },
    { x: wheelCenter.x - 260, y: wheelCenter.y - 80 },
    { x: wheelCenter.x - 250, y: wheelCenter.y + 30 },
    { x: wheelCenter.x - 200, y: wheelCenter.y + 140 },
    { x: wheelCenter.x + 260, y: wheelCenter.y - 170 },
    { x: wheelCenter.x + 260, y: wheelCenter.y - 80 },
    { x: wheelCenter.x + 250, y: wheelCenter.y + 30 },
    { x: wheelCenter.x + 200, y: wheelCenter.y + 140 },
  ];

  ctx.fillStyle = "#331600";
  ctx.strokeStyle = "#ffd700";
  ctx.lineWidth = 2;
  for (const hole of nailHoles) {
    ctx.beginPath();
    ctx.ellipse(hole.x, hole.y, 9, 15, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();

  // 5-B: ルーレットの円盤（中心に配置）
  ctx.save();
  const rouletteRadius = 195;

  // ルーレット外周の真鍮リング
  const rimGrad = ctx.createRadialGradient(
    wheelCenter.x - 40,
    wheelCenter.y - 40,
    rouletteRadius * 0.7,
    wheelCenter.x,
    wheelCenter.y,
    rouletteRadius
  );
  rimGrad.addColorStop(0, "#ffea80");
  rimGrad.addColorStop(0.5, "#d49b00");
  rimGrad.addColorStop(0.85, "#fff1a8");
  rimGrad.addColorStop(1, "#7a4e00");

  ctx.beginPath();
  ctx.arc(wheelCenter.x, wheelCenter.y, rouletteRadius, 0, Math.PI * 2);
  ctx.fillStyle = rimGrad;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#402300";
  ctx.stroke();

  // ルーレットのポケット環（赤・黒・緑の扇形区切り）
  const pocketCount = 32;
  const pocketStep = (Math.PI * 2) / pocketCount;
  const pocketInnerR = 125;
  const pocketOuterR = 182;

  for (let i = 0; i < pocketCount; i += 1) {
    const isGreen = i === 0 || i === 16;
    const isRed = !isGreen && i % 2 === 1;

    let pocketColor = "#1f1f1f"; // 黒ポケット
    if (isGreen) {
      pocketColor = "#1b5e20"; // 緑（0 / 00）
    } else if (isRed) {
      pocketColor = "#b71c1c"; // 赤ポケット
    }

    const a1 = i * pocketStep;
    const a2 = (i + 1) * pocketStep;

    ctx.beginPath();
    ctx.arc(wheelCenter.x, wheelCenter.y, pocketOuterR, a1, a2);
    ctx.arc(wheelCenter.x, wheelCenter.y, pocketInnerR, a2, a1, true);
    ctx.closePath();
    ctx.fillStyle = pocketColor;
    ctx.fill();

    // ポケットの仕切り線（ゴールド）
    ctx.strokeStyle = "#ffd700";
    ctx.lineWidth = 2;
    ctx.stroke();

    // ポケット内の小ドット（金色のアクセント）
    const midAngle = (a1 + a2) / 2;
    const dotR = (pocketInnerR + pocketOuterR) / 2;
    ctx.beginPath();
    ctx.arc(
      wheelCenter.x + Math.cos(midAngle) * dotR,
      wheelCenter.y + Math.sin(midAngle) * dotR,
      2.5,
      0,
      Math.PI * 2
    );
    ctx.fillStyle = "#ffffff";
    ctx.fill();
  }

  // ルーレット内周コーン（木目・ブロンズの深み）
  const coneGrad = ctx.createRadialGradient(
    wheelCenter.x,
    wheelCenter.y,
    10,
    wheelCenter.x,
    wheelCenter.y,
    pocketInnerR
  );
  coneGrad.addColorStop(0, "#995c00");
  coneGrad.addColorStop(0.7, "#4d2600");
  coneGrad.addColorStop(1, "#1a0d00");

  ctx.beginPath();
  ctx.arc(wheelCenter.x, wheelCenter.y, pocketInnerR, 0, Math.PI * 2);
  ctx.fillStyle = coneGrad;
  ctx.fill();
  ctx.strokeStyle = "#ffd700";
  ctx.lineWidth = 3;
  ctx.stroke();

  // 中央の真鍮製スピナーハンドル（8方向のクロスレバー）
  ctx.strokeStyle = "#ffe280";
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  for (let a = 0; a < 8; a += 1) {
    const angle = (a * Math.PI) / 4;
    ctx.beginPath();
    ctx.moveTo(wheelCenter.x, wheelCenter.y);
    ctx.lineTo(
      wheelCenter.x + Math.cos(angle) * (pocketInnerR * 0.75),
      wheelCenter.y + Math.sin(angle) * (pocketInnerR * 0.75)
    );
    ctx.stroke();
  }

  // 中心ターレットのハブ球
  const hubGrad = ctx.createRadialGradient(
    wheelCenter.x - 8,
    wheelCenter.y - 8,
    4,
    wheelCenter.x,
    wheelCenter.y,
    34
  );
  hubGrad.addColorStop(0, "#ffffff");
  hubGrad.addColorStop(0.4, "#ffd700");
  hubGrad.addColorStop(1, "#805500");

  ctx.beginPath();
  ctx.arc(wheelCenter.x, wheelCenter.y, 34, 0, Math.PI * 2);
  ctx.fillStyle = hubGrad;
  ctx.fill();
  ctx.strokeStyle = "#fff2a3";
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.restore();

  // ---------------------------------------------------------------------------
  // 6. 下部: 大きな「GOAL」の文字
  // ---------------------------------------------------------------------------
  // ゴール板は左右 2 枚のパネル構造で、中央の縦スリット（u = 0.47〜0.53、x ≒ 481〜543）は
  // パネルの隙間で見えなくなる。
  // Why not: 単一の ctx.fillText("GOAL", 512, 1680) で描画しなかったのは、
  // 中央のスリットによって 'O' と 'A' の隣接部が物理的に切断され、文字の可読性が
  // 大きく損なわれるのを防ぐため。「G」「O」を左パネル、「A」「L」を右パネルに
  // 均等配置することで、中央スリットに一切重ならず左右それぞれで明瞭に読める設計とした。
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "900 240px sans-serif";

  // 文字の立体ゴールドグラデーション
  const goalGrad = ctx.createLinearGradient(0, 1560, 0, 1800);
  goalGrad.addColorStop(0.0, "#ffffff");
  goalGrad.addColorStop(0.25, "#fff1a8");
  goalGrad.addColorStop(0.65, "#d49b00");
  goalGrad.addColorStop(1.0, "#7a4800");

  const letters = [
    { char: "G", x: 180 }, // 左パネル
    { char: "O", x: 370 }, // 左パネル
    { char: "A", x: 654 }, // 右パネル
    { char: "L", x: 844 }, // 右パネル
  ];

  const goalY = 1680;

  for (const item of letters) {
    // 最外層の太い黒縁取り（遠景での輪郭強調）
    ctx.lineWidth = 26;
    ctx.strokeStyle = "#140406";
    ctx.lineJoin = "round";
    ctx.strokeText(item.char, item.x, goalY);

    // 中間層のブロンズ縁取り
    ctx.lineWidth = 14;
    ctx.strokeStyle = "#804008";
    ctx.strokeText(item.char, item.x, goalY);

    // 内部のゴールド塗りつぶし
    ctx.fillStyle = goalGrad;
    ctx.fillText(item.char, item.x, goalY);
  }

  ctx.restore();

  // ---------------------------------------------------------------------------
  // 7. 「GOAL」下のアクセントリボン & 星飾り
  // ---------------------------------------------------------------------------
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 32px sans-serif";
  ctx.fillStyle = "#ffd700";

  // 左パネルの星飾り
  ctx.fillText("★  ★  ★", 275, 1840);
  // 右パネルの星飾り
  ctx.fillText("★  ★  ★", 749, 1840);

  // 下部装飾ライン
  ctx.strokeStyle = "rgba(255, 215, 0, 0.6)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(90, 1880);
  ctx.lineTo(440, 1880);
  ctx.moveTo(584, 1880);
  ctx.lineTo(934, 1880);
  ctx.stroke();
  ctx.restore();

  const texture = toSignTexture(canvas);

  const dispose = () => {
    texture.dispose();
  };

  return { texture, dispose };
};
