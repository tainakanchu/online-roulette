import * as THREE from "three";

// 競馬ゲームの夜のニュース番組スタジオ「NEWS R」用グラフィックステクスチャ群。
// 報道スタジオの大型 LED ビジョン、サイドスクリーン、デスク正面の番組ロゴパネル、
// 床の返しモニター、および窓の外に見える東京の夜景パノラマを手続き生成する。
//
// 外部画像や Web フォントは使用せず、HTML5 Canvas 2D API と決定的な擬似乱数 (mulberry32) で
// 完全自己完結して描画し、外部アセット欠損・ネットワーク遅延・ビルド間の視覚的ブレを根絶している。
//
// =============================================================================
// 各テクスチャの仕様および用途
// =============================================================================
//
// 1. cityNightBackdrop (4096x1024, CanvasTexture, sRGB):
//    スタジオの窓の外に見える東京の夜景パノラマ。
//    窓の外の円筒の内側（高さ 9m、半径 11m）に貼る。
//    - UV: u は円周方向 0..1（約 220°、左 0・右 1）、v は下 0・上 1。
//          左右端（u=0 と u=1）は窓の視野外に隠れるためシームレス接続は不要。
//    - 描画内容: 下 1/3 に窓明かり（オフィス蛍光灯色と暖色）が灯る高層ビル群のシルエット、
//      屋上の赤色航空障害灯、地平線奥の微細な光の海、赤白の鉄塔（東京タワー風）と
//      細身の電波塔、ビル足元を流れる高速道路の光条（白ヘッドライトと赤テールランプ）。
//      上空は濃紺から地平線の光害による紫紺グラデーションと控えめな星。
//      emissive（自己発光）用として使用するため明暗のコントラストを高く確保。
//
// 2. programLogo (1200x320, CanvasTexture, sRGB):
//    デスク正面の番組ロゴ発光パネル（横長 1.2m x 0.32m、UV 0..1）。
//    - 描画内容: 深い濃紺の地に、クリーンな白太字「NEWS」と、シアンに発光し
//      ルーレット・ゴールの環状モチーフをあしらった大きな「R」、
//      および下部のサブタイトル「ROULETTE NEWS」と繊細な光沢フレーム。
//
// 3. videoWallBackground (1920x1080, CanvasTexture, sRGB):
//    背後の大型 LED ビジョン（16:9、幅 4.8m）待機中背景。
//    - 描画内容: 深い青〜濃紺グラデーションに、ゆるやかに曲がる細い光のリボン、
//      薄いグリッドや同心円レーダー等の HUD 風装飾、右下に控えめな「NEWS R」ロゴ。
//      中央から左はシーン側で文字や写真を重ねるため、模様を極めて控えめに維持。
//
// 4. sideScreenBackground (1080x1920, CanvasTexture, sRGB):
//    スタジオ左右の縦長モニター（9:16、幅 1.1m）用背景（左右共用 1 枚）。
//    - 描画内容: 縦方向グラデーションに、垂直に流れる光のライン、微細な縦ルーラー目盛り、
//      上部センタリング配置の「NEWS R」ロゴ。
//
// 5. floorMonitorScreen (640x360, CanvasTexture, sRGB):
//    床の返しモニター（16:9）用放送画面サムネイル。
//    - 描画内容: スタジオ放送画面の縮図。暗めの青い画面、上部の「LIVE」バッジと
//      時刻表示「21:00」、中央のプレビューワイプ枠、下部の白く明瞭なテロップ帯。

const SYSTEM_FONT_FAMILY =
  '"Hiragino Sans", "Noto Sans JP", system-ui, -apple-system, sans-serif';

/**
 * 2D Canvas 要素とそのコンテキストを初期化して返す。
 *
 * 【どう実現しているか】
 * document.createElement("canvas") で指定サイズのオフスクリーン Canvas を生成し、
 * 2D レンダリングコンテキストを取得する。
 *
 * 【なぜ他の方法を採らなかったか】
 * DOM 上に Canvas を追加配置する方式ではテスト実行やメモリリークの原因となりうるため、
 * 完全なインメモリ要素として完結させる。
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
 * Canvas から Three.js CanvasTexture を生成し、共通カラースペース設定を適用する。
 *
 * 【どう実現しているか】
 * THREE.CanvasTexture をインスタンス化し、sRGB 色空間と needsUpdate フラグを設定する。
 *
 * 【なぜ他の方法を採らなかったか】
 * 呼び出し側で個別に設定すると設定漏れ（特に colorSpace の不一致による色褪せ）が起きるため、
 * 生成関数内で確実かつ一律に適用する。anisotropy は呼び出し側のハードウェア性能に応じて
 * 設定されるため、ここではあえて指定しない。
 */
const toNewsTexture = (canvas: HTMLCanvasElement): THREE.CanvasTexture => {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
};

/**
 * シード値固定の決定的擬似乱数生成器（mulberry32）。
 *
 * 【どう実現しているか】
 * 32bit 整数演算を用いたビットシフトと乗算により、シード値から一意に決まる 0..1 の乱数を生成する。
 *
 * 【なぜ他の方法を採らなかったか】
 * Math.random() は実行時ごとに結果が変わり、夜景のビル群や星の配置がリロードのたびに揺らぎ、
 * スナップショットテストや視覚的再現性が損なわれるため。
 */
const createSeededRandom = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// =============================================================================
// 1. スタジオ窓外の東京夜景パノラマ (createCityNightBackdrop)
// =============================================================================

/**
 * スタジオ窓外に見える東京の夜景パノラマテクスチャ（4096x1024）を生成する。
 *
 * 【用途】
 * スタジオ背面の円筒型窓（高さ 9m、半径 11m）の内側に貼るパノラマ夜景。
 * emissive（自己発光マップ）として使われる想定のため、窓明かりや車のライトは
 * 鮮やかに発光し、夜空とビルの壁面は深い濃紺でコントラストを際立たせる。
 *
 * 【UV の向き】
 * - u: 円周方向 0..1（約 220°、左 0・右 1）。端と端は合致しなくてよい。
 * - v: 垂直方向 0..1（Canvas 下端が v=0、上端が v=1）。
 *
 * 【どう実現しているか】
 * 1. 空のグラデーション: 漆黒紺から地平線の光害による紫紺へのスムーズなグラデーションと微細な星。
 * 2. 遠景地平線: ソフトな光芒と、約 500 個の光の粒による奥深い低層街明かり。
 * 3. 高層ビル群: 約 70 棟のビルシルエット、格子状に点灯・消灯するオフィス窓明かり、
 *    屋上の赤い航空障害灯。
 * 4. 2 つの象徴的タワー: 赤白トラスの温かい光を放つ鉄塔（東京タワー風）と、クールブルーに
 *    ライトアップされた細身の電波塔。
 * 5. 高速道路: 車のヘッドライト（白〜暖白）とテールランプ（赤）が流れる光の帯。
 *
 * 【なぜ他の方法を採らなかったか】
 * 4096x1024 の高解像度ピクセルループ（ImageData 操作）を行うと数百ミリ秒を要してしまうため、
 * Canvas 2D の最適化されたパス描画・グラデーション・バッチ fillRect を活用し、
 * 30ms 前後の極めて軽量な実行速度でフォトリアルな夜景テクスチャを生成する。
 */
