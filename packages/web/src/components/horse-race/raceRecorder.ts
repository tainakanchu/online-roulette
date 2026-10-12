// レース映像を 2D キャンバスに合成して MediaRecorder で録画する（1080p・H.264 の MP4 を優先）

import { drawBlackout, drawNews, RECORDER_FONT, roundRect, type RecorderBlackout, type RecorderNews } from "./recorderNews";

export interface RecorderOverlay {
  /** 実況テキスト */
  commentary: string;
  /** 残り距離 / ゴール / カウントダウンなどの短い表示 */
  status: string;
  /** 現在の位置順 */
  order: Array<{ number: number; color: string }>;
  /** 確定後の上位着順 */
  result: { title: string; rows: Array<{ rank: string; number: number; color: string; name: string }> } | null;
  /** レース後のニュースの今のカット（ニュースの間だけ） */
  news: RecorderNews | null;
  /** 競馬場とスタジオの切り替えに挟む黒 */
  blackout: RecorderBlackout;
}

export interface RaceVideo {
  blob: Blob;
  extension: string;
}

// H.264 は 1080p・30fps を録れるレベル 4.0（avc1.xx0028）で、画質の良い High → Main → Baseline の順に試す。
// H.264 で録れないブラウザ（Firefox など）は WebM（VP9 / VP8）にする
const FORMATS = [
  { mimeType: "video/mp4;codecs=avc1.640028", extension: "mp4" },
  { mimeType: "video/mp4;codecs=avc1.4D0028", extension: "mp4" },
  { mimeType: "video/mp4;codecs=avc1.42E028", extension: "mp4" },
  { mimeType: "video/mp4;codecs=avc1", extension: "mp4" },
  { mimeType: "video/mp4", extension: "mp4" },
  { mimeType: "video/webm;codecs=vp9", extension: "webm" },
  { mimeType: "video/webm;codecs=vp8", extension: "webm" },
  { mimeType: "video/webm", extension: "webm" },
];

const FPS = 30;
/** 録画の大きさ（1080p）。実況・テロップの文字はこの大きさで描くので、画面が小さくても潰れない */
const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;
/** 1080p・30fps の H.264 で、文字と芝の細かい所が崩れないビットレート（YouTube の 1080p の推奨値と同じ） */
const VIDEO_BITS_PER_SECOND = 8_000_000;
/**
 * 画面を 16:9 に合わせるとき、上下（左右）を切り落としてよい割合の上限。
 * 16:10 のノート PC なら上下を 5% ずつ切って画面いっぱいに映し、これより多く切れる縦長・横長の画面は黒い帯を足して全体を収める
 */
const MAX_CROP = 0.15;
const FONT = RECORDER_FONT;

