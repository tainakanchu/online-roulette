import * as THREE from "three";

// 競馬ゲームの夜のニュース番組スタジオ「NEWS R」用カンペ（スケッチブック）テクスチャ生成。
//
// 【用途】
// レース後に流すニュース番組のスタジオで、AD がスケッチブックで掲げるカンペ
// （日本のテレビの、キャスターに向けた手書きの進行指示・残り時間指示）。
// 番組の終わり際にカメラの手違い（blooper カット）で放送に映り込む演出で使用する。
// カンペのページメッシュ（幅 0.40m × 高さ 0.30m、UV は左下 (0,0)・右上 (1,1)、
// 前から見て文字が正しく読める向き）に貼られる。
// 画面の中ではページが画面の高さの 1 割ほどの大きさでしか映らないため、
// 遠目にも一瞬で読める極太で明瞭な文字サイズと高いコントラストを確保している。
//
// 【UV の向き】
// - u: 水平方向 0..1（左 0・右 1）
// - v: 垂直方向 0..1（下 0・上 1、Canvas 2D の Y 軸反転は Three.js の CanvasTexture 側で標準処理）
// 前から見て正対した状態で左上が上辺リング綴じ穴、中央に文字が読める配置。
//
// 【描画内容】
// 1. スケッチブックの白い画用紙質感:
//    ごく淡いクリーム色（マルマン図案スケッチブック等の用紙色）、紙の繊維のかすかな斑点・むら、
//    紙の端（特に左右および下端）のわずかな陰影・丸み。
// 2. 上辺のリング綴じ穴:
//    上辺に等間隔で並ぶツインワイヤリング綴じ穴（やや縦長の長円または角丸矩形、穴の抜きと奥の影、
//    紙のパンチ抜き跡の微細なフチ）。
// 3. 太い油性マーカー手書き風文字（lines: 1〜3 行）:
//    - 日本のテレビ現場で定番の黒極太油性フェルトペン（マッキー極太等）の勢いある筆致。
//    - 文字の色は漆黒に近い黒（#111111）。options.accent に指定された行は鮮やかな赤（#d01818）。
//    - 線の太さのむら、ストローク端の丸み、微細なにじみ（かすかなブラー・重ね描き）。
//    - AD が立ったまま素早く書いたような、わずかな右上がりの傾き（-0.5°〜-1.5° 程度）と
//      行ごとのわずかな配置の揺らぎ。
//    - 行数・文字長に応じた動的スケーリング（1 行時は紙の幅の約 8 割を占める大文字、
//      複数行時は均等かつ紙からはみ出さないバランス配置）。
// 4. AD の書き足し装飾（矢印・強調下線）:
//    - シード値に応じて決定的に 1〜2 個の書き足し記号（勢いのある下線や隅の矢印）を配置。
//      文字の可読性を最優先し、本文に重ならず余白を活かす。
//
// 外部画像や Web フォントは一切使用せず、システムフォント（Hiragino Sans / Noto Sans JP 等）の
// 極太ウェイトを下敷きにし、微小なずらし多重描画とストローク合成によって
// 完全に自己完結した決定論的 Canvas 描画を行う。

const SYSTEM_FONT_FAMILY =
  '"Hiragino Sans", "Noto Sans CJK JP", "Noto Sans JP", "Yu Gothic", "Meiryo", system-ui, -apple-system, sans-serif';

export interface CueCardOptions {
  accent?: number[];
}

/**
 * 2D Canvas 要素とそのコンテキストを初期化して返す。
 *
 * 【どう実現しているか】
 * document.createElement("canvas") で指定サイズのオフスクリーン Canvas を生成し、
 * 2D レンダリングコンテキストを取得する。
 *
 * 【なぜ他の方法を採らなかったか】
 * DOM 上に Canvas を配置する方式はメモリリークや不要な DOM ツリー汚染を招くため、
 * インメモリのオフスクリーン要素として完結させる。
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
 * 文字列から 32bit 整数のハッシュシードを生成する。
 *
 * 【どう実現しているか】
 * FNV-1a 類似の 32bit 乗算・XOR ループで文字列全体のハッシュを算出する。
 *
 * 【なぜ他の方法を採らなかったか】
 * lines と options の組み合わせごとに常に一意かつ安定した決定論的シード値を
 * 得るため。
 */
