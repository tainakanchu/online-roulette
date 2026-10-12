// 録画に焼き込むレース後のニュースのテロップと、競馬場とスタジオの切り替えに挟む黒。
// 画面では NewsOverlay（DOM と CSS のアニメーション）で重ねているものを、同じ配置・同じ時間で 2D キャンバスに描く。
// 寸法は CSS と同じく、画面の幅・高さの 1%（cw / ch）を単位にする。
// Why not: DOM をそのまま画像にする方法（SVG の foreignObject や html2canvas）は 1 コマに数十ミリ秒かかり、30fps の録画に間に合わない

import type { NewsSegment } from "../../utils/raceNews";

export const RECORDER_FONT = `"Hiragino Sans", "Noto Sans JP", "Noto Sans TC", system-ui, sans-serif`;

/** 競馬場とスタジオの切り替えで黒を挟む時間（CSS の news-blackout と合わせる） */
export const BLACKOUT_MS = 650;

/** 録画に焼き込むニュースの今のカット（文字は訳した後のもの） */
export interface RecorderNews {
  /** このカットに切り替わった時刻（performance.now() の ms）。テロップの出方と締めの溶暗の時刻を決める */
  startedAt: number;
  /** カットの長さ（秒） */
  seconds: number;
  shot: NewsSegment["shot"];
  isClosing: boolean;
  corner: string;
  vtrMark: string;
  telop: string;
  caption: string;
  /** メインキャスターの寄りで右上に出す肩のパネル（ゴールの写真） */
  shoulder: HTMLImageElement | null;
  raceTitle: string;
  endCard: string;
}

/** 競馬場とスタジオの切り替えに挟む黒（in: 黒くなっていく / out: 黒から明けていく） */
export interface RecorderBlackout {
  kind: "none" | "in" | "out";
  /** kind が変わった時刻（performance.now() の ms） */
  since: number;
}

type Ctx = CanvasRenderingContext2D;

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const easeOut = (p: number) => 1 - (1 - p) ** 3;
const easeIn = (p: number) => p * p;
const font = (weight: number, size: number) => `${weight} ${size}px ${RECORDER_FONT}`;

export const roundRect = (ctx: Ctx, x: number, y: number, w: number, h: number, r: number) => {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
};