export const createCityNightBackdrop = (): THREE.CanvasTexture => {
  const width = 4096;
  const height = 1024;
  const { canvas, ctx } = makeCanvas(width, height);
  const random = createSeededRandom(42);

  // ---------------------------------------------------------------------------
  // 1. 夜空のグラデーション
  // ---------------------------------------------------------------------------
  const skyGradient = ctx.createLinearGradient(0, 0, 0, height);
  skyGradient.addColorStop(0.0, "#01030a");
  skyGradient.addColorStop(0.35, "#030818");
  skyGradient.addColorStop(0.55, "#081028");
  skyGradient.addColorStop(0.72, "#121536");
  skyGradient.addColorStop(0.85, "#1c173c"); // 街明かりで少し紫がかった紺
  skyGradient.addColorStop(1.0, "#15132a");
  ctx.fillStyle = skyGradient;
  ctx.fillRect(0, 0, width, height);

  // ---------------------------------------------------------------------------
  // 2. 星（高高度に控えめに点在）
  // ---------------------------------------------------------------------------
  const starCount = 130;
  for (let i = 0; i < starCount; i += 1) {
    const sx = random() * width;
    const sy = random() * (height * 0.42);
    const starRadius = 0.5 + random() * 1.0;
    const starAlpha = 0.3 + random() * 0.55;

    ctx.beginPath();
    ctx.arc(sx, sy, starRadius, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(225, 235, 255, ${starAlpha})`;
    ctx.fill();
  }

  // ---------------------------------------------------------------------------
  // 3. 地平線付近の光害グロー（奥の街の広がり）
  // ---------------------------------------------------------------------------
  const horizonGlow = ctx.createLinearGradient(0, height * 0.65, 0, height * 0.88);
  horizonGlow.addColorStop(0.0, "rgba(22, 24, 58, 0)");
  horizonGlow.addColorStop(0.5, "rgba(52, 38, 80, 0.45)");
  horizonGlow.addColorStop(0.8, "rgba(75, 48, 85, 0.5)");
  horizonGlow.addColorStop(1.0, "rgba(20, 20, 40, 0)");
  ctx.fillStyle = horizonGlow;
  ctx.fillRect(0, height * 0.65, width, height * 0.23);

  // 奥の低層街の微細な光の粒（遠景の光芒）
  const distantLightCount = 650;
  for (let i = 0; i < distantLightCount; i += 1) {
    const lx = random() * width;
    const ly = height * 0.68 + random() * (height * 0.12);
    const rVal = random();
    const isAmber = rVal < 0.45;
    const isCool = rVal > 0.8;
    let lightColor = "rgba(255, 238, 180, 0.75)";
    if (isAmber) {
      lightColor = "rgba(255, 175, 90, 0.7)";
    } else if (isCool) {
      lightColor = "rgba(180, 220, 255, 0.75)";
    }
    const dotSize = 0.8 + random() * 1.2;
    ctx.fillStyle = lightColor;
    ctx.fillRect(lx, ly, dotSize, dotSize);
  }

  // ---------------------------------------------------------------------------
  // 4. 遠景の低層ビルシルエット（奥行きのレイヤー）
  // ---------------------------------------------------------------------------
  const bgBuildingCount = 90;
  for (let i = 0; i < bgBuildingCount; i += 1) {
    const bw = 24 + random() * 45;
    const bx = (i / bgBuildingCount) * width + (random() - 0.5) * 40;
    const bh = 90 + random() * 140;
    const by = height * 0.76 - bh * 0.5;

    ctx.fillStyle = "#060a17";
    ctx.fillRect(bx, by, bw, height - by);

    // 低層ビルの細かな窓明かり
    const bgCols = Math.max(2, Math.floor(bw / 8));
    const bgRows = Math.max(3, Math.floor(bh / 10));
    for (let r = 0; r < bgRows; r += 1) {
      for (let c = 0; c < bgCols; c += 1) {
        const isWindowLit = random() < 0.4;
        if (isWindowLit) {
          const wx = bx + c * 8 + 2;
          const wy = by + r * 10 + 3;
          ctx.fillStyle =
            random() < 0.5
              ? "rgba(255, 225, 160, 0.5)"
              : "rgba(200, 230, 255, 0.5)";
          ctx.fillRect(wx, wy, 2.5, 2);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 5. 象徴的なタワー 1: 東京タワー風の赤白鉄塔 (u ≈ 0.27)
  // ---------------------------------------------------------------------------
  const tower1X = width * 0.27;
  const tower1BaseY = height * 0.76;
  const tower1TopY = height * 0.35;
  const tower1Height = tower1BaseY - tower1TopY;

  // 裾広がりの脚部シルエット
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(tower1X - 44, tower1BaseY);
  ctx.lineTo(tower1X - 16, tower1BaseY - tower1Height * 0.45);
  ctx.lineTo(tower1X - 10, tower1BaseY - tower1Height * 0.7);
  ctx.lineTo(tower1X - 3, tower1TopY + 28);
  ctx.lineTo(tower1X, tower1TopY);
  ctx.lineTo(tower1X + 3, tower1TopY + 28);
  ctx.lineTo(tower1X + 10, tower1BaseY - tower1Height * 0.7);
  ctx.lineTo(tower1X + 16, tower1BaseY - tower1Height * 0.45);
  ctx.lineTo(tower1X + 44, tower1BaseY);
  ctx.closePath();
  ctx.fillStyle = "#1e0b08";
  ctx.fill();

  // 温かいオレンジ〜アンバーの投光器ライトアップ
  const tower1Glow = ctx.createLinearGradient(
    0,
    tower1BaseY,
    0,
    tower1TopY
  );
  tower1Glow.addColorStop(0.0, "rgba(255, 120, 20, 0.85)");
  tower1Glow.addColorStop(0.4, "rgba(255, 160, 50, 0.9)");
  tower1Glow.addColorStop(0.7, "rgba(255, 200, 90, 0.85)");
  tower1Glow.addColorStop(1.0, "rgba(255, 230, 150, 0.95)");
  ctx.strokeStyle = tower1Glow;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // メイン展望台（二層デッキ、暖色系の光の帯）
  const obs1Y = tower1BaseY - tower1Height * 0.48;
  ctx.fillStyle = "#ffaa33";
  ctx.fillRect(tower1X - 22, obs1Y, 44, 14);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(tower1X - 20, obs1Y + 3, 40, 4);

  // 特別展望台（上部）
  const obs2Y = tower1BaseY - tower1Height * 0.74;
  ctx.fillStyle = "#ffcc55";
  ctx.fillRect(tower1X - 12, obs2Y, 24, 10);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(tower1X - 10, obs2Y + 2, 20, 3);

  // アンテナ尖塔と頂点の赤色航空障害灯
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(tower1X, tower1TopY + 28);
  ctx.lineTo(tower1X, tower1TopY);
  ctx.stroke();

  // 頂点赤色灯とグロー
  const tower1Beacon = ctx.createRadialGradient(
    tower1X,
    tower1TopY,
    0,
    tower1X,
    tower1TopY,
    14
  );
  tower1Beacon.addColorStop(0.0, "#ffffff");
  tower1Beacon.addColorStop(0.3, "rgba(255, 40, 40, 0.95)");
  tower1Beacon.addColorStop(1.0, "rgba(255, 30, 30, 0)");
  ctx.fillStyle = tower1Beacon;
  ctx.beginPath();
  ctx.arc(tower1X, tower1TopY, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // ---------------------------------------------------------------------------
  // 6. 象徴的なタワー 2: 細身のモダン電波塔風 (u ≈ 0.73)
  // ---------------------------------------------------------------------------
  const tower2X = width * 0.73;
  const tower2BaseY = height * 0.77;
  const tower2TopY = height * 0.31;
  const tower2Height = tower2BaseY - tower2TopY;

  ctx.save();
  // スレンダーな円錐状シルエット
  ctx.beginPath();
  ctx.moveTo(tower2X - 22, tower2BaseY);
  ctx.lineTo(tower2X - 10, tower2BaseY - tower2Height * 0.4);
  ctx.lineTo(tower2X - 6, tower2BaseY - tower2Height * 0.75);
  ctx.lineTo(tower2X - 1.5, tower2TopY + 24);
  ctx.lineTo(tower2X, tower2TopY);
  ctx.lineTo(tower2X + 1.5, tower2TopY + 24);
  ctx.lineTo(tower2X + 6, tower2BaseY - tower2Height * 0.75);
  ctx.lineTo(tower2X + 10, tower2BaseY - tower2Height * 0.4);
  ctx.lineTo(tower2X + 22, tower2BaseY);
  ctx.closePath();
  ctx.fillStyle = "#061022";
  ctx.fill();

  // クールブルー〜ホワイトの LED ライティング
  const tower2Glow = ctx.createLinearGradient(
    0,
    tower2BaseY,
    0,
    tower2TopY
  );
  tower2Glow.addColorStop(0.0, "rgba(0, 180, 255, 0.75)");
  tower2Glow.addColorStop(0.5, "rgba(100, 220, 255, 0.85)");
  tower2Glow.addColorStop(1.0, "rgba(220, 245, 255, 0.95)");
  ctx.strokeStyle = tower2Glow;
  ctx.lineWidth = 2.2;
  ctx.stroke();

  // 展望デッキ 1（中間部リング）
  const t2Deck1Y = tower2BaseY - tower2Height * 0.48;
  ctx.fillStyle = "#00d4ff";
  ctx.fillRect(tower2X - 18, t2Deck1Y, 36, 8);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(tower2X - 16, t2Deck1Y + 2, 32, 2.5);

  // 展望デッキ 2（上部リング）
  const t2Deck2Y = tower2BaseY - tower2Height * 0.72;
  ctx.fillStyle = "#80e5ff";
  ctx.fillRect(tower2X - 12, t2Deck2Y, 24, 7);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(tower2X - 10, t2Deck2Y + 1.5, 20, 2);

  // 尖塔と頂点の赤色航空障害灯
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(tower2X, tower2TopY + 24);
  ctx.lineTo(tower2X, tower2TopY);
  ctx.stroke();

  const tower2Beacon = ctx.createRadialGradient(
    tower2X,
    tower2TopY,
    0,
    tower2X,
    tower2TopY,
    14
  );
  tower2Beacon.addColorStop(0.0, "#ffffff");
  tower2Beacon.addColorStop(0.3, "rgba(255, 45, 45, 0.95)");
  tower2Beacon.addColorStop(1.0, "rgba(255, 30, 30, 0)");
  ctx.fillStyle = tower2Beacon;
  ctx.beginPath();
  ctx.arc(tower2X, tower2TopY, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // ---------------------------------------------------------------------------
  // 7. 近景〜中景の手前高層ビル群（下 1/3、オフィスの格子窓明かり）
  // ---------------------------------------------------------------------------
  const fgBuildingCount = 76;
  const buildingStep = width / fgBuildingCount;

  for (let i = 0; i < fgBuildingCount; i += 1) {
    const bw = 46 + random() * 70;
    const bx = i * buildingStep + (random() - 0.5) * 28;
    // ビルの高さ: 下 1/3 (Y=680) 付近を中心とし、一部の超高層は Y=490 付近まで届く
    const bh = 240 + random() * 300;
    const by = height - bh;

    // ビルの濃紺シルエット本体
    const bColor = random() < 0.5 ? "#050917" : "#070e22";
    ctx.fillStyle = bColor;
    ctx.fillRect(bx, by, bw, bh);

    // ビル左端の微細なシアン/ブルーハイライト（立体感の強調）
    ctx.fillStyle = "rgba(100, 160, 230, 0.22)";
    ctx.fillRect(bx, by, 1.5, bh);

    // ビル窓明かり（格子状）
    const colSpacing = 7;
    const rowSpacing = 9;
    const cols = Math.floor((bw - 8) / colSpacing);
    const rows = Math.floor((bh - 20) / rowSpacing);

    // フロアごとの点灯傾向（オフィス特有のフロア単位での一斉点灯・残業パターン）
    for (let r = 0; r < rows; r += 1) {
      const isFloorActive = random() < 0.72;
      const floorLitChance = isFloorActive ? 0.65 : 0.15;
      const wy = by + 12 + r * rowSpacing;

      for (let c = 0; c < cols; c += 1) {
        const isWindowLit = random() < floorLitChance;
        if (isWindowLit) {
          const wx = bx + 5 + c * colSpacing;
          const colorRoll = random();
          // オフィス白（蛍光灯）60%、暖色（白熱灯）33%、青白LED 7%
          let winColor = "rgba(220, 238, 255, 0.88)";
          if (colorRoll < 0.33) {
            winColor = "rgba(255, 222, 140, 0.88)";
          } else if (colorRoll < 0.4) {
            winColor = "rgba(255, 185, 95, 0.82)";
          } else if (colorRoll > 0.93) {
            winColor = "rgba(140, 215, 255, 0.9)";
          }

          ctx.fillStyle = winColor;
          ctx.fillRect(wx, wy, 3.8, 4.2);
        }
      }
    }

    // 屋上構造物と赤色航空障害灯
    const hasAntenna = random() < 0.45;
    if (hasAntenna) {
      const antX = bx + bw * (0.3 + random() * 0.4);
      const antH = 14 + random() * 22;
      ctx.strokeStyle = "#405070";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(antX, by);
      ctx.lineTo(antX, by - antH);
      ctx.stroke();

      // 航空障害灯
      ctx.fillStyle = "#ff2828";
      ctx.beginPath();
      ctx.arc(antX, by - antH, 2.2, 0, Math.PI * 2);
      ctx.fill();

      // 赤色グロー
      const bGlow = ctx.createRadialGradient(
        antX,
        by - antH,
        0,
        antX,
        by - antH,
        7
      );
      bGlow.addColorStop(0.0, "rgba(255, 40, 40, 0.8)");
      bGlow.addColorStop(1.0, "rgba(255, 30, 30, 0)");
      ctx.fillStyle = bGlow;
      ctx.beginPath();
      ctx.arc(antX, by - antH, 7, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // 屋上角の航空障害灯
      const hasCornerBeacon = random() < 0.55;
      if (hasCornerBeacon) {
        const beaconX = bx + (random() < 0.5 ? 4 : bw - 4);
        ctx.fillStyle = "#ff3030";
        ctx.fillRect(beaconX - 1.5, by - 2, 3, 3);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 8. 高速道路の光の帯（ビル群の足元を流れる車のライト）
  // ---------------------------------------------------------------------------
  const drawHighway = (
    baseY: number,
    colorHeadlight: string,
    colorTaillight: string
  ) => {
    ctx.save();
    // 下り線: ヘッドライト（白〜暖白の連なり）
    ctx.beginPath();
    ctx.moveTo(0, baseY);
    ctx.bezierCurveTo(
      width * 0.25,
      baseY - 18,
      width * 0.65,
      baseY + 24,
      width,
      baseY - 8
    );
    ctx.strokeStyle = colorHeadlight;
    ctx.lineWidth = 4.5;
    ctx.shadowColor = colorHeadlight;
    ctx.shadowBlur = 10;
    ctx.stroke();

    // 上り線: テールランプ（鮮やかな赤の連なり）
    ctx.beginPath();
    ctx.moveTo(0, baseY + 9);
    ctx.bezierCurveTo(
      width * 0.25,
      baseY - 9,
      width * 0.65,
      baseY + 33,
      width,
      baseY + 1
    );
    ctx.strokeStyle = colorTaillight;
    ctx.lineWidth = 4;
    ctx.shadowColor = colorTaillight;
    ctx.shadowBlur = 12;
    ctx.stroke();
    ctx.restore();

    // 車両の明暗ドット（光の粒による交通流の表現）
    const carCount = 140;
    for (let i = 0; i < carCount; i += 1) {
      const t = random();
      const cx = t * width;
      // 3次ベジェ曲線上の Y 座標補間
      const u = 1 - t;
      const cy1 =
        u * u * u * baseY +
        3 * u * u * t * (baseY - 18) +
        3 * u * t * t * (baseY + 24) +
        t * t * t * (baseY - 8);
      const isHeadlight = random() < 0.52;
      const carY = isHeadlight ? cy1 : cy1 + 9;
      const carCol = isHeadlight
        ? "rgba(255, 255, 230, 0.95)"
        : "rgba(255, 45, 45, 0.95)";
      ctx.fillStyle = carCol;
      ctx.fillRect(cx, carY - 1.5, 3.5, 3);
    }
  };

  // 高架 1（主要高速道路）
  drawHighway(
    height * 0.9,
    "rgba(255, 245, 210, 0.75)",
    "rgba(255, 40, 40, 0.85)"
  );
  // 高架 2（手前の別ルート）
  drawHighway(
    height * 0.94,
    "rgba(240, 250, 255, 0.7)",
    "rgba(255, 30, 30, 0.8)"
  );

  return toNewsTexture(canvas);
};

// =============================================================================
// 2. デスク正面の番組ロゴパネル (createProgramLogo)
// =============================================================================

/**
 * デスク正面の番組ロゴ発光パネルテクスチャ（1200x320）を生成する。
 *
 * 【用途】
 * キャスターデスクの正面に備え付けられた横長発光パネル（1.2m x 0.32m、UV 0..1）。
 * 濃紺の地に白い太字の「NEWS」と、青白く光る「R」、および「ROULETTE NEWS」を描く。
 *
 * 【UV の向き】
 * - u: 水平方向 0..1（左 0・右 1）
 * - v: 垂直方向 0..1（下 0・上 1）
 *
 * 【どう実現しているか】
 * 1. 背景: 深海のようなリッチな放射グラデーション（濃紺〜ミッドナイトブルー）と
 *    上下のエッジに走るシアンの光沢ベベルライン。
 * 2. 背後モチーフ: 薄い同心円グリッドとルーレットのホイールアーク。
 * 3. 「NEWS」: 純白の極太サンセリフに青白いソフトグロー。
 * 4. 「R」: 鮮やかなシアン〜スカイブルーのグラデーション、ルーレットの環状セクターを
 *    取り入れた発光サークルモチーフ、強力な発光ネオングロー。
 * 5. サブタイトル: 「ROULETTE NEWS」の文字間隔を広げた端正なレイアウト。
 *
 * 【なぜ他の方法を採らなかったか】
 * 実在の局や番組の商標・ロゴを模倣せず、架空の競馬×ニュース番組「NEWS R」として
 * 洗練された報道デザインとスピード感（ルーレット・レース）を両立するため、
 * 幾何学パスと Canvas テキストを組み合わせた独自グラフィックを構築する。
 */
export const createProgramLogo = (): THREE.CanvasTexture => {
  const width = 1200;
  const height = 320;
  const { canvas, ctx } = makeCanvas(width, height);

  // ---------------------------------------------------------------------------
  // 1. 濃紺の地（グラデーションと光沢フレーム）
  // ---------------------------------------------------------------------------
  const bgGrad = ctx.createRadialGradient(
    width * 0.5,
    height * 0.5,
    50,
    width * 0.5,
    height * 0.5,
    width * 0.6
  );
  bgGrad.addColorStop(0.0, "#081b40");
  bgGrad.addColorStop(0.5, "#04112c");
  bgGrad.addColorStop(1.0, "#010714");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // 上下および四隅のシアン光沢ライン
  const borderGrad = ctx.createLinearGradient(0, 0, width, 0);
  borderGrad.addColorStop(0.0, "rgba(0, 180, 216, 0.1)");
  borderGrad.addColorStop(0.2, "rgba(0, 210, 255, 0.7)");
  borderGrad.addColorStop(0.5, "rgba(220, 245, 255, 0.95)");
  borderGrad.addColorStop(0.8, "rgba(0, 210, 255, 0.7)");
  borderGrad.addColorStop(1.0, "rgba(0, 180, 216, 0.1)");

  ctx.fillStyle = borderGrad;
  ctx.fillRect(0, 0, width, 3);
  ctx.fillRect(0, height - 3, width, 3);

  // 薄いグリッド・ドット背景（ニュースグラフィックスらしさ）
  ctx.fillStyle = "rgba(0, 180, 255, 0.05)";
  const dotStep = 24;
  for (let x = 30; x < width - 30; x += dotStep) {
    for (let y = 18; y < height - 18; y += dotStep) {
      ctx.fillRect(x, y, 1.8, 1.8);
    }
  }

  // ---------------------------------------------------------------------------
  // 2. 「NEWS」ロゴ（白・太字）と「R」ロゴ（青白発光・ルーレットモチーフ）
  // ---------------------------------------------------------------------------
  ctx.save();
  ctx.font = `900 118px ${SYSTEM_FONT_FAMILY}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  const newsText = "NEWS";
  const rText = "R";
  const newsMetrics = ctx.measureText(newsText);
  // R は少し大きめの 160px
  ctx.font = `900 160px ${SYSTEM_FONT_FAMILY}`;
  const rMetrics = ctx.measureText(rText);

  const letterGap = 32;
  const totalLogoWidth = newsMetrics.width + letterGap + rMetrics.width;
  const startX = (width - totalLogoWidth) * 0.5 - 10;
  const logoCenterY = height * 0.44;

  // 「NEWS」描画
  ctx.font = `900 118px ${SYSTEM_FONT_FAMILY}`;
  ctx.shadowColor = "rgba(0, 190, 255, 0.45)";
  ctx.shadowBlur = 18;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(newsText, startX, logoCenterY);
  ctx.restore();

  // ---------------------------------------------------------------------------
  // 3. 「R」ロゴ（青白く発光、ルーレット・ゴールモチーフ）
  // ---------------------------------------------------------------------------
  const rX = startX + newsMetrics.width + letterGap;
  const rY = logoCenterY;

  ctx.save();
  // ルーレットの環状モチーフ（Rの頭部ループを包む同心円アーク）
  const loopCenterX = rX + rMetrics.width * 0.48;
  const loopCenterY = rY - 24;
  const wheelRadius = 82;

  // 外周リング
  ctx.beginPath();
  ctx.arc(loopCenterX, loopCenterY, wheelRadius, -Math.PI * 0.7, Math.PI * 0.6);
  ctx.strokeStyle = "rgba(0, 210, 255, 0.55)";
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // 目盛り（ルーレットの数字ポケット / レースのゴール板セクター）
  const tickCount = 12;
  for (let i = 0; i < tickCount; i += 1) {
    const angle = -Math.PI * 0.65 + (i / tickCount) * (Math.PI * 1.15);
    const innerR = wheelRadius - 7;
    const outerR = wheelRadius + 7;
    const tx1 = loopCenterX + Math.cos(angle) * innerR;
    const ty1 = loopCenterY + Math.sin(angle) * innerR;
    const tx2 = loopCenterX + Math.cos(angle) * outerR;
    const ty2 = loopCenterY + Math.sin(angle) * outerR;
    ctx.beginPath();
    ctx.moveTo(tx1, ty1);
    ctx.lineTo(tx2, ty2);
    ctx.strokeStyle = "rgba(180, 240, 255, 0.75)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // 「R」文字本体（極太・青白グラデーション）
  ctx.font = `900 160px ${SYSTEM_FONT_FAMILY}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  const rGrad = ctx.createLinearGradient(rX, rY - 70, rX + rMetrics.width, rY + 70);
  rGrad.addColorStop(0.0, "#ffffff");
  rGrad.addColorStop(0.3, "#a6eeff");
  rGrad.addColorStop(0.7, "#00b4d8");
  rGrad.addColorStop(1.0, "#0077b6");

  ctx.shadowColor = "rgba(0, 212, 255, 0.85)";
  ctx.shadowBlur = 28;
  ctx.fillStyle = rGrad;
  ctx.fillText(rText, rX, rY);
  ctx.restore();

  // ---------------------------------------------------------------------------
  // 4. サブタイトル「ROULETTE NEWS」と装飾ライン
  // ---------------------------------------------------------------------------
  ctx.save();
  ctx.font = `700 22px ${SYSTEM_FONT_FAMILY}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.fillStyle = "#a2dff7";

  const subText = "R O U L E T T E   N E W S";
  const subY = height * 0.78;
  ctx.shadowColor = "rgba(0, 180, 255, 0.5)";
  ctx.shadowBlur = 8;
  ctx.fillText(subText, width * 0.5, subY);

  // サブタイトルの両脇を飾る水平グラデーションライン
  const leftLineGrad = ctx.createLinearGradient(
    width * 0.15,
    subY,
    width * 0.32,
    subY
  );
  leftLineGrad.addColorStop(0.0, "rgba(0, 180, 255, 0)");
  leftLineGrad.addColorStop(1.0, "rgba(0, 210, 255, 0.8)");
  ctx.strokeStyle = leftLineGrad;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(width * 0.15, subY);
  ctx.lineTo(width * 0.32, subY);
  ctx.stroke();

  const rightLineGrad = ctx.createLinearGradient(
    width * 0.68,
    subY,
    width * 0.85,
    subY
  );
  rightLineGrad.addColorStop(0.0, "rgba(0, 210, 255, 0.8)");
  rightLineGrad.addColorStop(1.0, "rgba(0, 180, 255, 0)");
  ctx.strokeStyle = rightLineGrad;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.moveTo(width * 0.68, subY);
  ctx.lineTo(width * 0.85, subY);
  ctx.stroke();
  ctx.restore();

  return toNewsTexture(canvas);
};

// =============================================================================
// 3. 大型 LED ビジョン待機中背景 (createVideoWallBackground)
// =============================================================================

/**
 * スタジオ背面の大型 LED ビジョン（16:9、幅 4.8m）用待機中背景テクスチャ（1920x1080）を生成する。
 *
 * 【用途】
 * キャスターの背後に広がるメイン LED ビジョンの待機映像。
 * 中央〜左の広い範囲にはシーン側で文字テロップや写真、中継映像がオーバーレイされるため、
 * その視認性を妨げないよう模様は極めて控えめかつ上品に配置する。
 *
 * 【UV の向き】
 * - u: 水平方向 0..1（左 0・右 1）
 * - v: 垂直方向 0..1（下 0・上 1）
 *
 * 【どう実現しているか】
 * 1. 背景: 深いコバルトブルーからミッドナイトネイビーへの奥行きある放射グラデーション。
 * 2. 光のリボン: 右側・上部へとゆるやかに流れる 3 本の細い光条（ベジェ曲線＋グロー）。
 * 3. HUD 風幾何学装飾: 60px 間隔の極薄グリッド、右上の同心円レーダーリング、微小な十字マーカー。
 * 4. 右下の番組ロゴ: 「NEWS R」を右下に上品なサイズで配置。
 *
 * 【なぜ他の方法を採らなかったか】
 * 派手すぎるエフェクトや高コントラストなグラフィックを中央に配置すると、
 * 番組本編で上に重ねられるテロップや画像が読みにくくなってしまうため、
 * 報道スタジオの背景ディスプレイの原則に則り、中央部をクリーンな濃紺に保つ。
 */
export const createVideoWallBackground = (): THREE.CanvasTexture => {
  const width = 1920;
  const height = 1080;
  const { canvas, ctx } = makeCanvas(width, height);

  // ---------------------------------------------------------------------------
  // 1. 深い青〜濃紺のグラデーション
  // ---------------------------------------------------------------------------
  const bgGrad = ctx.createRadialGradient(
    width * 0.58,
    height * 0.42,
    100,
    width * 0.5,
    height * 0.5,
    width * 0.72
  );
  bgGrad.addColorStop(0.0, "#08214a");
  bgGrad.addColorStop(0.45, "#041434");
  bgGrad.addColorStop(0.8, "#02091c");
  bgGrad.addColorStop(1.0, "#010512");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // ---------------------------------------------------------------------------
  // 2. 薄い格子（HUD 風グリッド）
  // ---------------------------------------------------------------------------
  ctx.save();
  ctx.strokeStyle = "rgba(0, 180, 255, 0.035)";
  ctx.lineWidth = 1;
  const gridStep = 64;

  ctx.beginPath();
  for (let x = 0; x <= width; x += gridStep) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
  }
  for (let y = 0; y <= height; y += gridStep) {
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();

  // 十字マーカー（控えめな位置合わせ記号）
  const markers = [
    { x: 384, y: 256 },
    { x: 768, y: 512 },
    { x: 1408, y: 320 },
    { x: 1536, y: 704 },
  ];
  ctx.strokeStyle = "rgba(0, 210, 255, 0.12)";
  ctx.lineWidth = 1.2;
  for (const m of markers) {
    ctx.beginPath();
    ctx.moveTo(m.x - 7, m.y);
    ctx.lineTo(m.x + 7, m.y);
    ctx.moveTo(m.x, m.y - 7);
    ctx.lineTo(m.x, m.y + 7);
    ctx.stroke();
  }
  ctx.restore();

  // ---------------------------------------------------------------------------
  // 3. 同心円レーダー・サークルリング（右上寄り、控えめな装飾）
  // ---------------------------------------------------------------------------
  ctx.save();
  const circleCenterX = width * 0.82;
  const circleCenterY = height * 0.32;
  const radii = [140, 260, 380];

  for (let i = 0; i < radii.length; i += 1) {
    const r = radii[i];
    ctx.beginPath();
    ctx.arc(circleCenterX, circleCenterY, r, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0, 190, 255, 0.045)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  // 破線アーク
  ctx.beginPath();
  ctx.arc(
    circleCenterX,
    circleCenterY,
    320,
    -Math.PI * 0.3,
    Math.PI * 0.4
  );
  ctx.setLineDash([8, 12]);
  ctx.strokeStyle = "rgba(0, 210, 255, 0.08)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();

  // ---------------------------------------------------------------------------
  // 4. 光の帯（ゆるやかに曲がった細いリボン）
  // ---------------------------------------------------------------------------
  const drawRibbon = (
    startX: number,
    startY: number,
    cp1X: number,
    cp1Y: number,
    cp2X: number,
    cp2Y: number,
    endX: number,
    endY: number,
    color: string,
    widthPx: number
  ) => {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.bezierCurveTo(cp1X, cp1Y, cp2X, cp2Y, endX, endY);
    ctx.strokeStyle = color;
    ctx.lineWidth = widthPx;
    ctx.shadowColor = color;
    ctx.shadowBlur = 16;
    ctx.stroke();
    ctx.restore();
  };

  // リボン 1（右下から中央上へと伸びるシアンのライン）
  drawRibbon(
    width * 0.1,
    height * 0.82,
    width * 0.45,
    height * 0.72,
    width * 0.65,
    height * 0.28,
    width * 0.95,
    height * 0.15,
    "rgba(0, 190, 255, 0.45)",
    2.5
  );

  // リボン 2（リボン 1 に寄り添う淡いブルーの細ライン）
  drawRibbon(
    width * 0.15,
    height * 0.88,
    width * 0.48,
    height * 0.76,
    width * 0.7,
    height * 0.35,
    width,
    height * 0.24,
    "rgba(100, 220, 255, 0.3)",
    1.8
  );

  // リボン 3（上部をかすめる淡い光）
  drawRibbon(
    0,
    height * 0.32,
    width * 0.35,
    height * 0.18,
    width * 0.75,
    height * 0.55,
    width,
    height * 0.48,
    "rgba(0, 150, 255, 0.22)",
    3.0
  );

  // ---------------------------------------------------------------------------
  // 5. 右下の番組ロゴ「NEWS R」
  // ---------------------------------------------------------------------------
  ctx.save();
  const logoY = height - 88;

  ctx.font = `900 40px ${SYSTEM_FONT_FAMILY}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  const newsText = "NEWS";
  const rText = "R";
  const newsM = ctx.measureText(newsText);
  const rM = ctx.measureText(rText);
  const gap = 10;
  const logoTotalW = newsM.width + gap + rM.width;
  const logoX = width - logoTotalW - 60;

  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = "rgba(0, 190, 255, 0.4)";
  ctx.shadowBlur = 10;
  ctx.fillText(newsText, logoX, logoY);

  const rX = logoX + newsM.width + gap;
  const rGrad = ctx.createLinearGradient(rX, logoY - 18, rX + rM.width, logoY + 18);
  rGrad.addColorStop(0.0, "#ffffff");
  rGrad.addColorStop(1.0, "#00b4d8");
  ctx.fillStyle = rGrad;
  ctx.fillText(rText, rX, logoY);

  // 下の細いアンダーライン
  ctx.strokeStyle = "rgba(0, 200, 255, 0.5)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(logoX, logoY + 28);
  ctx.lineTo(logoX + logoTotalW, logoY + 28);
  ctx.stroke();
  ctx.restore();

  return toNewsTexture(canvas);
};

// =============================================================================
// 4. 左右の縦長モニター背景 (createSideScreenBackground)
// =============================================================================

/**
 * スタジオ左右の縦長モニター（9:16、幅 1.1m）用背景テクスチャ（1080x1920）を生成する。
 *
 * 【用途】
 * キャスターデスクの左右脇に配置された縦型大型モニターの常時待機背景（1 枚で左右共用）。
 *
 * 【UV の向き】
 * - u: 水平方向 0..1（左 0・右 1）
 * - v: 垂直方向 0..1（下 0・上 1）
 *
 * 【どう実現しているか】
 * 1. 縦グラデーション: 上下の濃紺から中央やや上部のコバルトブルーへの縦長グラデーション。
 * 2. 縦の光ライン: 画面を縦に走る数本のシアン発光ビーム（フェードアウト付き）。
 * 3. 縦ルーラー目盛り: 左右端に配置された精密なデータメーター風の刻み。
 * 4. 上部ロゴ: Y ≈ 280 付近にセンタリングされた「NEWS R」ロゴと光の水平バー。
 *
 * 【なぜ他の方法を採らなかったか】
 * 左右どちらのモニターに貼っても違和感がないよう、水平方向は対称的なレイアウトと
 * クリーンな縦ストライプデザインで統一している。
 */
export const createSideScreenBackground = (): THREE.CanvasTexture => {
  const width = 1080;
  const height = 1920;
  const { canvas, ctx } = makeCanvas(width, height);

  // ---------------------------------------------------------------------------
  // 1. 縦のグラデーション
  // ---------------------------------------------------------------------------
  const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
  bgGrad.addColorStop(0.0, "#010614");
  bgGrad.addColorStop(0.25, "#06183e");
  bgGrad.addColorStop(0.55, "#03102a");
  bgGrad.addColorStop(0.85, "#020a1c");
  bgGrad.addColorStop(1.0, "#01040f");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // ---------------------------------------------------------------------------
  // 2. 縦に流れる光のライン
  // ---------------------------------------------------------------------------
  const verticalBeams = [
    { x: width * 0.22, w: 2.0, alpha: 0.35, blur: 12 },
    { x: width * 0.38, w: 3.5, alpha: 0.55, blur: 18 },
    { x: width * 0.62, w: 3.5, alpha: 0.55, blur: 18 },
    { x: width * 0.78, w: 2.0, alpha: 0.35, blur: 12 },
  ];

  for (const beam of verticalBeams) {
    const beamGrad = ctx.createLinearGradient(0, 0, 0, height);
    beamGrad.addColorStop(0.0, "rgba(0, 180, 255, 0)");
    beamGrad.addColorStop(0.2, `rgba(0, 210, 255, ${beam.alpha * 0.7})`);
    beamGrad.addColorStop(0.5, `rgba(180, 240, 255, ${beam.alpha})`);
    beamGrad.addColorStop(0.8, `rgba(0, 190, 255, ${beam.alpha * 0.6})`);
    beamGrad.addColorStop(1.0, "rgba(0, 180, 255, 0)");

    ctx.save();
    ctx.fillStyle = beamGrad;
    ctx.shadowColor = "rgba(0, 200, 255, 0.6)";
    ctx.shadowBlur = beam.blur;
    ctx.fillRect(beam.x - beam.w * 0.5, 0, beam.w, height);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------
  // 3. 左右の縦ルーラー・目盛り線（HUD 風）
  // ---------------------------------------------------------------------------
  ctx.save();
  const drawRuler = (x: number, isLeft: boolean) => {
    ctx.strokeStyle = "rgba(0, 180, 255, 0.12)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x, 100);
    ctx.lineTo(x, height - 100);
    ctx.stroke();

    const tickStep = 28;
    for (let y = 140; y < height - 140; y += tickStep) {
      const isMajor = (y / tickStep) % 5 === 0;
      const tickLen = isMajor ? 14 : 7;
      const x2 = isLeft ? x + tickLen : x - tickLen;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x2, y);
      ctx.strokeStyle = isMajor
        ? "rgba(0, 220, 255, 0.3)"
        : "rgba(0, 180, 255, 0.12)";
      ctx.stroke();
    }
  };

  drawRuler(48, true);
  drawRuler(width - 48, false);
  ctx.restore();

  // ---------------------------------------------------------------------------
  // 4. 上部「NEWS R」ロゴ
  // ---------------------------------------------------------------------------
  ctx.save();
  const logoCenterY = 280;
  ctx.font = `900 60px ${SYSTEM_FONT_FAMILY}`;
  ctx.textBaseline = "middle";

  const newsText = "NEWS";
  const rText = "R";
  const newsMetrics = ctx.measureText(newsText);
  const rMetrics = ctx.measureText(rText);
  const letterGap = 16;
  const totalLogoWidth = newsMetrics.width + letterGap + rMetrics.width;
  const startX = (width - totalLogoWidth) * 0.5;

  // ロゴ背景のソフトな青白い光芒
  const logoBackdrop = ctx.createRadialGradient(
    width * 0.5,
    logoCenterY,
    10,
    width * 0.5,
    logoCenterY,
    180
  );
  logoBackdrop.addColorStop(0.0, "rgba(0, 160, 255, 0.25)");
  logoBackdrop.addColorStop(1.0, "rgba(0, 160, 255, 0)");
  ctx.fillStyle = logoBackdrop;
  ctx.beginPath();
  ctx.arc(width * 0.5, logoCenterY, 180, 0, Math.PI * 2);
  ctx.fill();

  // 「NEWS」
  ctx.textAlign = "left";
  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = "rgba(0, 190, 255, 0.6)";
  ctx.shadowBlur = 16;
  ctx.fillText(newsText, startX, logoCenterY);

  // 「R」
  const rX = startX + newsMetrics.width + letterGap;
  const rGrad = ctx.createLinearGradient(
    rX,
    logoCenterY - 30,
    rX + rMetrics.width,
    logoCenterY + 30
  );
  rGrad.addColorStop(0.0, "#ffffff");
  rGrad.addColorStop(0.5, "#00d4ff");
  rGrad.addColorStop(1.0, "#0077b6");
  ctx.fillStyle = rGrad;
  ctx.fillText(rText, rX, logoCenterY);

  // 水平セパレーターライン
  const sepGrad = ctx.createLinearGradient(
    width * 0.2,
    logoCenterY + 52,
    width * 0.8,
    logoCenterY + 52
  );
  sepGrad.addColorStop(0.0, "rgba(0, 180, 255, 0)");
  sepGrad.addColorStop(0.5, "rgba(0, 220, 255, 0.8)");
  sepGrad.addColorStop(1.0, "rgba(0, 180, 255, 0)");
  ctx.strokeStyle = sepGrad;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(width * 0.2, logoCenterY + 52);
  ctx.lineTo(width * 0.8, logoCenterY + 52);
  ctx.stroke();

  // 下部アクセントテキスト「ON AIR」
  ctx.textAlign = "center";
  ctx.font = `700 16px ${SYSTEM_FONT_FAMILY}`;
  ctx.fillStyle = "#8ecae6";
  ctx.fillText("LIVE BROADCAST FEED", width * 0.5, logoCenterY + 80);
  ctx.restore();

  return toNewsTexture(canvas);
};

// =============================================================================
// 5. 床の返しモニター放送画面 (createFloorMonitorScreen)
// =============================================================================

/**
 * 床の返しモニター（16:9）用放送画面サムネイルテクスチャ（640x360）を生成する。
 *
 * 【用途】
 * キャスターの足元に置かれた返しモニター（プロンプター・プレビュー用ディスプレイ）に表示する
 * 番組本番の縮小画面。
 *
 * 【UV の向き】
 * - u: 水平方向 0..1（左 0・右 1）
 * - v: 垂直方向 0..1（下 0・上 1）
 *
 * 【どう実現しているか】
 * 1. 放送画面フレーム: 暗めの青いスタジオ中継映像をベースとする。
 * 2. 上部ヘッダーバー: 左に「NEWS R」ロゴ、右に赤丸の「● LIVE」バッジと現在時刻「21:00」。
 * 3. 中央プレビュー枠: スタジオカメラ映像・レースハイライト枠（セーフエリアマーク付き）。
 * 4. 下部テロップ帯: 白と濃紺の 2 段報道テロップバー（「速報」「結果一覧」風の文字）。
 *
 * 【なぜ他の方法を採らなかったか】
 * 実際のテレビ局の返しモニターはスタジオの本線映像（PGM）がそのまま映るため、
 * 時刻表示・生放送バッジ・下部テロップを正確に再現することでリアルな現場感を演出する。
 */
export const createFloorMonitorScreen = (): THREE.CanvasTexture => {
  const width = 640;
  const height = 360;
  const { canvas, ctx } = makeCanvas(width, height);

  // ---------------------------------------------------------------------------
  // 1. 暗めの青い画面背景（スタジオ中継画面風）
  // ---------------------------------------------------------------------------
  const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
  bgGrad.addColorStop(0.0, "#051126");
  bgGrad.addColorStop(0.5, "#091e42");
  bgGrad.addColorStop(1.0, "#030a18");
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // ---------------------------------------------------------------------------
  // 2. 上部ヘッダー（番組ロゴ、時刻表示、LIVE バッジ）
  // ---------------------------------------------------------------------------
  // 上部半透明バー
  ctx.fillStyle = "rgba(2, 8, 22, 0.75)";
  ctx.fillRect(0, 0, width, 40);

  // 左上: 「NEWS R」
  ctx.save();
  ctx.font = `900 17px ${SYSTEM_FONT_FAMILY}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  const newsText = "NEWS";
  const rText = "R";
  const newsM = ctx.measureText(newsText);
  const gap = 5;
  const startX = 20;

  ctx.fillStyle = "#ffffff";
  ctx.fillText(newsText, startX, 20);
  ctx.fillStyle = "#00d4ff";
  ctx.fillText(rText, startX + newsM.width + gap, 20);
  ctx.restore();

  // 右上: 「LIVE」赤バッジ ＋ 時刻「21:00」
  ctx.save();
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";

  // 赤い LIVE バッジ
  const liveX = width - 110;
  ctx.fillStyle = "#e63946";
  ctx.beginPath();
  ctx.arc(liveX - 32, 20, 4.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.font = `800 13px ${SYSTEM_FONT_FAMILY}`;
  ctx.fillStyle = "#ffffff";
  ctx.fillText("LIVE", liveX, 20);

  // デジタル時刻「21:00」
  ctx.font = `800 16px ${SYSTEM_FONT_FAMILY}`;
  ctx.fillStyle = "#ffffff";
  ctx.fillText("21:00", width - 20, 20);
  ctx.restore();

  // ---------------------------------------------------------------------------
  // 3. 中央プレビューエリア（セーフエリアマークと映像枠）
  // ---------------------------------------------------------------------------
  ctx.save();
  // セーフエリアの L 字マーカー（放送用モニター特有のガイド）
  const marginX = 40;
  const marginY = 56;
  const markerLen = 16;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.28)";
  ctx.lineWidth = 1.5;

  // 左上
  ctx.beginPath();
  ctx.moveTo(marginX, marginY + markerLen);
  ctx.lineTo(marginX, marginY);
  ctx.lineTo(marginX + markerLen, marginY);
  ctx.stroke();

  // 右上
  ctx.beginPath();
  ctx.moveTo(width - marginX - markerLen, marginY);
  ctx.lineTo(width - marginX, marginY);
  ctx.lineTo(width - marginX, marginY + markerLen);
  ctx.stroke();

  // 左下
  ctx.beginPath();
  ctx.moveTo(marginX, height - marginY - markerLen);
  ctx.lineTo(marginX, height - marginY);
  ctx.lineTo(marginX + markerLen, height - marginY);
  ctx.stroke();

  // 右下
  ctx.beginPath();
  ctx.moveTo(width - marginX - markerLen, height - marginY);
  ctx.lineTo(width - marginX, height - marginY);
  ctx.lineTo(width - marginX, height - marginY - markerLen);
  ctx.stroke();

  // 中央のグラフィック（競馬中継の出走馬・オッズグラフ枠風の抽象表現）
  const boxW = 280;
  const boxH = 140;
  const boxX = (width - boxW) * 0.5;
  const boxY = (height - boxH) * 0.44;

  ctx.fillStyle = "rgba(10, 30, 65, 0.6)";
  ctx.fillRect(boxX, boxY, boxW, boxH);
  ctx.strokeStyle = "rgba(0, 180, 255, 0.4)";
  ctx.strokeRect(boxX, boxY, boxW, boxH);

  // 枠内グラフィックライン
  ctx.strokeStyle = "rgba(0, 210, 255, 0.35)";
  ctx.lineWidth = 1.2;
  for (let i = 1; i <= 3; i += 1) {
    const ly = boxY + (boxH / 4) * i;
    ctx.beginPath();
    ctx.moveTo(boxX + 10, ly);
    ctx.lineTo(boxX + boxW - 10, ly);
    ctx.stroke();
  }
  ctx.restore();

  // ---------------------------------------------------------------------------
  // 4. 下部テロップ帯（白いテロップの帯・速報ヘッドライン）
  // ---------------------------------------------------------------------------
  const telopY = height - 76;
  const telopH = 56;

  // 上段カテゴリタブ「速報」（金色バッジ）
  ctx.save();
  ctx.fillStyle = "#d4af37";
  ctx.fillRect(marginX, telopY - 18, 64, 18);
  ctx.font = `800 11px ${SYSTEM_FONT_FAMILY}`;
  ctx.fillStyle = "#030a18";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("速報", marginX + 32, telopY - 9);
  ctx.restore();

  // テロップベース帯（白〜淡いブルーの明るい帯）
  ctx.save();
  const telopGrad = ctx.createLinearGradient(
    marginX,
    telopY,
    width - marginX,
    telopY
  );
  telopGrad.addColorStop(0.0, "#ffffff");
  telopGrad.addColorStop(0.85, "#f0f6ff");
  telopGrad.addColorStop(1.0, "#d8e8ff");
  ctx.fillStyle = telopGrad;
  ctx.shadowColor = "rgba(0, 0, 0, 0.4)";
  ctx.shadowBlur = 8;
  ctx.fillRect(marginX, telopY, width - marginX * 2, telopH);

  // テロップ枠の左アクセントバー（青）
  ctx.fillStyle = "#0077b6";
  ctx.fillRect(marginX, telopY, 8, telopH);

  // テロップ本文（濃紺の明瞭なテキスト）
  ctx.font = `800 19px ${SYSTEM_FONT_FAMILY}`;
  ctx.fillStyle = "#081b3a";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("本日のメインレース確定 / 審議結果と払戻金詳細", marginX + 22, telopY + 28);
  ctx.restore();

  return toNewsTexture(canvas);
};