const hashStringToSeed = (str: string): number => {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

/**
 * シード値固定の決定的擬似乱数生成器（mulberry32）。
 *
 * 【どう実現しているか】
 * 32bit 整数演算を用いたビットシフトと乗算により、シード値から一意に決まる 0..1 の乱数を生成する。
 *
 * 【なぜ他の方法を採らなかったか】
 * Math.random() は実行時ごとに結果が変わり、紙の繊維むらや文字の微細な揺らぎが
 * 変化して視覚的再現性が損なわれるため。
 */
const createSeededRandom = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * スケッチブックの台紙（淡いクリーム色、紙の繊維、端の陰影）を描画する。
 */
const drawPaperBase = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  random: () => number
): void => {
  // 画用紙の地色（ごく淡いアイボリー / クリーム色）
  const baseGrad = ctx.createLinearGradient(0, 0, width, height);
  baseGrad.addColorStop(0, "#f9f7f0");
  baseGrad.addColorStop(0.5, "#faf8f2");
  baseGrad.addColorStop(1, "#f5f2e8");
  ctx.fillStyle = baseGrad;
  ctx.fillRect(0, 0, width, height);

  // 四隅およびエッジの微妙な陰影・擦れ
  const edgeGradV = ctx.createLinearGradient(0, 0, 0, height);
  edgeGradV.addColorStop(0, "rgba(50, 40, 30, 0.05)");
  edgeGradV.addColorStop(0.04, "rgba(50, 40, 30, 0.01)");
  edgeGradV.addColorStop(0.95, "rgba(50, 40, 30, 0.015)");
  edgeGradV.addColorStop(1, "rgba(50, 40, 30, 0.08)");
  ctx.fillStyle = edgeGradV;
  ctx.fillRect(0, 0, width, height);

  const edgeGradH = ctx.createLinearGradient(0, 0, width, 0);
  edgeGradH.addColorStop(0, "rgba(50, 40, 30, 0.06)");
  edgeGradH.addColorStop(0.03, "rgba(50, 40, 30, 0.0)");
  edgeGradH.addColorStop(0.97, "rgba(50, 40, 30, 0.0)");
  edgeGradH.addColorStop(1, "rgba(50, 40, 30, 0.06)");
  ctx.fillStyle = edgeGradH;
  ctx.fillRect(0, 0, width, height);

  // 画用紙の繊維・微細なテクスチャ感（決定論的な斑点と微小繊維）
  const fiberCount = 600;
  for (let i = 0; i < fiberCount; i += 1) {
    const fx = random() * width;
    const fy = random() * height;
    const length = 1.5 + random() * 4.5;
    const angle = random() * Math.PI;
    const isDark = random() > 0.4;
    const alpha = 0.02 + random() * 0.035;

    ctx.strokeStyle = isDark
      ? `rgba(90, 75, 55, ${alpha})`
      : `rgba(255, 255, 255, ${alpha * 1.5})`;
    ctx.lineWidth = 0.7 + random() * 0.8;
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(fx + Math.cos(angle) * length, fy + Math.sin(angle) * length);
    ctx.stroke();
  }

  // 紙の雲のような微細な明暗むら
  const cloudCount = 18;
  for (let i = 0; i < cloudCount; i += 1) {
    const cx = random() * width;
    const cy = random() * height;
    const cr = 60 + random() * 140;
    const cloudGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr);
    const isDarkCloud = random() > 0.5;
    if (isDarkCloud) {
      cloudGrad.addColorStop(0, "rgba(180, 160, 130, 0.025)");
      cloudGrad.addColorStop(1, "rgba(180, 160, 130, 0)");
    } else {
      cloudGrad.addColorStop(0, "rgba(255, 255, 255, 0.04)");
      cloudGrad.addColorStop(1, "rgba(255, 255, 255, 0)");
    }
    ctx.fillStyle = cloudGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, cr, 0, Math.PI * 2);
    ctx.fill();
  }
};