/** 幅 maxWidth で折り返す。英語は単語の途中で切らず、日本語は 1 文字ずつ折り返せる */
const wrapLines = (ctx: Ctx, text: string, maxWidth: number): string[] => {
  const tokens = text.match(/[A-Za-z0-9'’.,!?:;()-]+\s*|\s+|./gu) ?? [];
  const lines: string[] = [];
  let line = "";
  for (const token of tokens) {
    const next = line + token;
    const overflows = line.length > 0 && ctx.measureText(next.trimEnd()).width > maxWidth;
    if (!overflows) {
      line = next;
      continue;
    }
    lines.push(line.trimEnd());
    line = token.trimStart();
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines;
};

/** 左から右へ開く（CSS の newsWipe: clip-path inset(0 100% 0 0) → inset(0)）。開ききったら切り抜かない（影も出す） */
const withWipe = (ctx: Ctx, box: { x: number; y: number; w: number; h: number }, progress: number, draw: () => void) => {
  if (progress <= 0) return;
  ctx.save();
  if (progress < 1) {
    ctx.beginPath();
    ctx.rect(box.x, box.y - box.h, box.w * easeOut(progress), box.h * 3);
    ctx.clip();
  }
  draw();
  ctx.restore();
};

const setShadow = (ctx: Ctx, color: string, blur: number, offsetY = 0) => {
  ctx.shadowColor = color;
  ctx.shadowBlur = blur;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = offsetY;
};

const clearShadow = (ctx: Ctx) => setShadow(ctx, "transparent", 0);

const verticalGradient = (ctx: Ctx, y: number, h: number, top: string, bottom: string) => {
  const gradient = ctx.createLinearGradient(0, y, 0, y + h);
  gradient.addColorStop(0, top);
  gradient.addColorStop(1, bottom);
  return gradient;
};

const formatClock = (date: Date) =>
  `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

/** 「NEWS R」のロゴ（R だけ水色）を左端 x から書き、書いた幅を返す */
const drawLogo = (ctx: Ctx, x: number, y: number, size: number, weight: number) => {
  ctx.font = font(weight, size);
  ctx.textAlign = "left";
  const head = "NEWS ";
  const headWidth = ctx.measureText(head).width;
  ctx.fillStyle = "#fff";
  ctx.fillText(head, x, y);
  ctx.fillStyle = "#5fd0ff";
  ctx.fillText("R", x + headWidth, y);
  return headWidth + ctx.measureText("R").width;
};

const measureLogo = (ctx: Ctx, size: number, weight: number) => {
  ctx.font = font(weight, size);
  return ctx.measureText("NEWS R").width;
};

/** 左上の番組ロゴと時刻。右端の x を返す（VTR の印をその右に並べる） */
const drawBug = (ctx: Ctx, cw: number, ch: number, px: number) => {
  const size = 1.9 * cw;
  const padX = cw;
  const padY = 0.5 * ch;
  const w = measureLogo(ctx, size, 800) + padX * 2;
  const h = size * 1.2 + padY * 2;
  const x = 3 * cw;
  const y = 4 * ch;
  ctx.fillStyle = verticalGradient(ctx, y, h, "rgba(10, 30, 70, 0.85)", "rgba(4, 12, 32, 0.85)");
  roundRect(ctx, x, y, w, h, 4 * px);
  ctx.fill();
  ctx.strokeStyle = "rgba(140, 200, 255, 0.55)";
  ctx.lineWidth = px;
  ctx.stroke();
  setShadow(ctx, "rgba(0, 0, 0, 0.6)", 3 * px, px);
  drawLogo(ctx, x + padX, y + h / 2, size, 800);
  ctx.font = font(800, 2.4 * cw);
  ctx.fillStyle = "#fff";
  const clock = formatClock(new Date());
  ctx.fillText(clock, x + w + cw, y + h / 2);
  clearShadow(ctx);
  return x + w + cw + ctx.measureText(clock).width;
};

/** 番組の頭のタイトル（紺の札が中央から左右に開き、少しして消える。CSS の newsTitle 2.6 秒） */
const drawTitle = (ctx: Ctx, cw: number, ch: number, t: number) => {
  const p = t / 2.6;
  if (p >= 1) return;
  const size = 5 * cw;
  const w = measureLogo(ctx, size, 900) + 6 * cw;
  const h = size * 1.2 + 2.3 * ch;
  const x = 50 * cw - w / 2;
  const y = 76 * ch - h / 2;
  const open = p < 0.15 ? easeOut(p / 0.15) : 1;
  ctx.save();
  ctx.globalAlpha = p < 0.75 ? 1 : 1 - (p - 0.75) / 0.25;
  ctx.beginPath();
  ctx.rect(50 * cw - (w / 2) * open, y - h, w * open, h * 3);
  ctx.clip();
  setShadow(ctx, "rgba(95, 208, 255, 0.35)", 4 * cw);
  ctx.fillStyle = verticalGradient(ctx, y, h, "rgba(14, 34, 84, 0.96)", "rgba(4, 12, 34, 0.96)");
  ctx.fillRect(x, y, w, h);
  clearShadow(ctx);
  ctx.fillStyle = "#5fd0ff";
  ctx.fillRect(x, y + h - 0.5 * ch, w, 0.5 * ch);
  drawLogo(ctx, x + 3 * cw, y + ch + size * 0.6, size, 900);
  ctx.restore();
};

/** 右上のコーナー名（録画には全画面のボタンがないので、右端から 3cw） */
const drawCorner = (ctx: Ctx, text: string, cw: number, ch: number, px: number, width: number, t: number) => {
  const size = 2.2 * cw;
  ctx.font = font(800, size);
  const w = ctx.measureText(text).width + 3.2 * cw;
  const h = size * 1.2 + 1.2 * ch;
  const box = { x: width - 3 * cw - w, y: 4 * ch, w, h };
  withWipe(ctx, box, t / 0.45, () => {
    setShadow(ctx, "rgba(0, 0, 0, 0.35)", 1.2 * cw, 0.4 * ch);
    ctx.fillStyle = verticalGradient(ctx, box.y, h, "#2f80ed", "#1452b8");
    roundRect(ctx, box.x, box.y, w, h, 3 * px);
    ctx.fill();
    clearShadow(ctx);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "left";
    ctx.fillText(text, box.x + 1.6 * cw, box.y + h / 2);
  });
};

/** 時刻の右の「VTR」の印。left は時刻の右端（時刻の文字の幅はフォントで変わるので、決め打ちの位置にしない） */
const drawVtrMark = (ctx: Ctx, text: string, left: number, cw: number, ch: number, px: number) => {
  const size = 1.6 * cw;
  ctx.font = font(800, size);
  const w = ctx.measureText(text).width + 2 * cw;
  const h = size * 1.2 + 0.6 * ch;
  const x = left + 1.5 * cw;
  const y = 4 * ch + (1.9 * cw * 1.2 + ch - h) / 2;
  ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
  roundRect(ctx, x, y, w, h, 3 * px);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  ctx.lineWidth = 2 * px;
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.textAlign = "left";
  ctx.fillText(text, x + cw, y + h / 2);
};

/** メインキャスターの寄りの、右上の肩のパネル（ゴールの写真と、その下にレース名） */
const drawShoulder = (
  ctx: Ctx,
  image: HTMLImageElement,
  title: string,
  cw: number,
  ch: number,
  px: number,
  width: number,
  t: number
) => {
  const isLoaded = image.complete && image.naturalWidth > 0;
  if (!isLoaded) return;
  const w = 38 * cw;
  const imageH = (w * 9) / 16;
  const size = 1.9 * cw;
  const captionH = size * 1.2 + 1.2 * ch;
  const box = { x: width - 5 * cw - w, y: 13 * ch, w, h: imageH + captionH };
  withWipe(ctx, box, t / 0.5, () => {
    setShadow(ctx, "rgba(0, 0, 0, 0.45)", 3 * cw, ch);
    ctx.fillStyle = "#071530";
    ctx.fillRect(box.x, box.y, w, box.h);
    clearShadow(ctx);
    // object-fit: cover（写真の縦横比が 16:9 でなければ、はみ出す所を切る）
    const scale = Math.max(w / image.naturalWidth, imageH / image.naturalHeight);
    const sw = w / scale;
    const sh = imageH / scale;
    const sx = (image.naturalWidth - sw) / 2;
    const sy = (image.naturalHeight - sh) / 2;
    ctx.drawImage(image, sx, sy, sw, sh, box.x, box.y, w, imageH);
    ctx.font = font(800, size);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "left";
    ctx.fillText(title, box.x + cw, box.y + imageH + captionH / 2, w - 2 * cw);
    ctx.strokeStyle = "rgba(160, 210, 255, 0.85)";
    ctx.lineWidth = 2 * px;
    ctx.strokeRect(box.x, box.y, w, box.h);
  });
};

/** 下の大きなテロップ（白い文字に紺の帯、左に青い差し色） */
const drawTelop = (ctx: Ctx, text: string, cw: number, ch: number, px: number, height: number, t: number) => {
  const size = 3.6 * cw;
  const lineH = size * 1.25;
  const border = 0.9 * cw;
  const padLeft = 2 * cw;
  const padRight = 2.2 * cw;
  ctx.font = font(900, size);
  const lines = wrapLines(ctx, text, 92 * cw - border - padLeft - padRight);
  const textW = Math.max(...lines.map((line) => ctx.measureText(line).width));
  const w = border + padLeft + textW + padRight;
  const h = lines.length * lineH + 2.4 * ch;
  const box = { x: 4 * cw, y: height - 14 * ch - h, w, h };
  withWipe(ctx, box, t / 0.5, () => {
    setShadow(ctx, "rgba(0, 0, 0, 0.45)", 2 * cw, 0.6 * ch);
    ctx.fillStyle = verticalGradient(ctx, box.y, h, "rgba(18, 40, 96, 0.94)", "rgba(6, 16, 46, 0.94)");
    ctx.fillRect(box.x, box.y, w, h);
    clearShadow(ctx);
    ctx.fillStyle = "#2f9bff";
    ctx.fillRect(box.x, box.y, border, h);
    setShadow(ctx, "rgba(0, 0, 0, 0.5)", 2 * px, 2 * px);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "left";
    lines.forEach((line, i) => ctx.fillText(line, box.x + border + padLeft, box.y + 1.2 * ch + lineH * (i + 0.5)));
    clearShadow(ctx);
  });
};

/** 字幕（読み上げている原稿）。映像の明るい所でも読めるよう、黒い縁取り */
const drawCaption = (ctx: Ctx, text: string, cw: number, ch: number, height: number, alpha: number) => {
  if (alpha <= 0) return;
  const size = 2.3 * cw;
  const lineH = size * 1.4;
  ctx.font = font(700, size);
  const lines = wrapLines(ctx, text, 84 * cw);
  const top = height - 3 * ch - lines.length * lineH;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.textAlign = "center";
  ctx.lineJoin = "round";
  ctx.lineWidth = size * 0.16;
  ctx.strokeStyle = "#000";
  ctx.fillStyle = "#fff";
  lines.forEach((line, i) => {
    const y = top + lineH * (i + 0.5);
    ctx.strokeText(line, 50 * cw, y);
    ctx.fillText(line, 50 * cw, y);
  });
  ctx.restore();
};

/** 番組の終わりのエンドカード（お辞儀の後、2.8 秒から 0.6 秒で下から浮かび上がる。CSS の newsEndcard） */
const drawEndCard = (ctx: Ctx, text: string, cw: number, ch: number, t: number) => {
  const p = clamp01((t - 2.8) / 0.6);
  if (p <= 0) return;
  const logoSize = 6.5 * cw;
  const textSize = 2.4 * cw;
  ctx.font = font(700, textSize);
  const textW = ctx.measureText(text).width;
  const logoW = measureLogo(ctx, logoSize, 900);
  const w = Math.max(logoW, textW) + 10 * cw;
  const h = 2.4 * ch + logoSize * 1.2 + 1.2 * ch + textSize * 1.2 + 2.8 * ch;
  const x = 50 * cw - w / 2;
  const y = 74 * ch - h / 2 + h * 0.04 * (1 - easeOut(p));
  ctx.save();
  ctx.globalAlpha = easeOut(p);
  setShadow(ctx, "rgba(0, 0, 0, 0.5)", 4 * cw, ch);
  ctx.fillStyle = verticalGradient(ctx, y, h, "rgba(14, 34, 84, 0.94)", "rgba(4, 12, 34, 0.94)");
  ctx.fillRect(x, y, w, h);
  clearShadow(ctx);
  ctx.fillStyle = "#5fd0ff";
  ctx.fillRect(x, y, w, 0.4 * ch);
  ctx.fillRect(x, y + h - 0.4 * ch, w, 0.4 * ch);
  setShadow(ctx, "rgba(95, 208, 255, 0.55)", 3 * cw);
  drawLogo(ctx, 50 * cw - logoW / 2, y + 2.4 * ch + logoSize * 0.6, logoSize, 900);
  clearShadow(ctx);
  ctx.font = font(700, textSize);
  ctx.fillStyle = "#cfe3ff";
  ctx.textAlign = "center";
  ctx.fillText(text, 50 * cw, y + 2.4 * ch + logoSize * 1.2 + 1.2 * ch + textSize * 0.6);
  ctx.restore();
};

const fillBlack = (ctx: Ctx, width: number, height: number, alpha: number) => {
  if (alpha <= 0) return;
  ctx.save();
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
};

/** ニュースの今のカットのテロップ類を描く */
export const drawNews = (ctx: Ctx, news: RecorderNews, width: number, height: number, now = performance.now()) => {
  const cw = width / 100;
  const ch = height / 100;
  // CSS の px で書いた線の太さ・角の丸み（画面の幅 1000px を 1 とする）
  const px = width / 1000;
  const t = (now - news.startedAt) / 1000;
  const isOpening = news.shot === "opening";
  ctx.save();
  ctx.textBaseline = "middle";
  const bugRight = drawBug(ctx, cw, ch, px);
  if (isOpening) drawTitle(ctx, cw, ch, t);
  const showCorner = !isOpening && !news.isClosing && news.corner !== "";
  if (showCorner) drawCorner(ctx, news.corner, cw, ch, px, width, t);
  if (news.shot === "vtr") drawVtrMark(ctx, news.vtrMark, bugRight, cw, ch, px);
  if (news.shot === "mainSingle" && news.shoulder) {
    drawShoulder(ctx, news.shoulder, news.raceTitle, cw, ch, px, width, t);
  }
  if (news.telop) drawTelop(ctx, news.telop, cw, ch, px, height, t);
  if (news.caption) {
    // 締めの字幕は、お辞儀の後のエンドカードと入れ替わりに消す（2.1 秒から 0.4 秒）
    const fadeIn = clamp01(t / 0.4);
    const fadeOut = news.isClosing ? 1 - clamp01((t - 2.1) / 0.4) : 1;
    drawCaption(ctx, news.caption, cw, ch, height, Math.min(fadeIn, fadeOut));
  }
  if (news.isClosing) {
    drawEndCard(ctx, news.endCard, cw, ch, t);
    // 締めのカットの最後の 0.9 秒で黒に落とす
    fillBlack(ctx, width, height, easeIn(clamp01((t - (news.seconds - 0.9)) / 0.9)));
  }
  ctx.restore();
};

/** 競馬場とスタジオの切り替えに挟む黒 */
export const drawBlackout = (ctx: Ctx, blackout: RecorderBlackout, width: number, height: number, now = performance.now()) => {
  if (blackout.kind === "none") return;
  const p = clamp01((now - blackout.since) / BLACKOUT_MS);
  const alpha = blackout.kind === "in" ? easeIn(p) : 1 - easeOut(p);
  fillBlack(ctx, width, height, alpha);
};