/** 画面の映像を録画の枠（16:9）のどこに描くか */
const fitSource = (sourceWidth: number, sourceHeight: number) => {
  const cover = Math.max(VIDEO_WIDTH / sourceWidth, VIDEO_HEIGHT / sourceHeight);
  const visible = Math.min(VIDEO_WIDTH / (sourceWidth * cover), VIDEO_HEIGHT / (sourceHeight * cover));
  const isCropSmall = 1 - visible <= MAX_CROP;
  const scale = isCropSmall ? cover : Math.min(VIDEO_WIDTH / sourceWidth, VIDEO_HEIGHT / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return { x: (VIDEO_WIDTH - width) / 2, y: (VIDEO_HEIGHT - height) / 2, width, height, isLetterboxed: !isCropSmall };
};

const pickFormat = () => {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return null;
  return FORMATS.find((f) => MediaRecorder.isTypeSupported(f.mimeType)) ?? null;
};

export const isRaceRecordingSupported = (): boolean =>
  typeof HTMLCanvasElement !== "undefined" &&
  typeof HTMLCanvasElement.prototype.captureStream === "function" &&
  pickFormat() !== null;

export class RaceRecorder {
  overlay: RecorderOverlay = {
    commentary: "",
    status: "",
    order: [],
    result: null,
    news: null,
    blackout: { kind: "none", since: 0 },
  };
  private readonly canvas = document.createElement("canvas");
  private readonly ctx = this.canvas.getContext("2d");
  private readonly format = pickFormat();
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private lastFrameAt = -Infinity;
  private stopped = false;

  /** シーンの描画直後に呼ぶ（preserveDrawingBuffer なしでも読める） */
  captureFrame(source: HTMLCanvasElement) {
    if (this.stopped || !this.ctx || !this.format || source.width === 0) return;
    const now = performance.now();
    if (now - this.lastFrameAt < 1000 / FPS - 2) return;
    this.lastFrameAt = now;
    if (!this.recorder) this.begin();
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    const fit = fitSource(source.width, source.height);
    if (fit.isLetterboxed) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, width, height);
    }
    // 拡大・縮小で輪郭が崩れないよう、高品質の補間で描く
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, fit.x, fit.y, fit.width, fit.height);
    this.drawOverlay(width, height);
    if (this.overlay.news) drawNews(ctx, this.overlay.news, width, height, now);
    drawBlackout(ctx, this.overlay.blackout, width, height, now);
  }

  /** 録画を止めて動画を返す（1 フレームも撮れていなければ null） */
  stop(): Promise<RaceVideo | null> {
    this.stopped = true;
    const recorder = this.recorder;
    const format = this.format;
    if (!recorder || !format || recorder.state === "inactive") {
      this.release();
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: recorder.mimeType || format.mimeType });
        this.chunks = [];
        this.release();
        resolve(blob.size > 0 ? { blob, extension: format.extension } : null);
      };
      recorder.stop();
    });
  }

  /** 結果を捨てて破棄する */
  dispose() {
    this.stopped = true;
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      this.recorder.onstop = null;
      if (this.recorder.state !== "inactive") this.recorder.stop();
    }
    this.chunks = [];
    this.release();
  }

  private begin() {
    this.canvas.width = VIDEO_WIDTH;
    this.canvas.height = VIDEO_HEIGHT;
    this.stream = this.canvas.captureStream(FPS);
    this.recorder = new MediaRecorder(this.stream, {
      mimeType: this.format?.mimeType,
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
    });
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) this.chunks.push(event.data);
    };
    this.recorder.start(1000);
  }

  private release() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
  }

  private drawOverlay(width: number, height: number) {
    const ctx = this.ctx;
    if (!ctx) return;
    const u = height / 360;
    const pad = 8 * u;
    const { commentary, status, order, result } = this.overlay;
    ctx.save();
    ctx.textBaseline = "middle";

    // 位置順チップ
    const chip = 16 * u;
    order.forEach((horse, i) => {
      const x = pad + i * (chip + 3 * u);
      if (x + chip > width - pad) return;
      ctx.fillStyle = horse.color;
      roundRect(ctx, x, pad, chip, chip, 4 * u);
      ctx.fill();
      if (i === 0) {
        ctx.strokeStyle = "#ffd23f";
        ctx.lineWidth = 2 * u;
        ctx.stroke();
      }
      this.text(String(horse.number), x + chip / 2, pad + chip / 2, 10 * u, "center");
    });

    // 残り距離・ゴール
    if (status) {
      ctx.font = `700 ${11 * u}px ${FONT}`;
      const w = ctx.measureText(status).width + 14 * u;
      const y = pad + chip + 5 * u;
      ctx.fillStyle = "rgba(10, 8, 25, 0.65)";
      ctx.fillRect(pad, y, w, 18 * u);
      ctx.fillStyle = "#ffd23f";
      ctx.fillRect(pad, y, 2.5 * u, 18 * u);
      this.text(status, pad + 8 * u, y + 9 * u, 11 * u, "left");
    }

    // 実況
    if (commentary) {
      const h = 24 * u;
      const y = height - pad - h;
      const gradient = ctx.createLinearGradient(pad, 0, width - pad, 0);
      gradient.addColorStop(0, "rgba(198, 40, 40, 0.92)");
      gradient.addColorStop(0.3, "rgba(10, 8, 25, 0.8)");
      gradient.addColorStop(1, "rgba(10, 8, 25, 0.8)");
      ctx.fillStyle = gradient;
      roundRect(ctx, pad, y, width - pad * 2, h, 6 * u);
      ctx.fill();
      this.text(`🎙 ${commentary}`, pad + 10 * u, y + h / 2, 12 * u, "left", width - pad * 2 - 20 * u);
    }

    // 着順確定
    if (result) {
      const rowH = 22 * u;
      const boxW = Math.min(width - pad * 4, 260 * u);
      const boxH = 30 * u + rowH * result.rows.length;
      const x = (width - boxW) / 2;
      const y = (height - boxH) / 2 - 10 * u;
      ctx.fillStyle = "rgba(10, 8, 25, 0.82)";
      roundRect(ctx, x, y, boxW, boxH, 10 * u);
      ctx.fill();
      this.text(result.title, width / 2, y + 16 * u, 14 * u, "center", boxW, "#ffd23f");
      result.rows.forEach((row, i) => {
        const ry = y + 30 * u + rowH * i + rowH / 2;
        this.text(row.rank, x + 14 * u, ry, 12 * u, "left");
        ctx.fillStyle = row.color;
        roundRect(ctx, x + 52 * u, ry - 8 * u, 16 * u, 16 * u, 4 * u);
        ctx.fill();
        this.text(String(row.number), x + 60 * u, ry, 10 * u, "center");
        this.text(row.name, x + 76 * u, ry, 12 * u, "left", boxW - 90 * u);
      });
    }
    ctx.restore();
  }

  private text(
    value: string,
    x: number,
    y: number,
    size: number,
    align: CanvasTextAlign,
    maxWidth?: number,
    color = "#fff"
  ) {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.font = `700 ${size}px ${FONT}`;
    ctx.textAlign = align;
    ctx.shadowColor = "rgba(0, 0, 0, 0.6)";
    ctx.shadowBlur = size / 4;
    ctx.fillStyle = color;
    if (maxWidth === undefined) ctx.fillText(value, x, y);
    else ctx.fillText(value, x, y, maxWidth);
    ctx.shadowBlur = 0;
  }
}