/**
 * 上辺のスケッチブックリング綴じ穴を描画する。
 *
 * 【どう実現しているか】
 * 上辺（y = 28px 付近）に等間隔で長円のパンチ穴を描画。
 * 穴の内部には穴の落ち影（ダークグレー）と背景の抜け感を表現し、
 * 穴のフチにはパンチ抜きの凹みハイライト・シャドウを施す。
 */
const drawRingHoles = (
  ctx: CanvasRenderingContext2D,
  width: number,
  random: () => number
): void => {
  const holeCount = 28;
  const startX = 42;
  const endX = width - 42;
  const stepX = (endX - startX) / (holeCount - 1);
  const holeY = 32;
  const holeRadiusX = 4.5;
  const holeRadiusY = 10;

  for (let i = 0; i < holeCount; i += 1) {
    const hx = startX + i * stepX + (random() - 0.5) * 0.4;
    const hy = holeY + (random() - 0.5) * 0.4;

    // パンチ穴の奥の影（スケッチブックの下のページや机の陰）
    ctx.fillStyle = "#2b2b2b";
    ctx.beginPath();
    ctx.ellipse(hx, hy, holeRadiusX, holeRadiusY, 0, 0, Math.PI * 2);
    ctx.fill();

    // 穴の内側上部の深い影
    const innerShadow = ctx.createLinearGradient(
      hx,
      hy - holeRadiusY,
      hx,
      hy + holeRadiusY
    );
    innerShadow.addColorStop(0, "rgba(10, 10, 10, 0.85)");
    innerShadow.addColorStop(0.5, "rgba(35, 35, 35, 0.4)");
    innerShadow.addColorStop(1, "rgba(60, 60, 60, 0.1)");
    ctx.fillStyle = innerShadow;
    ctx.beginPath();
    ctx.ellipse(hx, hy, holeRadiusX, holeRadiusY, 0, 0, Math.PI * 2);
    ctx.fill();

    // 穴の周囲のわずかな紙の押し切り・エッジ光
    ctx.strokeStyle = "rgba(255, 255, 255, 0.45)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(
      hx,
      hy + 1,
      holeRadiusX + 0.5,
      holeRadiusY + 0.5,
      0,
      Math.PI * 0.2,
      Math.PI * 0.8
    );
    ctx.stroke();

    ctx.strokeStyle = "rgba(70, 60, 50, 0.2)";
    ctx.beginPath();
    ctx.ellipse(
      hx,
      hy - 0.5,
      holeRadiusX + 0.5,
      holeRadiusY + 0.5,
      0,
      Math.PI * 1.2,
      Math.PI * 1.8
    );
    ctx.stroke();
  }
};

/**
 * 太い油性マーカー（フェルトペン）の手書き風テキストを描画する。
 *
 * 【どう実現しているか】
 * 1. システム太字フォント（900 / bold）をベースに設定。
 * 2. 油性マーカーのにじみと太さを出すため、丸みのある strokeText（lineWidth: 10〜16px）と
 *    fillText を複数回、ランダムな微小オフセット（0.3〜1.2px）で重ね描きする。
 * 3. インクの溜まり・カスレ感を出すため、ストローク接合部に round を指定し、
 *    主線の内側にわずかに濃度の異なるパスを重ねる。
 * 4. AD の走り書き特有の全体的な右上がり傾き（-0.5°〜-1.5°）をアフィン変換で付与。
 *
 * 【なぜ他の方法を採らなかったか】
 * 単純な fillText 1 回ではデジタルフォント特有の硬直した輪郭になり、
 * 手書きカンペの生々しい迫力が出ない。一方ベジェ曲線で一文字ずつグリフを手描きすると
 * 漢字の網羅性が失われるため、システム太字フォントの多重ストロークブレンドを採用した。
 */
