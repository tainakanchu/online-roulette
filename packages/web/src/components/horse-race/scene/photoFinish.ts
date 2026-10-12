import * as THREE from "three";

// 決勝写真（写真判定のカメラ）。JRA の決勝写真撮影カメラと同じ仕組みの写真を作る:
// ゴール線に合わせた幅 1 列のラインセンサーで、通過するものを時間を追って 1 列ずつ記録し、横に並べて 1 枚の写真にする。
// 写真の横軸は時間になり、先にゴール線に着いた馬ほど左に写る（馬は鼻先から順に写るので、左を向いて写る）。
// 止まっている背景は横に伸びた縞になる。ゴール板の鏡に映った反対側（内ラチ側）の姿は、内馬場側から撮って写真の上の帯に入れる。
//
// 画面は 1 秒に 60 回しか描けないので、ゴール線の 1 列だけを撮ると 1 フレームの間に進む時間の分が同じ列の繰り返しになり、
// 馬がブロック状に写る。そこで 1 フレームごとに、前に撮った時刻からの間に馬が進んだ幅の帯（ゴール線のすぐ先）を、
// 真横から平行投影で撮る。一定の速さで走る馬なら、ゴール線からの距離 = 速さ × (今 - ゴールを通った時刻) なので、
// 帯の横の位置がそのまま「いつゴール線を通ったか」になり、1 フレームで帯の幅の分の列をまとめて細かく作れる。

/** 写真の大きさ（ピクセル）。ターフビジョンの中継映像の枠と同じ 16:9 */
export const PHOTO_WIDTH = 1024;
export const PHOTO_HEIGHT = 576;
/** 下の帯（スタンド側から見た馬）と上の帯（鏡に映った内ラチ側）の高さ */
const MAIN_BAND = 400;
const MIRROR_BAND = 168;
const DIVIDER = PHOTO_HEIGHT - MAIN_BAND - MIRROR_BAND;
/** 1 フレームで撮る帯の横の解像度 */
const STRIP_WIDTH = 32;
/** 写真に写す高さの範囲（地面から、騎手の帽子の上まで） */
const VIEW_BOTTOM = -0.1;
const VIEW_TOP = 4.1;
/** 写真の空の部分の色（平行投影では空のドームが写らないので、明るい空色で塗る。トーンマッピング前の明るさ） */
const SKY_COLOR = new THREE.Color(0.75, 0.85, 0.95);

const COPY_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const COPY_FRAGMENT = /* glsl */ `
  uniform sampler2D tStrip;
  uniform float uShade;
  uniform float uFlip;
  varying vec2 vUv;
  // メインの画面と同じ ACES のトーンマッピング（Narkowicz の近似）。描画先が写真のテクスチャなので、three.js は自動ではかけない
  vec3 acesFilm(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }
  void main() {
    float u = mix(vUv.x, 1.0 - vUv.x, uFlip);
    vec3 color = acesFilm(texture2D(tStrip, vec2(u, vUv.y)).rgb * 1.05) * uShade;
    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`;

export interface PhotoFinishSetup {
  /** ゴール線の x */
  finishX: number;
  /** スタンド側のカメラの z（負）。鏡の側は符号を反転した z から撮る */
  cameraZ: number;
  /** 写真の 1 ピクセルあたりのレースの時刻（レースの内部時刻の単位） */
  timePerPixel: number;
  /** 写真の左端の時刻（勝ち馬がゴールする時刻より少し前） */
  startTime: number;
  /** ゴール付近の馬の速さ（ワールド単位 / レースの内部時刻）。帯の横の位置を時刻に直すのに使う */
  speed: number;
}

