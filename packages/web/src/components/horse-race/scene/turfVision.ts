import * as THREE from "three";
import type { MarginLabels } from "../../../utils/raceResult";
import { createLedModuleDetail } from "./ledTextures";
import { createLedScreenMaterial, LED_MODULE_GLSL, ledModuleUniforms, type LedModules } from "./props";

// ターフビジョン（大型映像装置）。JRA の競馬場の表示を参考に 2 つの画面を切り替える。
// - 中継画面: 左に着順の枠（Ⅰ〜Ⅴ）と馬場・タイム、中央にレースの中継映像、右に縦書きの「実況」、下にレース名
// - 着順掲示板: 上位 5 頭の馬番と着差、タイム、馬場、確定（写真判定）のランプ
// 文字や枠は Canvas に描き、中継映像は別のカメラで描いた映像（RenderTarget）を LED の粒で表示する。

const FONT = `"Hiragino Sans", "Noto Sans JP", "Noto Sans TC", system-ui, sans-serif`;
/** 画面の大きさ（ワールド単位）と、それに合わせた Canvas の解像度（縦横比をそろえる） */
const SCREEN_WIDTH = 36;
const SCREEN_HEIGHT = 14;
const CANVAS_WIDTH = 1800;
const CANVAS_HEIGHT = 700;
/** 中継映像を出す枠（Canvas の座標） */
const VIDEO_RECT = { x: 432, y: 16, w: 1000, h: 562 };
/** LED の粒 1 個 = Canvas の 4×4 ピクセル */
const LED_PITCH = 4;
/** LED モジュール 1 枚の大きさ（ワールド単位。実物の 0.5〜1m 角に、競馬場の縮尺を合わせた大きさ） */
const MODULE_SIZE = 0.9;
const ROMAN = ["Ⅰ", "Ⅱ", "Ⅲ", "Ⅳ", "Ⅴ"];

export interface VisionLabels extends MarginLabels {
  /** 「第」「レース」のように、レース番号の前後に付ける言葉 */
  racePrefix: string;
  raceSuffix: string;
  time: string;
  going: string;
  official: string;
  photo: string;
  /** 写真判定の画面の見出し（「写真判定」） */
  photoFinish: string;
  /** 右の縦書きの欄（「ルーレット実況」など） */
  live: string;
}

export interface VisionInfo {
  raceNumber: number;
  /** 下の帯に出すレース名（格付けを含む） */
  title: string;
  /** 芝・ダート */
  surface: string;
  /** 良・稍重・重・不良 */
  going: string;
  labels: VisionLabels;
  entries: Array<{ number: number; color: string; name: string }>;
}

/** live: 中継 / photo: 写真判定（決勝写真を映す） / result: 着順掲示板 */
export type VisionMode = "live" | "photo" | "result";

/** 写真判定の画面で、決勝写真の上に付ける馬番の札（x は写真の横の位置 0..1） */
export interface PhotoMark {
  index: number;
  x: number;
}

export interface VisionState {
  mode: VisionMode;
  /** ゴールした順の馬 index（中継画面の着順の枠と、着順掲示板に出す） */
  placings: number[];
  /** placings[i] と placings[i + 1] の着差の表示（例: 「クビ」「1 1/2」） */
  margins: string[];
  /** 勝ち時計（例: 1:33.5）。ゴール前は空 */
  finalTime: string;
  /** 中継映像の左上の走破時計（例: 1.05）。レース前は空 */
  clock: string;
  /** 中継映像の下に出す現在の位置順（馬 index） */
  liveOrder: number[];
  photo: boolean;
  confirmed: boolean;
}

const emptyState = (): VisionState => ({
  mode: "live",
  placings: [],
  margins: [],
  finalTime: "",
  clock: "",
  liveOrder: [],
  photo: false,
  confirmed: false,
});