const drawMarkerLine = (
  ctx: CanvasRenderingContext2D,
  text: string,
  centerX: number,
  centerY: number,
  fontSize: number,
  isAccent: boolean,
  random: () => number
): { textWidth: number; angle: number } => {
  ctx.save();

  // AD の走り書き特有のわずかな右上がり傾き（-0.015〜-0.035 rad ≒ -0.9°〜-2.0°）
  const tiltAngle = -0.012 - random() * 0.02;
  const lineOffsetX = (random() - 0.5) * 8;
  const lineOffsetY = (random() - 0.5) * 6;

  ctx.translate(centerX + lineOffsetX, centerY + lineOffsetY);
  ctx.rotate(tiltAngle);

  // フォント指定: 極太ゴシック
  ctx.font = `900 ${Math.round(fontSize)}px ${SYSTEM_FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const metrics = ctx.measureText(text);
  const textWidth = metrics.width;

  // カラー設定
  // 黒: 漆黒に近い #111111 だが、マーカーのインク溜まりと端の滲み
  // 赤: 指定の鮮明な赤 #d01818
  const baseColor = isAccent ? "#d01818" : "#111111";
  const edgeColor = isAccent ? "#c41515" : "#141414";
  const bleedColor = isAccent
    ? "rgba(208, 24, 24, 0.12)"
    : "rgba(20, 20, 20, 0.10)";

  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // 1. 周囲への微細なにじみ（紙の繊維へのインク染み出し）
  const bleedWidth = Math.max(6, fontSize * 0.045);
  ctx.strokeStyle = bleedColor;
  ctx.lineWidth = bleedWidth;
  ctx.strokeText(text, 0, 0);

  // 2. マーカーの太い輪郭ストローク（フェルトペンの太い筆跡と角の丸み）
  const strokeWidth = Math.max(4, fontSize * 0.032);
  ctx.strokeStyle = edgeColor;
  ctx.lineWidth = strokeWidth;
  ctx.strokeText(text, 0, 0);

  // 3. 微小なずらし重ね描き（手書きの線の揺らぎ・太さのむら）
  const jitterOffsets = [
    { x: -0.6, y: -0.4 },
    { x: 0.5, y: -0.5 },
    { x: -0.4, y: 0.5 },
    { x: 0.6, y: 0.4 },
  ];
  for (const j of jitterOffsets) {
    const jx = j.x * (fontSize * 0.006) + (random() - 0.5) * (fontSize * 0.005);
    const jy = j.y * (fontSize * 0.006) + (random() - 0.5) * (fontSize * 0.005);
    ctx.fillStyle = baseColor;
    ctx.fillText(text, jx, jy);
  }

  // 4. マーカー芯の中央の濃いインクの芯（コントラスト確保）
  ctx.fillStyle = baseColor;
  ctx.fillText(text, 0, 0);

  // 5. 輪郭の最終引き締め（文字の明瞭度・可読性を確保）
  ctx.strokeStyle = baseColor;
  ctx.lineWidth = strokeWidth * 0.6;
  ctx.strokeText(text, 0, 0);

  ctx.restore();

  return { textWidth, angle: tiltAngle };
};

/**
 * 余白に AD が書き足したような手書き記号（矢印・下線）を描画する。
 */
const drawAdAnnotations = (
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  firstLineInfo: { textWidth: number; y: number } | null,
  isSingleLine: boolean,
  hasAccent: boolean,
  random: () => number
): void => {
  // 決定的に記号の種類（下線 or 矢印）を 1〜2 個選ぶ
  const annotationCount = random() > 0.4 ? 2 : 1;
  const markerColor = hasAccent ? "#d01818" : "#111111";

  for (let a = 0; a < annotationCount; a += 1) {
    const isUnderline = a === 0 && firstLineInfo !== null && (isSingleLine || random() > 0.4);

    if (isUnderline && firstLineInfo) {
      // 本文の下に引いた勢いのある手書き下線
      ctx.save();
      const lineY = firstLineInfo.y + (isSingleLine ? 140 : 80) + (random() - 0.5) * 8;
      const lineWidthHalf = Math.min(
        width * 0.38,
        firstLineInfo.textWidth * 0.52
      );
      const startX = width / 2 - lineWidthHalf + (random() - 0.5) * 15;
      const endX = width / 2 + lineWidthHalf + (random() - 0.5) * 15;

      ctx.strokeStyle = markerColor;
      ctx.lineWidth = 9 + random() * 4;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      // 少し弓なりに曲がった勢いのあるストローク
      const midX = (startX + endX) / 2;
      const midY = lineY + 4 + random() * 6;

      ctx.beginPath();
      ctx.moveTo(startX, lineY);
      ctx.quadraticCurveTo(midX, midY, endX, lineY - 2);
      ctx.stroke();

      // 二度引きのわずかなにじみ
      ctx.strokeStyle = hasAccent
        ? "rgba(208, 24, 24, 0.3)"
        : "rgba(20, 20, 20, 0.25)";
      ctx.lineWidth = 14;
      ctx.beginPath();
      ctx.moveTo(startX, lineY);
      ctx.quadraticCurveTo(midX, midY, endX, lineY - 2);
      ctx.stroke();

      ctx.restore();
    } else {
      // 余白の隅（右下または左下）に素早く描き足された矢印（→）
      ctx.save();
      const isRightSide = random() > 0.3;
      const arrowBaseX = isRightSide
        ? width - 130 + (random() - 0.5) * 20
        : 90 + (random() - 0.5) * 20;
      const arrowBaseY = height - 90 + (random() - 0.5) * 20;

      ctx.strokeStyle = markerColor;
      ctx.fillStyle = markerColor;
      ctx.lineWidth = 8 + random() * 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      ctx.translate(arrowBaseX, arrowBaseY);
      const arrowRot = (random() - 0.5) * 0.3;
      ctx.rotate(arrowRot);

      // 矢印の主線
      ctx.beginPath();
      ctx.moveTo(-45, 0);
      ctx.lineTo(35, 0);
      // 矢じり
      ctx.lineTo(10, -18);
      ctx.moveTo(35, 0);
      ctx.lineTo(10, 18);
      ctx.stroke();

      ctx.restore();
    }
  }
};

/**
 * 番組スタジオの AD が掲げるスケッチブックカンペのテクスチャ（1024x768、4:3）を生成する。
 *
 * 【用途】
 * レース後に放映される夜のニュース番組スタジオ（NEWS R）で、AD がキャスターに向けて掲げる
 * 手書きスケッチブックのページ面（幅 0.40m × 高さ 0.30m、UV 0..1）に貼る。
 * スタジオカメラの手違い（blooper カット）で画面に映り込んだ際、遠目からでも
 * 一瞬で内容が読める太く大きなマーカー文字を描画する。
 *
 * 【UV の向き】
 * - u: 水平方向 0..1（左 0・右 1）
 * - v: 垂直方向 0..1（下 0・上 1）
 * 前から正対して見て文字が正しく読める向き。
 *
 * 【どう実現しているか】
 * 1. 1024x768 の Canvas に、淡いクリーム色の地色、紙繊維のノイズ、端のわずかなシャドウを描く。
 * 2. 上辺にスケッチブック特有のリング綴じ穴（パンチ穴と奥行き影）の列を描く。
 * 3. 渡された lines（1〜3 行）の文字数・行数から最適な文字サイズを動的に計算。
 *    1 行の場合は紙幅の約 8 割を占める大文字にする。
 * 4. システムフォントの太字をベースに、複数回のずらしストローク・インクのにじみ・右上がりの傾きを
 *    合成して油性マーカーの手書き感を表現する。
 * 5. 文字列全体から導出した決定論的シード（mulberry32）により、同一引数に対して完全同一の
 *    テクスチャ出力を保証する。
 *
 * 【なぜ他の方法を採らなかったか】
 * 静止画アセットを用意すると「あと〇秒」等の動的な残り時間カウントダウンやローカライズに対応できず、
 * Web フォントのロードを待つと画面遷移時のチラつきやネットワーク遅延による抜けが生じるため、
 * 完全インメモリの手続き型 Canvas 2D 描画を採用した。
 */
export const createCueCardTexture = (
  lines: string[],
  options?: CueCardOptions
): THREE.CanvasTexture => {
  const width = 1024;
  const height = 768;
  const { canvas, ctx } = makeCanvas(width, height);

  // 決定論的シード値の生成（行の内容とアクセント指定から導出）
  const accentKey = options?.accent ? options.accent.join(",") : "";
  const seedString = `${lines.join("\n")}_accent:${accentKey}`;
  const seed = hashStringToSeed(seedString);
  const random = createSeededRandom(seed);

  // 1. スケッチブック用紙の地色・繊維
  drawPaperBase(ctx, width, height, random);

  // 2. 上辺のリング綴じ穴
  drawRingHoles(ctx, width, random);

  // 3. テキストのレイアウト計算
  // 綴じ穴のある上部（y: 0..70）と余白を避けた描画可能領域
  const contentTop = 90;
  const contentBottom = height - 60;
  const contentHeight = contentBottom - contentTop;
  const contentWidth = width - 120; // 左右マージン各 60px

  const lineCount = Math.max(1, lines.length);
  const isSingleLine = lineCount === 1;

  // 各行の長さに応じたフォントサイズ決定
  // 1 行のときは紙の幅の約 8 割（1024 * 0.8 ≒ 820px）
  // 複数行のときは縦横に収まるよう自動調整
  ctx.save();
  ctx.font = `900 100px ${SYSTEM_FONT_FAMILY}`;

  let maxTextWidthAt100 = 100;
  for (const line of lines) {
    const w = ctx.measureText(line).width;
    if (w > maxTextWidthAt100) {
      maxTextWidthAt100 = w;
    }
  }
  ctx.restore();

  let targetFontSize: number;
  if (isSingleLine) {
    // 1 行時は紙の幅の約 80% を目指す
    const targetWidth = width * 0.8;
    const sizeByWidth = (targetWidth / maxTextWidthAt100) * 100;
    // 上下方向の最大制限（1 行時の迫力を保ちつつ上下に収める）
    targetFontSize = Math.min(230, Math.max(130, sizeByWidth));
  } else if (lineCount === 2) {
    const targetWidth = contentWidth * 0.92;
    const sizeByWidth = (targetWidth / maxTextWidthAt100) * 100;
    const sizeByHeight = (contentHeight / 2) * 0.75;
    targetFontSize = Math.min(150, Math.min(sizeByWidth, sizeByHeight));
  } else {
    // 3 行以上
    const targetWidth = contentWidth * 0.94;
    const sizeByWidth = (targetWidth / maxTextWidthAt100) * 100;
    const sizeByHeight = (contentHeight / lineCount) * 0.8;
    targetFontSize = Math.min(105, Math.min(sizeByWidth, sizeByHeight));
  }

  // 行の垂直位置の決定
  const lineSpacing = contentHeight / (lineCount + 1);
  const accentIndices = new Set(options?.accent ?? []);
  let firstLineInfo: { textWidth: number; y: number } | null = null;

  for (let i = 0; i < lineCount; i += 1) {
    const lineText = lines[i] ?? "";
    const isAccent = accentIndices.has(i);
    const centerY = contentTop + lineSpacing * (i + 1);

    // 行ごとにフォントサイズと位置に微細な手書きの揺らぎを付与
    const lineFontSize = targetFontSize * (0.97 + random() * 0.06);
    const { textWidth } = drawMarkerLine(
      ctx,
      lineText,
      width / 2,
      centerY,
      lineFontSize,
      isAccent,
      random
    );

    if (i === 0) {
      firstLineInfo = { textWidth, y: centerY };
    }
  }

  // 4. 余白の AD 書き足し装飾（下線や矢印）
  const hasAccent = (options?.accent ?? []).length > 0;
  drawAdAnnotations(
    ctx,
    width,
    height,
    firstLineInfo,
    isSingleLine,
    hasAccent,
    random
  );

  // 5. Three.js CanvasTexture 化
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;

  return texture;
};
