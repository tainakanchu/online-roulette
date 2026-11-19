import * as THREE from "three";
import { DecalGeometry } from "three/examples/jsm/geometries/DecalGeometry.js";
import { extractAvatarPalette } from "../../../utils/avatarPalette";

// GitHub のアバターを馬に貼る。github.com/<login>.png はリダイレクトに CORS ヘッダーがなく WebGL で使えないので、
// avatars.githubusercontent.com を直接読む（crossOrigin なしだと canvas が汚れてレース動画の保存も壊れる）

const AVATAR_SIZE = 128;
const cache = new Map<string, Promise<HTMLImageElement>>();

export const loadGitHubAvatar = (login: string) => {
  const key = login.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;
  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`avatar not found: ${login}`));
    image.src = `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=${AVATAR_SIZE}`;
  });
  // 失敗したら次の setField で読み直せるように捨てる
  promise.catch(() => cache.delete(key));
  cache.set(key, promise);
  return promise;
};

/** 丸く切り抜いて白い縁をつけたアバター（ゼッケンにも同じ見た目で描く） */
export const drawAvatarBadge = (
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  cx: number,
  cy: number,
  radius: number
) => {
  const border = Math.max(2, radius * 0.1);
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(cx, cy, radius - border, 0, Math.PI * 2);
  ctx.clip();
  const inner = radius - border;
  ctx.drawImage(image, cx - inner, cy - inner, inner * 2, inner * 2);
  ctx.restore();
};

export const createAvatarBadgeTexture = (image: CanvasImageSource) => {
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas not available");
  drawAvatarBadge(ctx, image, AVATAR_SIZE / 2, AVATAR_SIZE / 2, AVATAR_SIZE / 2 - 1);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
};

export const createAvatarDecalMaterial = () =>
  new THREE.MeshStandardMaterial({
    transparent: true,
    alphaTest: 0.5,
    roughness: 0.6,
    polygonOffset: true,
    polygonOffsetFactor: -4,
  });

/**
 * target の表面に、法線 normal の向きから貼るデカールを作る。座標は target のローカル。
 * できたメッシュは target の子にするので、脚や騎手が動いても一緒に動く
 */
export const createAvatarDecal = (
  target: THREE.Mesh,
  point: THREE.Vector3,
  normal: THREE.Vector3,
  up: THREE.Vector3,
  size: number,
  material: THREE.Material
) => {
  target.updateWorldMatrix(true, false);
  const worldPoint = target.localToWorld(point.clone());
  const worldNormal = normal.clone().transformDirection(target.matrixWorld);
  const worldUp = up.clone().transformDirection(target.matrixWorld);
  const rotation = new THREE.Matrix4().lookAt(worldNormal, new THREE.Vector3(), worldUp);
  const orientation = new THREE.Euler().setFromRotationMatrix(rotation);
  const geometry = new DecalGeometry(target, worldPoint, orientation, new THREE.Vector3(size, size, size));
  geometry.applyMatrix4(target.matrixWorld.clone().invert());
  const decal = new THREE.Mesh(geometry, material);
  decal.receiveShadow = true;
  target.add(decal);
  return decal;
};

/** アイコンの目立つ 2 色（毛色に足す斑の色）。色の少ないアイコンは null */
export const extractAvatarColors = (image: CanvasImageSource): [THREE.Color, THREE.Color] | null => {
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, size, size);
  const palette = extractAvatarPalette(ctx.getImageData(0, 0, size, size).data);
  if (!palette) return null;
  const [a, b] = palette.map(({ r, g, b }) => new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace));
  return [a, b];
};