const VIDEO_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const VIDEO_FRAGMENT = /* glsl */ `
  uniform sampler2D uVideo;
  uniform sampler2D uOverlay;
  uniform vec2 uLedCount;
  /** 中継映像の枠が画面のどこにあるか（画面の UV の左下と大きさ）。モジュールの継ぎ目を画面とそろえる */
  uniform vec4 uScreenRect;
  ${LED_MODULE_GLSL}
  varying vec2 vUv;
  void main() {
    // 中継映像の上に、時計や位置順の文字（透明な Canvas）を重ねる
    vec3 color = texture2D(uVideo, vUv).rgb;
    vec4 overlay = texture2D(uOverlay, vUv);
    color = mix(color, overlay.rgb, overlay.a);
    // LED の粒。近くでは丸い発光点の並びに見え、遠くでは平均の明るさへ寄せてモアレを出さない
    vec2 led = vUv * uLedCount;
    float dotMask = 1.0 - smoothstep(0.32, 0.45, length(fract(led) - 0.5));
    float far = clamp(length(fwidth(led)) * 1.2, 0.0, 1.0);
    color *= mix(dotMask * 2.0, 1.0, far);
    color = applyLedModules(color, uScreenRect.xy + vUv * uScreenRect.zw);
    gl_FragColor = vec4(color * 1.1, 1.0);
    #include <colorspace_fragment>
  }
`;

const makeCanvas = (width: number, height: number) => {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas not available");
  return { canvas, ctx };
};

const canvasTexture = (canvas: HTMLCanvasElement) => {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
};

