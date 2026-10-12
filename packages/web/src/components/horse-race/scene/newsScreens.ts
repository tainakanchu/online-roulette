import * as THREE from "three";
import type { NewsWall } from "../../../utils/raceNews";
import type { CueCardText } from "./newsCrew";

// ニューススタジオの画面に映すもの。背後の大型 LED ビジョンは番組のロゴ・ゴールの瞬間の写真・レース結果の表を切り替え、
// 左右の縦長モニターと床の返しモニターは番組の画面を映す。背景の絵柄（newsGraphicsTextures.ts）の上に文字と写真を重ねて描く。

const FONT = `"Hiragino Sans", "Noto Sans JP", "Noto Sans TC", system-ui, sans-serif`;
const WALL_WIDTH = 1920;
const WALL_HEIGHT = 1080;

export interface NewsResultRow {
  rank: string;
  number: number;
  color: string;
  name: string;
  /** 前の馬との着差（1 着は空） */
  margin: string;
}

export interface NewsWallInfo {
  /** ゴールの瞬間のフレーム */
  photo: HTMLCanvasElement | null;
  /** レース名（格付けを含む） */
  race: string;
  winner: string;
  /** 芝 1600m・良 など */
  course: string;
  /** 勝ち時計の表示（例: 勝ちタイム 1:33.5） */
  time: string;
  resultTitle: string;
  corner: string;
  rows: NewsResultRow[];
  /** 番組の残り時間（秒）から、AD のカンペに書くこと（翻訳済み）を決める */
  cueCard: (remainingSeconds: number) => CueCardText;
}

/** 背景の絵柄（agy が描いたテクスチャの画像） */
export interface NewsScreenArt {
  wall: CanvasImageSource;
  logo: CanvasImageSource;
  side: CanvasImageSource;
  floor: CanvasImageSource;
}

const createCanvas = (width: number, height: number) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas is not available");
  return { canvas, ctx };
};

const toTexture = (canvas: HTMLCanvasElement) => {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
};

/** 写真を枠いっぱいに切り抜いて描く（縦横比は保つ） */
const drawCover = (
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource & { width: number; height: number },
  x: number,
  y: number,
  width: number,
  height: number
) => {
  const scale = Math.max(width / image.width, height / image.height);
  const sw = width / scale;
  const sh = height / scale;
  ctx.drawImage(image, (image.width - sw) / 2, (image.height - sh) / 2, sw, sh, x, y, width, height);
};

/** 幅に収まるよう文字を縮める */
const fitText = (ctx: CanvasRenderingContext2D, text: string, size: number, maxWidth: number, weight = "bold") => {
  let font = size;
  ctx.font = `${weight} ${font}px ${FONT}`;
  while (ctx.measureText(text).width > maxWidth && font > 12) {
    font -= 2;
    ctx.font = `${weight} ${font}px ${FONT}`;
  }
  return font;
};

export class NewsScreens {
  readonly wall: THREE.CanvasTexture;
  readonly side: THREE.CanvasTexture;
  readonly floor: THREE.CanvasTexture;
  readonly logo: THREE.CanvasTexture;
  private readonly wallCtx: CanvasRenderingContext2D;
  private info: NewsWallInfo | null = null;
  private mode: NewsWall = "logo";

  constructor(private readonly art: NewsScreenArt) {
    const wall = createCanvas(WALL_WIDTH, WALL_HEIGHT);
    this.wallCtx = wall.ctx;
    this.wall = toTexture(wall.canvas);

    const side = createCanvas(540, 960);
    side.ctx.drawImage(art.side, 0, 0, 540, 960);
    this.side = toTexture(side.canvas);

    const floor = createCanvas(640, 360);
    floor.ctx.drawImage(art.floor, 0, 0, 640, 360);
    this.floor = toTexture(floor.canvas);

    const logo = createCanvas(1200, 320);
    logo.ctx.drawImage(art.logo, 0, 0, 1200, 320);
    this.logo = toTexture(logo.canvas);

    this.draw();
  }

  setInfo(info: NewsWallInfo) {
    this.info = info;
    this.draw();
  }

