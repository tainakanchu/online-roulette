import * as THREE from "three";

// three.js 用のテクスチャを Canvas で手続き生成する（外部アセットなし）

const makeCanvas = (width: number, height: number) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas not available");
  return { canvas, ctx };
};

const toTexture = (canvas: HTMLCanvasElement, repeat?: [number, number]) => {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  if (repeat) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(repeat[0], repeat[1]);
  }
  return texture;
};

/** 芝（刈り込みの縞模様 + ノイズ） */
export const createTurfTexture = (
  base: string,
  stripe: string,
  repeat: [number, number],
  stripes = 2
) => {
  const size = 256;
  const { canvas, ctx } = makeCanvas(size, size);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = stripe;
  const w = size / (stripes * 2);
  for (let i = 0; i < stripes; i += 1) {
    ctx.fillRect(i * w * 2, 0, w, size);
  }
  // 芝目のノイズ
  for (let i = 0; i < 9000; i += 1) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const light = Math.random() < 0.5;
    ctx.fillStyle = light ? "rgba(255,255,220,0.07)" : "rgba(0,30,0,0.09)";
    ctx.fillRect(x, y, 1, 2 + Math.random() * 2);
  }
  return toTexture(canvas, repeat);
};

/** 遠景の地面（ややくすんだ芝） */
export const createGroundTexture = (repeat: [number, number]) =>
  createTurfTexture("#4f7a35", "#5a8740", repeat, 1);

/** ゼッケン（馬番 + 色） */
export const createNumberClothTexture = (num: number, color: string) => {
  const { canvas, ctx } = makeCanvas(128, 96);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 128, 96);
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.fillRect(30, 14, 68, 68);
  ctx.fillStyle = "#111";
  ctx.font = "bold 56px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(num), 64, 50);
  return toTexture(canvas);
};

/** 勝負服（ベース色 + 柄） */
export const createSilkTexture = (color: string, pattern: number, accent: string) => {
  const { canvas, ctx } = makeCanvas(128, 128);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = accent;
  switch (pattern % 5) {
    case 0: // 縦縞
      for (let x = 0; x < 128; x += 32) ctx.fillRect(x, 0, 14, 128);
      break;
    case 1: // 横縞
      for (let y = 0; y < 128; y += 32) ctx.fillRect(0, y, 128, 14);
      break;
    case 2: // 星
      for (let i = 0; i < 6; i += 1) {
        ctx.beginPath();
        ctx.arc(20 + (i % 3) * 44, 30 + Math.floor(i / 3) * 64, 10, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    case 3: // たすき
      ctx.save();
      ctx.translate(64, 64);
      ctx.rotate(Math.PI / 4);
      ctx.fillRect(-90, -14, 180, 28);
      ctx.restore();
      break;
    default: // 菱形
      for (let y = 0; y < 128; y += 42) {
        for (let x = 0; x < 128; x += 42) {
          ctx.beginPath();
          ctx.moveTo(x + 21, y);
          ctx.lineTo(x + 42, y + 21);
          ctx.lineTo(x + 21, y + 42);
          ctx.lineTo(x, y + 21);
          ctx.closePath();
          ctx.fill();
        }
      }
  }
  return toTexture(canvas);
};

/** 馬名ラベル（スプライト用） */
export const createNameLabelTexture = (num: number, name: string, color: string) => {
  const { canvas, ctx } = makeCanvas(512, 112);
  const label = name.length > 14 ? `${name.slice(0, 13)}…` : name;
  ctx.fillStyle = "rgba(10,8,25,0.72)";
  roundRect(ctx, 4, 8, 504, 96, 48);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(56, 56, 38, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = "bold 44px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(num), 56, 58);
  ctx.textAlign = "left";
  ctx.font = "bold 46px sans-serif";
  ctx.fillText(label, 108, 58, 390);
  return toTexture(canvas);
};

const roundRect = (
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
) => {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
};

/** 看板（文字入り） */
export const createSignTexture = (text: string, bg: string, fg: string) => {
  const { canvas, ctx } = makeCanvas(512, 96);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 512, 96);
  ctx.fillStyle = fg;
  ctx.font = "bold 54px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 256, 52, 480);
  return toTexture(canvas);
};

/** 柔らかい丸（パーティクル用） */
export const createSoftDotTexture = () => {
  const { canvas, ctx } = makeCanvas(64, 64);
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.4, "rgba(255,255,255,0.6)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return toTexture(canvas);
};

/** ターフビジョン（大型ビジョン）用キャンバス */
export const createVisionCanvas = () => {
  const { canvas, ctx } = makeCanvas(1024, 400);
  const texture = toTexture(canvas);
  return { canvas, ctx, texture };
};