export class PhotoFinish {
  private readonly mainCamera = new THREE.OrthographicCamera(-1, 0, VIEW_TOP, VIEW_BOTTOM, 0.1, 220);
  private readonly mirrorCamera = new THREE.OrthographicCamera(0, 1, VIEW_TOP, VIEW_BOTTOM, 0.1, 220);
  private readonly mainStrip = new THREE.WebGLRenderTarget(STRIP_WIDTH, MAIN_BAND, { type: THREE.HalfFloatType });
  private readonly mirrorStrip = new THREE.WebGLRenderTarget(STRIP_WIDTH, MIRROR_BAND, { type: THREE.HalfFloatType });
  private readonly target = new THREE.WebGLRenderTarget(PHOTO_WIDTH, PHOTO_HEIGHT);
  private readonly copyMaterial = new THREE.ShaderMaterial({
    vertexShader: COPY_VERTEX,
    fragmentShader: COPY_FRAGMENT,
    uniforms: { tStrip: { value: null }, uShade: { value: 1 }, uFlip: { value: 0 } },
    depthTest: false,
    depthWrite: false,
  });
  private readonly quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.copyMaterial);
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private setup: PhotoFinishSetup | null = null;
  /** 次に書く列（ピクセル） */
  private column = 0;
  private finished = false;

  constructor() {
    this.quad.frustumCulled = false;
    this.target.texture.colorSpace = THREE.SRGBColorSpace;
  }

  /** 写真（ターフビジョンの画面に貼る） */
  get texture() {
    return this.target.texture;
  }

  /** 撮り終えたか（写真の右端まで撮ったか） */
  get done() {
    return this.finished;
  }

  /** 写真の上の x（0..1）。その時刻にゴール線にあったものが写っている列 */
  xAt(time: number) {
    if (!this.setup) return 0;
    return (time - this.setup.startTime) / this.setup.timePerPixel / PHOTO_WIDTH;
  }

  /** レースごとに撮り直す。写真は暗い灰色で塗っておく */
  start(renderer: THREE.WebGLRenderer, setup: PhotoFinishSetup) {
    this.setup = setup;
    this.column = 0;
    this.finished = false;
    // カメラはゴール線の延長上から、真横（z の向き）を向く。平行投影なので、手前の馬も奥の馬も同じ大きさで写る
    const height = (VIEW_TOP + VIEW_BOTTOM) / 2;
    this.mainCamera.position.set(setup.finishX, height, setup.cameraZ);
    this.mainCamera.lookAt(setup.finishX, height, 0);
    this.mirrorCamera.position.set(setup.finishX, height, -setup.cameraZ);
    this.mirrorCamera.lookAt(setup.finishX, height, 0);
    for (const camera of [this.mainCamera, this.mirrorCamera]) {
      camera.top = VIEW_TOP - height;
      camera.bottom = VIEW_BOTTOM - height;
      // 奥の内馬場（生垣や木）まで写す。空は写らないので、帯を描く前に空の色で塗る
      camera.far = 220;
    }
    const previous = renderer.getRenderTarget();
    const clearColor = renderer.getClearColor(new THREE.Color());
    const clearAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.target);
    renderer.setClearColor("#1a1b1f", 1);
    renderer.clear();
    renderer.setClearColor(clearColor, clearAlpha);
    renderer.setRenderTarget(previous);
  }

  /**
   * 前に撮った列から、今のレースの時刻までの列を撮る
   * @param hidden 写真に写さないもの（ゴール線の上に立っているゴール板は、毎フレーム写り込んで背景を埋めてしまう）
   */
  capture(renderer: THREE.WebGLRenderer, scene: THREE.Scene, time: number, hidden: THREE.Object3D[] = []) {
    const setup = this.setup;
    if (!setup || this.finished) return;
    const next = Math.min(PHOTO_WIDTH, Math.floor((time - setup.startTime) / setup.timePerPixel));
    if (next <= this.column) return;

    // 列 column..next は、時刻 from..to にゴール線を通ったもの。今（time）それは、ゴール線から速さ × (time - 通った時刻) だけ先にいる
    const from = setup.startTime + this.column * setup.timePerPixel;
    const to = setup.startTime + next * setup.timePerPixel;
    const near = setup.speed * Math.max(0, time - to);
    const far = setup.speed * Math.max(time - from, 1e-4);
    // スタンド側から +Z を向くと、画面の右は -X。帯の左端（u = 0）を先に通った側（ゴール線から遠い側）にする
    this.mainCamera.left = -far;
    this.mainCamera.right = -near;
    this.mainCamera.updateProjectionMatrix();
    // 内馬場側から -Z を向くと、画面の右は +X。左右が逆になるので、写すときに反転する
    this.mirrorCamera.left = near;
    this.mirrorCamera.right = far;
    this.mirrorCamera.updateProjectionMatrix();

    const previous = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    const shadowAuto = renderer.shadowMap.autoUpdate;
    // 影はメインの描画で更新したものをそのまま使う
    renderer.shadowMap.autoUpdate = false;
    renderer.autoClear = true;
    const clearColor = renderer.getClearColor(new THREE.Color());
    const clearAlpha = renderer.getClearAlpha();
    renderer.setClearColor(SKY_COLOR, 1);
    const wasVisible = hidden.map((object) => object.visible);
    hidden.forEach((object) => (object.visible = false));
    renderer.setRenderTarget(this.mainStrip);
    renderer.render(scene, this.mainCamera);
    renderer.setRenderTarget(this.mirrorStrip);
    renderer.render(scene, this.mirrorCamera);
    renderer.setClearColor(clearColor, clearAlpha);
    hidden.forEach((object, i) => (object.visible = wasVisible[i]));

    // 写真の column..next の範囲だけに、撮った帯を写す（ビューポートで書く範囲を区切る）
    renderer.autoClear = false;
    const width = next - this.column;
    const uniforms = this.copyMaterial.uniforms;
    uniforms.tStrip.value = this.mainStrip.texture;
    uniforms.uShade.value = 1;
    uniforms.uFlip.value = 0;
    this.target.viewport.set(this.column, 0, width, MAIN_BAND);
    renderer.setRenderTarget(this.target);
    renderer.render(this.quad, this.quadCamera);
    // 鏡は少し暗い
    uniforms.tStrip.value = this.mirrorStrip.texture;
    uniforms.uShade.value = 0.72;
    uniforms.uFlip.value = 1;
    this.target.viewport.set(this.column, MAIN_BAND + DIVIDER, width, MIRROR_BAND);
    renderer.setRenderTarget(this.target);
    renderer.render(this.quad, this.quadCamera);
    this.target.viewport.set(0, 0, PHOTO_WIDTH, PHOTO_HEIGHT);

    renderer.setRenderTarget(previous);
    renderer.autoClear = autoClear;
    renderer.shadowMap.autoUpdate = shadowAuto;
    this.column = next;
    if (this.column >= PHOTO_WIDTH) this.finished = true;
  }

  dispose() {
    this.mainStrip.dispose();
    this.mirrorStrip.dispose();
    this.target.dispose();
    this.copyMaterial.dispose();
    this.quad.geometry.dispose();
  }
}