  setMode(mode: NewsWall) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.draw();
  }

  dispose() {
    this.wall.dispose();
    this.side.dispose();
    this.floor.dispose();
    this.logo.dispose();
  }

  private draw() {
    const ctx = this.wallCtx;
    ctx.drawImage(this.art.wall, 0, 0, WALL_WIDTH, WALL_HEIGHT);
    const info = this.info;
    if (this.mode === "photo" && info?.photo) this.drawPhoto(ctx, info, info.photo);
    else if (this.mode === "result" && info) this.drawResult(ctx, info);
    else this.drawLogo(ctx);
    this.wall.needsUpdate = true;
  }

  private drawLogo(ctx: CanvasRenderingContext2D) {
    // 番組ロゴを画面の中央に大きく
    const width = 1100;
    const height = (width * 320) / 1200;
    ctx.drawImage(this.art.logo, (WALL_WIDTH - width) / 2, (WALL_HEIGHT - height) / 2, width, height);
  }

  /**
   * ゴールの瞬間の写真を全面に、左上に小さくコーナー名とレース名。
   * ツーショットではビジョンの下半分がキャスターの頭の後ろに来るので、下には文字を置かない（頭に文字が重なって読めない）
   */
  private drawPhoto(ctx: CanvasRenderingContext2D, info: NewsWallInfo, photo: HTMLCanvasElement) {
    drawCover(ctx, photo, 0, 0, WALL_WIDTH, WALL_HEIGHT);
    const shade = ctx.createLinearGradient(0, 0, 0, WALL_HEIGHT * 0.35);
    shade.addColorStop(0, "rgba(4, 10, 28, 0.85)");
    shade.addColorStop(1, "rgba(4, 10, 28, 0)");
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, WALL_WIDTH, WALL_HEIGHT);

    // コーナーの見出し（青い帯に白い文字）とレース名
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#1565c0";
    ctx.fillRect(90, 70, 220, 64);
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    fitText(ctx, info.corner, 40, 190);
    ctx.fillText(info.corner, 200, 102);
    ctx.textAlign = "left";
    fitText(ctx, info.race, 54, WALL_WIDTH - 480);
    ctx.fillText(info.race, 340, 102);
  }

  /** レース結果の表（着順・馬番・馬名・着差）と勝ち時計 */
  private drawResult(ctx: CanvasRenderingContext2D, info: NewsWallInfo) {
    ctx.fillStyle = "rgba(3, 9, 26, 0.72)";
    ctx.fillRect(0, 0, WALL_WIDTH, WALL_HEIGHT);

    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = "#1565c0";
    ctx.fillRect(120, 96, 10, 96);
    ctx.fillStyle = "#ffffff";
    fitText(ctx, info.resultTitle, 76, 700);
    ctx.fillText(info.resultTitle, 160, 146);
    ctx.fillStyle = "#9fc4ff";
    fitText(ctx, info.race, 46, WALL_WIDTH - 1000, "600");
    ctx.textAlign = "right";
    ctx.fillText(info.race, WALL_WIDTH - 120, 146);

    const rows = info.rows.slice(0, 5);
    const top = 250;
    const rowHeight = 132;
    rows.forEach((row, k) => {
      const y = top + k * rowHeight;
      // 1 着の行は明るく
      ctx.fillStyle = k === 0 ? "rgba(255, 214, 102, 0.2)" : "rgba(255, 255, 255, 0.07)";
      ctx.fillRect(120, y, WALL_WIDTH - 240, rowHeight - 18);
      const mid = y + (rowHeight - 18) / 2;

      ctx.textAlign = "left";
      ctx.fillStyle = k === 0 ? "#ffd666" : "#ffffff";
      fitText(ctx, row.rank, 60, 200);
      ctx.fillText(row.rank, 160, mid);

      // 馬番の札（枠の色）
      ctx.fillStyle = row.color;
      ctx.fillRect(390, mid - 44, 88, 88);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
      ctx.lineWidth = 4;
      ctx.strokeRect(390, mid - 44, 88, 88);
      // 札の色が明るいと白い数字が読めないので、明るい札は黒い数字にする
      const isLightBadge = new THREE.Color(row.color).getHSL({ h: 0, s: 0, l: 0 }).l > 0.6;
      ctx.fillStyle = isLightBadge ? "#111111" : "#ffffff";
      ctx.textAlign = "center";
      ctx.font = `bold 56px ${FONT}`;
      ctx.fillText(String(row.number), 434, mid + 2);

      ctx.textAlign = "left";
      ctx.fillStyle = "#ffffff";
      fitText(ctx, row.name, 66, 1000);
      ctx.fillText(row.name, 530, mid);

      if (row.margin) {
        ctx.textAlign = "right";
        ctx.fillStyle = "#9fc4ff";
        fitText(ctx, row.margin, 52, 260, "600");
        ctx.fillText(row.margin, WALL_WIDTH - 160, mid);
      }
    });

    ctx.textAlign = "left";
    ctx.fillStyle = "#ffffff";
    // 時計とコースの間は全角の空き
    const footer = `${info.time}\u3000${info.course}`;
    fitText(ctx, footer, 50, WALL_WIDTH - 240, "600");
    ctx.fillText(footer, 120, WALL_HEIGHT - 90);
  }
}