/** 縦書き。長音記号は縦書き用に 90° 回して描く */
const drawVertical = (ctx: CanvasRenderingContext2D, text: string, x: number, top: number, bottom: number, size: number) => {
  const chars = [...text];
  const step = Math.min(size * 1.12, (bottom - top) / Math.max(1, chars.length));
  const fontSize = Math.min(size, step / 1.05);
  ctx.font = `bold ${fontSize}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const start = (top + bottom) / 2 - (step * (chars.length - 1)) / 2;
  chars.forEach((char, i) => {
    const y = start + i * step;
    if (char === "ー" || char === "－" || char === "-") {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.PI / 2);
      ctx.fillText(char, 0, 0);
      ctx.restore();
    } else {
      ctx.fillText(char, x, y);
    }
  });
};

const roundRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
};

export class TurfVision {
  readonly group = new THREE.Group();
  /** 中継映像を撮るカメラ（動かすのはシーン側） */
  readonly camera = new THREE.PerspectiveCamera(16, VIDEO_RECT.w / VIDEO_RECT.h, 0.5, 1500);
  private readonly panel = makeCanvas(CANVAS_WIDTH, CANVAS_HEIGHT);
  private readonly panelTexture: THREE.CanvasTexture;
  private readonly overlay = makeCanvas(1024, 576);
  private readonly overlayTexture: THREE.CanvasTexture;
  private readonly videoTarget = new THREE.WebGLRenderTarget(640, 360, { type: THREE.HalfFloatType, samples: 2 });
  private readonly videoMesh: THREE.Mesh;
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private info: VisionInfo | null = null;
  private state: VisionState = emptyState();
  private panelDirty = true;
  private overlayDirty = true;
  /** 写真判定の画面に映す決勝写真と、馬番の札・判定線の位置 */
  private photoTexture: THREE.Texture | null = null;
  private photoMarks: PhotoMark[] = [];
  private judgeX = 0;
  private readonly videoMaterial: THREE.ShaderMaterial;

  constructor() {
    this.panelTexture = this.track(canvasTexture(this.panel.canvas));
    this.overlayTexture = this.track(canvasTexture(this.overlay.canvas));
    const moduleDetail = this.track(createLedModuleDetail());
    const modules: LedModules = {
      texture: moduleDetail.texture,
      count: new THREE.Vector2(SCREEN_WIDTH / MODULE_SIZE, SCREEN_HEIGHT / MODULE_SIZE),
      perTile: moduleDetail.modulesPerTile,
    };
    const screen = new THREE.Mesh(
      this.track(new THREE.PlaneGeometry(SCREEN_WIDTH, SCREEN_HEIGHT)),
      this.track(
        createLedScreenMaterial(
          this.panelTexture,
          new THREE.Vector2(CANVAS_WIDTH / LED_PITCH, CANVAS_HEIGHT / LED_PITCH),
          modules
        )
      )
    );
    this.group.add(screen);

    // 中継映像は画面の枠の上に少しだけ浮かせて重ねる
    const videoWidth = (SCREEN_WIDTH * VIDEO_RECT.w) / CANVAS_WIDTH;
    const videoHeight = (SCREEN_HEIGHT * VIDEO_RECT.h) / CANVAS_HEIGHT;
    const videoMaterial = (this.videoMaterial = this.track(
      new THREE.ShaderMaterial({
        vertexShader: VIDEO_VERTEX,
        fragmentShader: VIDEO_FRAGMENT,
        uniforms: {
          uVideo: { value: this.videoTarget.texture },
          uOverlay: { value: this.overlayTexture },
          uLedCount: { value: new THREE.Vector2(VIDEO_RECT.w / LED_PITCH, VIDEO_RECT.h / LED_PITCH) },
          // Canvas の y は下向き、UV の v は上向き
          uScreenRect: {
            value: new THREE.Vector4(
              VIDEO_RECT.x / CANVAS_WIDTH,
              1 - (VIDEO_RECT.y + VIDEO_RECT.h) / CANVAS_HEIGHT,
              VIDEO_RECT.w / CANVAS_WIDTH,
              VIDEO_RECT.h / CANVAS_HEIGHT
            ),
          },
          ...ledModuleUniforms(modules),
        },
      })
    ));
    this.videoMesh = new THREE.Mesh(this.track(new THREE.PlaneGeometry(videoWidth, videoHeight)), videoMaterial);
    this.videoMesh.position.set(
      ((VIDEO_RECT.x + VIDEO_RECT.w / 2) / CANVAS_WIDTH - 0.5) * SCREEN_WIDTH,
      (0.5 - (VIDEO_RECT.y + VIDEO_RECT.h / 2) / CANVAS_HEIGHT) * SCREEN_HEIGHT,
      0.02
    );
    this.group.add(this.videoMesh);
    this.disposables.push(this.videoTarget);
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  setInfo(info: VisionInfo) {
    this.info = info;
    this.panelDirty = true;
    this.overlayDirty = true;
  }

  /** 表示の状態を差し替える。変わった所だけ描き直す */
  setState(next: Partial<VisionState>) {
    const prev = this.state;
    this.state = { ...prev, ...next };
    const s = this.state;
    if (
      s.mode !== prev.mode ||
      s.finalTime !== prev.finalTime ||
      s.photo !== prev.photo ||
      s.confirmed !== prev.confirmed ||
      s.placings.join() !== prev.placings.join() ||
      s.margins.join() !== prev.margins.join()
    ) {
      this.panelDirty = true;
    }
    if (s.clock !== prev.clock || s.liveOrder.join() !== prev.liveOrder.join() || s.mode !== prev.mode) {
      this.overlayDirty = true;
    }
    // 写真判定の間は、中継映像の枠に決勝写真を映す
    const showsPhoto = s.mode === "photo" && this.photoTexture !== null;
    this.videoMesh.visible = s.mode === "live" || showsPhoto;
    this.videoMaterial.uniforms.uVideo.value = showsPhoto ? this.photoTexture : this.videoTarget.texture;
  }

  /**
   * 写真判定の画面に映す決勝写真と、馬番の札・判定線の位置。札は後ろの馬がゴールするたびに増える
   * @param judgeX 判定線（1 着の馬の鼻先）の写真の横の位置 0..1
   */
  setPhoto(texture: THREE.Texture, marks: PhotoMark[], judgeX: number) {
    const changed =
      texture !== this.photoTexture || judgeX !== this.judgeX || marks.map((m) => m.index).join() !== this.photoMarks.map((m) => m.index).join();
    this.photoTexture = texture;
    this.photoMarks = marks;
    this.judgeX = judgeX;
    if (changed) this.overlayDirty = true;
    this.setState({});
  }

  reset() {
    this.setState(emptyState());
  }

  /** 中継映像を出しているか（映像を描く必要があるか）。写真判定の間は決勝写真を映すので描かない */
  get showsVideo() {
    return this.videoMesh.visible && this.state.mode === "live";
  }

  /** シーンのカメラから中継映像の枠が見えているか */
  isVideoVisible(frustum: THREE.Frustum) {
    return this.showsVideo && frustum.intersectsObject(this.videoMesh);
  }

  /**
   * 中継映像を描く。映像の枠が自分自身に映り込むと描画先のテクスチャを読みながら書くことになるので、描く間は隠す。
   * 影はメインの描画で更新した影をそのまま使う（影の描画をもう 1 回しない）
   */
  renderVideo(renderer: THREE.WebGLRenderer, scene: THREE.Scene) {
    const shadowAuto = renderer.shadowMap.autoUpdate;
    const target = renderer.getRenderTarget();
    renderer.shadowMap.autoUpdate = false;
    this.videoMesh.visible = false;
    renderer.setRenderTarget(this.videoTarget);
    renderer.render(scene, this.camera);
    renderer.setRenderTarget(target);
    this.videoMesh.visible = true;
    renderer.shadowMap.autoUpdate = shadowAuto;
  }

  /** 変わった所の Canvas を描き直す（毎フレーム呼んでよい） */
  update() {
    if (this.panelDirty) {
      this.panelDirty = false;
      if (this.state.mode === "result") this.drawResult();
      else this.drawLive();
      this.panelTexture.needsUpdate = true;
    }
    if (this.overlayDirty) {
      this.overlayDirty = false;
      this.drawOverlay();
      this.overlayTexture.needsUpdate = true;
    }
  }

  private entry(index: number) {
    return this.info?.entries[index];
  }

  /**
   * 写真判定の画面: 決勝写真の上に、1 着の馬の鼻先の判定線と、ゴールした馬の馬番の札を重ねる。
   * 写真は先にゴールした馬ほど左に写り、馬は左を向いている（鼻先が札の位置）
   */
  private drawPhotoOverlay() {
    const { ctx, canvas } = this.overlay;
    const info = this.info;
    if (!info) return;
    // 判定線（鏡の帯も通して上から下まで）
    const lineX = this.judgeX * canvas.width;
    ctx.fillStyle = "rgba(255, 60, 40, 0.9)";
    ctx.fillRect(lineX - 1.5, 0, 3, canvas.height);
    // 馬番の札は下の帯（スタンド側から見た馬）の上端に並べる
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    this.photoMarks.forEach((mark, i) => {
      const e = this.entry(mark.index);
      if (!e) return;
      const x = mark.x * canvas.width + 18;
      const y = 200 + (i % 2) * 44;
      ctx.fillStyle = e.color;
      ctx.beginPath();
      ctx.arc(x, y, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(255,255,255,0.85)";
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.font = `bold 24px ${FONT}`;
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(0,0,0,0.6)";
      ctx.strokeText(String(e.number), x, y + 1);
      ctx.fillText(String(e.number), x, y + 1);
    });
    // 見出し
    ctx.font = `bold 40px ${FONT}`;
    ctx.textAlign = "left";
    const title = info.labels.photoFinish;
    const width = ctx.measureText(title).width + 36;
    ctx.fillStyle = "rgba(198, 40, 40, 0.92)";
    roundRect(ctx, 24, 24, width, 60, 10);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(title, 42, 55);
  }

  // ----- 中継画面 -----

  private drawLive() {
    const { ctx } = this.panel;
    const info = this.info;
    const s = this.state;
    ctx.fillStyle = "#07080b";
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    if (!info) return;

    // 左: レース番号・着順の枠・馬場・タイム
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffd23f";
    ctx.font = `bold 66px ${FONT}`;
    ctx.fillText(`${info.raceNumber}R`, 40, 66);
    ROMAN.forEach((roman, i) => {
      const y = 152 + i * 72;
      ctx.fillStyle = "#1e5fd6";
      ctx.beginPath();
      ctx.arc(62, y, 26, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = `bold 30px ${FONT}`;
      ctx.textAlign = "center";
      ctx.fillText(roman, 62, y + 1);
      ctx.fillStyle = "#1b1d22";
      ctx.fillRect(104, y - 31, 92, 62);
      const placed = s.placings[i];
      const e = placed !== undefined ? this.entry(placed) : undefined;
      if (e) {
        ctx.fillStyle = "#ffd23f";
        ctx.font = `bold ${e.number >= 10 ? 48 : 56}px ${FONT}`;
        ctx.fillText(String(e.number), 150, y + 2);
      }
      // 前の馬との着差
      const margin = i > 0 ? s.margins[i - 1] : undefined;
      if (margin && e) {
        ctx.fillStyle = "#ffd23f";
        ctx.font = `bold 34px ${FONT}`;
        ctx.textAlign = "left";
        ctx.fillText(margin, 214, y - 34, 190);
      }
    });
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold 34px ${FONT}`;
    ctx.fillText(info.surface, 40, 520);
    ctx.fillStyle = "#ffd23f";
    ctx.font = `bold 48px ${FONT}`;
    ctx.fillText(info.going, 150, 520, 250);
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold 34px ${FONT}`;
    ctx.fillText(info.labels.time, 40, 576);
    ctx.fillStyle = "#ffd23f";
    ctx.font = `bold 48px ${FONT}`;
    ctx.fillText(s.finalTime || "-.--.-", 168, 576, 240);

    // 中央: 中継映像の枠（映像そのものは別のメッシュで重ねる）
    ctx.fillStyle = "#11141a";
    ctx.fillRect(VIDEO_RECT.x, VIDEO_RECT.y, VIDEO_RECT.w, VIDEO_RECT.h);

    // 右: 縦書きの「実況」
    const right = { x: 1448, y: 16, w: 336, h: 568 };
    const green = ctx.createLinearGradient(0, right.y, 0, right.y + right.h);
    green.addColorStop(0, "#2c9a43");
    green.addColorStop(1, "#1f7a33");
    ctx.fillStyle = green;
    ctx.fillRect(right.x, right.y, right.w, right.h);
    ctx.fillStyle = "#ffffff";
    // 写真判定の間は、右の欄を赤くして縦書きで「写真判定」と出す
    if (s.mode === "photo") {
      ctx.fillStyle = "#c62828";
      ctx.fillRect(right.x, right.y, right.w, right.h);
      ctx.fillStyle = "#ffffff";
    }
    const rightLabel = s.mode === "photo" ? info.labels.photoFinish : info.labels.live;
    drawVertical(ctx, rightLabel, right.x + right.w / 2, right.y + 30, right.y + right.h - 30, 84);

    // 下: レース名の帯
    const band = ctx.createLinearGradient(0, 600, 0, 684);
    band.addColorStop(0, "#e3f1ff");
    band.addColorStop(1, "#9cc9f5");
    ctx.fillStyle = band;
    ctx.fillRect(16, 600, CANVAS_WIDTH - 32, 84);
    ctx.fillStyle = "#10264d";
    ctx.font = `bold 52px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillText(info.title, CANVAS_WIDTH / 2, 644, CANVAS_WIDTH - 120);
  }

  /** 中継映像に重ねる文字（走破時計・位置順・レース番号） */
  private drawOverlay() {
    const { ctx, canvas } = this.overlay;
    const s = this.state;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!this.info) return;
    if (s.mode === "photo") {
      this.drawPhotoOverlay();
      return;
    }
    ctx.textBaseline = "middle";
    if (s.clock) {
      ctx.font = `bold 52px ${FONT}`;
      ctx.textAlign = "left";
      ctx.lineWidth = 8;
      ctx.strokeStyle = "rgba(0,0,0,0.65)";
      ctx.strokeText(s.clock, 36, 58);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(s.clock, 36, 58);
    }
    if (s.liveOrder.length > 0) {
      const chip = 46;
      const gap = 6;
      const width = s.liveOrder.length * (chip + gap) + 40;
      const x0 = Math.max(24, (canvas.width - width) / 2 - 80);
      ctx.fillStyle = "rgba(10,12,20,0.72)";
      roundRect(ctx, x0, 500, width, 60, 12);
      ctx.fill();
      s.liveOrder.forEach((index, i) => {
        const e = this.entry(index);
        if (!e) return;
        const cx = x0 + 22 + i * (chip + gap) + chip / 2;
        ctx.fillStyle = e.color;
        ctx.beginPath();
        ctx.arc(cx, 530, chip / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.font = `bold ${e.number >= 10 ? 22 : 26}px ${FONT}`;
        ctx.textAlign = "center";
        ctx.lineWidth = 4;
        ctx.strokeStyle = "rgba(0,0,0,0.5)";
        ctx.strokeText(String(e.number), cx, 531);
        ctx.fillText(String(e.number), cx, 531);
      });
    }
    // 右下のレース番号
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 4;
    ctx.fillStyle = "rgba(10,12,20,0.6)";
    roundRect(ctx, canvas.width - 190, 494, 160, 64, 30);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold 32px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillText(`Race ${this.info.raceNumber}`, canvas.width - 110, 527);
  }

  // ----- 着順掲示板 -----

  private drawResult() {
    const { ctx } = this.panel;
    const info = this.info;
    const s = this.state;
    ctx.fillStyle = "#1c1b22";
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    if (!info) return;
    const label = "#ece6f2";
    const digit = "#f7a134";
    const box = "#2b2a31";
    ctx.textBaseline = "middle";

    // 見出し: 第 N レース
    ctx.textAlign = "left";
    ctx.fillStyle = label;
    ctx.font = `bold 54px ${FONT}`;
    ctx.fillText(info.labels.racePrefix, 60, 80);
    const prefixWidth = ctx.measureText(info.labels.racePrefix).width;
    ctx.fillStyle = box;
    ctx.fillRect(72 + prefixWidth, 38, 110, 84);
    ctx.fillStyle = digit;
    ctx.font = `bold 68px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillText(String(info.raceNumber), 127 + prefixWidth, 82);
    ctx.fillStyle = label;
    ctx.font = `bold 54px ${FONT}`;
    ctx.textAlign = "left";
    ctx.fillText(info.labels.raceSuffix, 196 + prefixWidth, 80);

    // 確定（写真判定）のランプ
    ctx.fillStyle = "#0e0e12";
    ctx.fillRect(60, 175, 200, 160);
    const lamp = s.confirmed ? info.labels.official : s.photo ? info.labels.photo : "";
    if (lamp) {
      ctx.fillStyle = s.confirmed ? "#ff4a3d" : "#ffb020";
      ctx.font = `bold 70px ${FONT}`;
      ctx.textAlign = "center";
      ctx.fillText(lamp, 160, 257, 180);
    }

    // 上位 5 頭と着差
    const slotX = (i: number) => 420 + i * 300;
    const marginX = (i: number) => (slotX(i) + slotX(i + 1)) / 2;
    ctx.strokeStyle = "#d9b8d0";
    ctx.lineWidth = 4;
    for (let i = 0; i < 4; i += 1) {
      if (s.placings[i + 1] === undefined) continue;
      ctx.beginPath();
      ctx.moveTo(slotX(i) + 40, 332);
      ctx.lineTo(marginX(i) - 70, 396);
      ctx.moveTo(slotX(i + 1) - 40, 332);
      ctx.lineTo(marginX(i) + 70, 396);
      ctx.stroke();
    }
    ROMAN.forEach((roman, i) => {
      const x = slotX(i);
      ctx.fillStyle = label;
      ctx.font = `bold 44px ${FONT}`;
      ctx.textAlign = "center";
      ctx.fillText(roman, x, 150);
      ctx.fillStyle = box;
      ctx.fillRect(x - 88, 180, 176, 150);
      const placed = s.placings[i];
      const e = placed !== undefined ? this.entry(placed) : undefined;
      if (e) {
        ctx.fillStyle = digit;
        ctx.font = `bold ${e.number >= 10 ? 104 : 124}px ${FONT}`;
        ctx.fillText(String(e.number), x, 258, 168);
      }
    });
    for (let i = 0; i < 4; i += 1) {
      const margin = s.margins[i];
      if (!margin || s.placings[i + 1] === undefined) continue;
      const x = marginX(i);
      ctx.fillStyle = box;
      ctx.fillRect(x - 110, 398, 220, 76);
      ctx.fillStyle = digit;
      ctx.font = `bold 50px ${FONT}`;
      ctx.textAlign = "center";
      ctx.fillText(margin, x, 438, 204);
    }

    // タイムと馬場
    ctx.textAlign = "left";
    ctx.fillStyle = label;
    ctx.font = `bold 54px ${FONT}`;
    ctx.fillText(info.labels.time, 60, 590);
    ctx.fillStyle = box;
    ctx.fillRect(270, 535, 380, 110);
    ctx.fillRect(710, 535, 400, 110);
    ctx.fillStyle = digit;
    ctx.font = `bold 84px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillText(s.finalTime, 460, 592, 360);
    ctx.fillStyle = label;
    ctx.font = `bold 54px ${FONT}`;
    ctx.textAlign = "right";
    ctx.fillText(info.labels.going, 1390, 590);
    ctx.fillStyle = box;
    ctx.fillRect(1420, 535, 300, 110);
    ctx.fillStyle = digit;
    ctx.font = `bold 84px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillText(info.going, 1570, 592, 280);
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }
}
