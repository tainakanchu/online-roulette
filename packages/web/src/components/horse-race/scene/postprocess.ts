import * as THREE from "three";
import { FullScreenQuad, Pass } from "three/examples/jsm/postprocessing/Pass.js";

// レース映像用のポストプロセス（深度フォグ・レンズフレア）。
// どちらもトーンマッピング前のリニア HDR 色で計算する。

const FULLSCREEN_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// ----- 深度フォグ -----
const FOG_FRAGMENT = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform sampler2D tDepth;
  uniform mat4 uProjectionInverse;
  uniform mat4 uCameraWorld;
  uniform vec3 uCameraPos;
  uniform vec3 uFogColor;
  uniform vec3 uSunColor;
  uniform vec3 uSunDir;
  uniform float uDensity;
  uniform float uHeightFalloff;
  uniform float uStart;
  uniform float uSkyHaze;
  varying vec2 vUv;

  void main() {
    vec4 base = texture2D(tDiffuse, vUv);
    float depth = texture2D(tDepth, vUv).x;
    // 深度からワールド座標を復元する（空は深度を書かないので遠平面上の点になる）
    vec4 view = uProjectionInverse * vec4(vec3(vUv, depth) * 2.0 - 1.0, 1.0);
    vec3 world = (uCameraWorld * vec4(view.xyz / view.w, 1.0)).xyz;
    vec3 ray = world - uCameraPos;
    float dist = length(ray);
    vec3 dir = ray / dist;

    // 太陽の方向を向くほど霞が光を散らして明るく暖かく見える（前方散乱の近似）
    float sunAmount = pow(max(dot(dir, uSunDir), 0.0), 8.0);
    vec3 fogColor = mix(uFogColor, uSunColor, sunAmount * 0.45);

    float fog;
    if (depth >= 1.0) {
      // 空は地平線付近だけ霞ませて、遠くの地面と境目なくつなぐ
      fog = uSkyHaze * (1.0 - smoothstep(0.0, 0.1, dir.y));
    } else {
      // 手前 uStart までは霞をかけない（馬やゲートをくっきり見せる）
      float skip = min(dist, uStart);
      float len = dist - skip;
      float originY = uCameraPos.y + dir.y * skip;
      // 高さ方向に指数関数で薄くなる霧を視線に沿って積分する（地面近くほど濃い）
      float k = uHeightFalloff * dir.y;
      float path = abs(k) > 1e-5 ? (1.0 - exp(-k * len)) / k : len;
      float opticalDepth = uDensity * exp(-uHeightFalloff * originY) * path;
      fog = 1.0 - exp(-opticalDepth);
    }
    gl_FragColor = vec4(mix(base.rgb, fogColor, fog), base.a);
  }
`;

export interface DepthFogOptions {
  /** 霞の色（空の地平線の色に合わせる） */
  color: THREE.ColorRepresentation;
  /** 太陽方向の霞の色 */
  sunColor: THREE.ColorRepresentation;
  /** 太陽の方向（正規化済み） */
  sunDirection: THREE.Vector3;
  /** 地表付近での濃さ（1 ワールド単位あたり） */
  density: number;
  /** 高さ 1 単位あたりの減衰率。大きいほど霧が地面に張り付く */
  heightFalloff: number;
  /** カメラからこの距離までは霧をかけない */
  start: number;
  /** 地平線付近の空にかける霞の最大量 */
  skyHaze: number;
}

/**
 * シーンの深度バッファから距離と高さを求めてかける霧。
 * three.js 標準の Fog と違い、高さで濃さが変わり、太陽方向は明るく色づく。
 * 入力の readBuffer に depthTexture が付いている必要がある。
 */
export class DepthFogPass extends Pass {
  /** 直近に描いたシーンの深度。レンズフレアの遮蔽判定に使う */
  sceneDepth: THREE.DepthTexture | null = null;
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: FullScreenQuad;
  private readonly baseDensity: number;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    options: DepthFogOptions
  ) {
    super();
    this.baseDensity = options.density;
    this.material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: FOG_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uProjectionInverse: { value: new THREE.Matrix4() },
        uCameraWorld: { value: new THREE.Matrix4() },
        uCameraPos: { value: new THREE.Vector3() },
        uFogColor: { value: new THREE.Color(options.color) },
        uSunColor: { value: new THREE.Color(options.sunColor) },
        uSunDir: { value: options.sunDirection.clone().normalize() },
        uDensity: { value: options.density },
        uHeightFalloff: { value: options.heightFalloff },
        uStart: { value: options.start },
        uSkyHaze: { value: options.skyHaze },
      },
    });
    this.quad = new FullScreenQuad(this.material);
  }

  /** 霞の色（空の地平線の色に合わせる）と、太陽方向の霞の色 */
  setColors(color: THREE.ColorRepresentation, sunColor: THREE.ColorRepresentation) {
    this.material.uniforms.uFogColor.value.set(color);
    this.material.uniforms.uSunColor.value.set(sunColor);
  }

  /** 霧の濃さを基準値の何倍にするか */
  setDensityScale(scale: number) {
    this.material.uniforms.uDensity.value = this.baseDensity * scale;
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget
  ) {
    this.sceneDepth = readBuffer.depthTexture;
    const u = this.material.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.tDepth.value = readBuffer.depthTexture;
    // RenderPass の描画でカメラ行列は今フレームのものに更新済み
    u.uProjectionInverse.value.copy(this.camera.projectionMatrixInverse);
    u.uCameraWorld.value.copy(this.camera.matrixWorld);
    u.uCameraPos.value.setFromMatrixPosition(this.camera.matrixWorld);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    if (this.clear) renderer.clear();
    this.quad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.quad.dispose();
  }
}

// ----- レンズフレア -----
const FLARE_SAMPLES = 24;

const FLARE_VERTEX = /* glsl */ `
  uniform sampler2D tDepth;
  uniform vec2 uSun;
  uniform float uAspect;
  varying vec2 vUv;
  varying float vVisible;

  void main() {
    vUv = uv;
    // 太陽のまわりの深度を調べ、空（何も描かれず深度 1.0 のまま）が見えている割合を可視度にする。
    // 全画面三角形の 3 頂点ぶんだけ読めばよいので、ピクセルごとに読むより安い
    float visible = 0.0;
    for (int i = 0; i < ${FLARE_SAMPLES}; i++) {
      float fi = float(i);
      float angle = fi * 2.39996; // 黄金角で円盤内に均等に散らす
      float radius = sqrt((fi + 0.5) / ${FLARE_SAMPLES}.0) * 0.022;
      vec2 offset = vec2(cos(angle), sin(angle)) * radius / vec2(uAspect, 1.0);
      // 画面外の太陽は、画面の縁で一番近い場所の空の見え具合で代用する
      vec2 p = clamp(uSun + offset, 0.002, 0.998);
      visible += step(0.999999, texture2D(tDepth, p).x);
    }
    vVisible = visible / ${FLARE_SAMPLES}.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FLARE_FRAGMENT = /* glsl */ `
  uniform vec2 uSun;
  uniform float uAspect;
  uniform float uIntensity;
  uniform vec3 uTint;
  varying vec2 vUv;
  varying float vVisible;

  // 6 枚羽根の絞りの形（六角形の距離関数）
  float hexagon(vec2 p) {
    p = abs(p);
    return max(p.x * 0.866025 + p.y * 0.5, p.y);
  }

  // 絞りの形をしたゴースト。縁を少し明るくしてレンズ内の反射らしくする
  float ghostShape(vec2 p, float radius) {
    float d = hexagon(p) / radius;
    return smoothstep(1.0, 0.86, d) * (0.5 + 0.5 * smoothstep(0.4, 1.0, d));
  }

  // 色収差で RGB ごとに大きさをずらしたゴースト
  vec3 ghost(vec2 p, vec2 center, float radius, vec3 color) {
    vec2 q = p - center;
    return color * vec3(
      ghostShape(q, radius),
      ghostShape(q, radius * 1.04),
      ghostShape(q, radius * 1.08)
    );
  }

  void main() {
    vec2 aspect = vec2(uAspect, 1.0);
    vec2 p = (vUv - 0.5) * aspect;
    vec2 sun = (uSun - 0.5) * aspect;
    vec2 toSun = p - sun;
    float d = length(toSun);

    vec3 col = vec3(0.0);
    // 太陽まわりのにじみ
    col += uTint * (exp(-d * 10.0) * 1.1 + exp(-d * 3.0) * 0.06);
    // 光条（絞り羽根による 6 本 + 細い 6 本）
    float angle = atan(toSun.y, toSun.x);
    float rays = pow(abs(cos(angle * 3.0 + 0.4)), 80.0) + 0.5 * pow(abs(cos(angle * 3.0 + 1.45)), 160.0);
    col += uTint * rays * exp(-d * 4.5) * 0.9;
    // アナモルフィックレンズ風の青白い横筋
    col += vec3(0.4, 0.6, 1.0) * exp(-abs(toSun.y) * 160.0) * exp(-abs(toSun.x) * 1.4) * 0.45;

    // ゴーストは太陽 → 画面中心 → 反対側の直線上に並ぶ
    col += ghost(p, sun * 0.62, 0.035, vec3(1.0, 0.72, 0.4)) * 0.18;
    col += ghost(p, sun * 0.28, 0.018, vec3(0.5, 1.0, 0.6)) * 0.24;
    col += ghost(p, sun * -0.22, 0.07, vec3(0.45, 0.65, 1.0)) * 0.07;
    col += ghost(p, sun * -0.55, 0.035, vec3(1.0, 0.45, 0.75)) * 0.14;
    col += ghost(p, sun * -0.9, 0.11, vec3(0.55, 0.85, 1.0)) * 0.05;
    col += ghost(p, sun * -1.35, 0.05, vec3(1.0, 0.85, 0.45)) * 0.1;

    // 画面中心を囲む虹色の輪（太陽のある側だけ見える）
    float r = length(p);
    float side = pow(max(0.0, dot(p / max(r, 1e-4), sun / max(length(sun), 1e-4))), 3.0);
    // pow() は底が負だと未定義なので、二乗は掛け算で書く
    vec3 ring = (vec3(r) - vec3(0.44, 0.46, 0.48)) * 28.0;
    vec3 halo = exp(-ring * ring);
    col += halo * side * 0.08;

    gl_FragColor = vec4(col * uIntensity * vVisible, 1.0);
  }
`;

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

export interface LensFlareOptions {
  /** 太陽の方向（正規化済み） */
  sunDirection: THREE.Vector3;
  /** フレアの色 */
  tint: THREE.ColorRepresentation;
  /** 全体の強さ */
  intensity: number;
  /** 遮蔽判定に使うシーンの深度 */
  depth: () => THREE.Texture | null;
}

/**
 * 太陽によるレンズフレアを入力に加算で描く。
 * 太陽が建物や馬に隠れると深度で判定して弱まり、画面外でも縁に近ければうっすら残る。
 */
export class LensFlarePass extends Pass {
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: FullScreenQuad;
  private readonly sunDirection: THREE.Vector3;
  private readonly sunNdc = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly intensity: number;
  /** 天気による強さの倍率（曇り空では太陽が隠れてフレアはほとんど出ない） */
  private intensityScale = 1;
  private readonly depth: () => THREE.Texture | null;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    options: LensFlareOptions
  ) {
    super();
    // 加算なので入力を読む必要がなく、バッファの入れ替えも不要
    this.needsSwap = false;
    this.sunDirection = options.sunDirection.clone().normalize();
    this.intensity = options.intensity;
    this.depth = options.depth;
    this.material = new THREE.ShaderMaterial({
      vertexShader: FLARE_VERTEX,
      fragmentShader: FLARE_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      // 色だけ足し込み、アルファは入力のまま残す
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      uniforms: {
        tDepth: { value: null },
        uSun: { value: new THREE.Vector2() },
        uAspect: { value: 1 },
        uIntensity: { value: 0 },
        uTint: { value: new THREE.Color(options.tint) },
      },
    });
    this.quad = new FullScreenQuad(this.material);
  }

  render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget
  ) {
    const strength = this.sunStrength() * this.intensityScale;
    const depth = this.depth();
    if (strength <= 0.001 || !depth) return;
    const u = this.material.uniforms;
    u.tDepth.value = depth;
    u.uSun.value.set(this.sunNdc.x * 0.5 + 0.5, this.sunNdc.y * 0.5 + 0.5);
    u.uAspect.value = this.camera.aspect;
    u.uIntensity.value = this.intensity * strength;
    // 入力に足し込むので、描画前の自動クリアを止める
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(readBuffer);
    this.quad.render(renderer);
    renderer.autoClear = autoClear;
  }

  setIntensityScale(scale: number) {
    this.intensityScale = scale;
  }

  /** 太陽が画面のどこにあるかを求め、画面外へ出るほど弱める（0..1） */
  private sunStrength(): number {
    this.camera.getWorldDirection(this.forward);
    const facing = this.forward.dot(this.sunDirection);
    // 真横より後ろでは投影が破綻するので、その前に消しておく
    if (facing <= 0.2) return 0;
    this.sunNdc.copy(this.sunDirection).multiplyScalar(1000).add(this.camera.position).project(this.camera);
    const edge = Math.max(Math.abs(this.sunNdc.x), Math.abs(this.sunNdc.y));
    return (1 - smoothstep(1.0, 1.7, edge)) * smoothstep(0.2, 0.45, facing);
  }

  dispose() {
    this.material.dispose();
    this.quad.dispose();
  }
}

// ----- モーションブラーと被写界深度 -----
const BLUR_FRAGMENT = (samples: number) => /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tDepth;
  uniform mat4 uProjectionInverse;
  uniform mat4 uCameraWorld;
  uniform mat4 uPrevViewProjection;
  uniform vec3 uCameraPos;
  uniform vec3 uFieldMin;
  uniform vec3 uFieldMax;
  uniform vec3 uFieldDelta;
  uniform float uShutter;
  uniform float uMaxMotion;
  uniform float uFocusDistance;
  uniform float uFocusRange;
  uniform float uMaxCoc;
  uniform float uAspect;
  varying vec2 vUv;

  vec3 worldAt(vec2 uv, float depth) {
    vec4 view = uProjectionInverse * vec4(vec3(uv, depth) * 2.0 - 1.0, 1.0);
    return (uCameraWorld * vec4(view.xyz / view.w, 1.0)).xyz;
  }

  // ピントからの外れ具合（ぼけの半径。UV 単位）。空は一番ぼける
  float cocAt(float depth, vec3 world) {
    if (depth >= 1.0) return uMaxCoc;
    float distance = length(world - uCameraPos);
    return clamp(abs(distance - uFocusDistance) / uFocusRange, 0.0, 1.0) * uMaxCoc;
  }

  void main() {
    float depth = texture2D(tDepth, vUv).x;
    vec3 world = worldAt(vUv, depth);
    bool sky = depth >= 1.0;

    // 動きのベクトル: 今の位置を 1 フレーム前のカメラで写した位置との差。
    // 馬群の範囲の点は馬群と一緒に動いているので、馬群が進んだ分を戻してから写す（カメラが追う馬はぶれない）。
    // 空は無限遠なので、方向だけを写す（w = 0）
    vec4 prevClip;
    if (sky) {
      prevClip = uPrevViewProjection * vec4(normalize(world - uCameraPos), 0.0);
    } else {
      bool inField = all(greaterThan(world, uFieldMin)) && all(lessThan(world, uFieldMax));
      prevClip = uPrevViewProjection * vec4(inField ? world - uFieldDelta : world, 1.0);
    }
    vec2 prevUv = prevClip.xy / prevClip.w * 0.5 + 0.5;
    vec2 velocity = (vUv - prevUv) * uShutter;
    float motion = length(velocity * vec2(uAspect, 1.0));
    velocity *= min(1.0, uMaxMotion / max(motion, 1e-5));
    motion = min(motion, uMaxMotion);

    float coc = cocAt(depth, world);
    vec3 center = texture2D(tColor, vUv).rgb;
    // ぶれもぼけもほとんどない所は、そのまま出す（大半のピクセルはここで終わるので軽い）
    if (motion < 0.0008 && coc < 0.0006) {
      gl_FragColor = vec4(center, 1.0);
      return;
    }

    // 動きの線に沿った点と、ぼけの円の中の点を一緒に拾って平均する（黄金角で円の中に均等に散らす）
    vec3 sum = center;
    float weightSum = 1.0;
    for (int i = 0; i < ${samples}; i++) {
      float fi = float(i);
      float along = (fi + 0.5) / ${samples}.0 - 0.5;
      float angle = fi * 2.39996;
      float radius = sqrt((fi + 0.5) / ${samples}.0) * coc;
      vec2 offset = velocity * along + vec2(cos(angle), sin(angle)) * radius / vec2(uAspect, 1.0);
      vec2 sampleUv = clamp(vUv + offset, vec2(0.001), vec2(0.999));
      float sampleDepth = texture2D(tDepth, sampleUv).x;
      // 手前にあるピントの合ったもの（馬など）が、奥のぼけた背景へにじみ出さないようにする
      float weight = 1.0;
      if (sampleDepth < depth && radius > 0.0) {
        float sampleCoc = cocAt(sampleDepth, worldAt(sampleUv, sampleDepth));
        weight = clamp(sampleCoc / radius, 0.0, 1.0);
      }
      sum += texture2D(tColor, sampleUv).rgb * weight;
      weightSum += weight;
    }
    gl_FragColor = vec4(sum / weightSum, 1.0);
  }
`;

const COPY_FRAGMENT = /* glsl */ `
  uniform sampler2D tColor;
  varying vec2 vUv;
  void main() {
    gl_FragColor = texture2D(tColor, vUv);
  }
`;

export interface BlurSettings {
  /** シャッターを開けている割合（1 フレームの何割の動きをぶれにするか） */
  shutter: number;
  /** ピントを合わせる距離（ワールド単位） */
  focusDistance: number;
  /** ピントが合って見える範囲の半分の幅。これだけ外れると一番ぼける */
  focusRange: number;
  /** 一番ぼけたときの半径（画面の高さに対する割合） */
  maxCoc: number;
}

/**
 * カメラの動きによるモーションブラーと、被写界深度のぼけ。
 * 深度からワールド座標を求め、1 フレーム前のカメラで写した位置との差で、ぶれの向きと長さを出す。
 * 動くものは馬群だけなので、馬群の範囲（setField で渡す箱）にある点は馬群の進んだ分を差し引いて、カメラが追う馬をぶらさない。
 * 入力のシーンの深度を読みながら同じレンダーターゲットに書くことはできないので、自分のターゲットに描いてから入力へ写し戻す
 */
export class CinematicBlurPass extends Pass {
  private readonly material: THREE.ShaderMaterial;
  private readonly copyMaterial: THREE.ShaderMaterial;
  private readonly quad: FullScreenQuad;
  private readonly target: THREE.WebGLRenderTarget;
  private readonly prevViewProjection = new THREE.Matrix4();
  private readonly viewProjection = new THREE.Matrix4();
  private hasPrevious = false;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly depth: () => THREE.Texture | null,
    samples: number
  ) {
    super();
    // 入力（霧をかけた後の色）にそのまま書き戻すので、バッファの入れ替えはしない
    this.needsSwap = false;
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType });
    this.material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: BLUR_FRAGMENT(samples),
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tColor: { value: null },
        tDepth: { value: null },
        uProjectionInverse: { value: new THREE.Matrix4() },
        uCameraWorld: { value: new THREE.Matrix4() },
        uPrevViewProjection: { value: new THREE.Matrix4() },
        uCameraPos: { value: new THREE.Vector3() },
        uFieldMin: { value: new THREE.Vector3(1e9, 1e9, 1e9) },
        uFieldMax: { value: new THREE.Vector3(-1e9, -1e9, -1e9) },
        uFieldDelta: { value: new THREE.Vector3() },
        uShutter: { value: 0.5 },
        uMaxMotion: { value: 0.015 },
        uFocusDistance: { value: 20 },
        uFocusRange: { value: 8 },
        uMaxCoc: { value: 0 },
        uAspect: { value: 1 },
      },
    });
    this.copyMaterial = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: COPY_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: { tColor: { value: this.target.texture } },
    });
    this.quad = new FullScreenQuad(this.material);
  }

  setSize(width: number, height: number) {
    this.target.setSize(width, height);
  }

  /** ピントとシャッター（毎フレーム、カメラのカットに合わせて変える） */
  setSettings(settings: BlurSettings) {
    const u = this.material.uniforms;
    u.uShutter.value = settings.shutter;
    u.uFocusDistance.value = settings.focusDistance;
    u.uFocusRange.value = Math.max(0.5, settings.focusRange);
    u.uMaxCoc.value = settings.maxCoc;
  }

  /** 馬群のいる範囲と、1 フレームで進んだ分（その範囲の点はカメラと一緒に動いているものとして扱う） */
  setField(min: THREE.Vector3, max: THREE.Vector3, delta: THREE.Vector3) {
    const u = this.material.uniforms;
    u.uFieldMin.value.copy(min);
    u.uFieldMax.value.copy(max);
    u.uFieldDelta.value.copy(delta);
  }

  /** カメラが切り替わった直後は前のフレームとの差が意味をなさないので、ぶれをつけない */
  markCut() {
    this.hasPrevious = false;
  }

  render(
    renderer: THREE.WebGLRenderer,
    _writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget
  ) {
    const depth = this.depth();
    this.viewProjection.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    if (!this.hasPrevious) this.prevViewProjection.copy(this.viewProjection);
    const u = this.material.uniforms;
    u.tColor.value = readBuffer.texture;
    u.tDepth.value = depth;
    u.uProjectionInverse.value.copy(this.camera.projectionMatrixInverse);
    u.uCameraWorld.value.copy(this.camera.matrixWorld);
    u.uPrevViewProjection.value.copy(this.prevViewProjection);
    u.uCameraPos.value.setFromMatrixPosition(this.camera.matrixWorld);
    u.uAspect.value = this.camera.aspect;
    if (depth) {
      this.quad.material = this.material;
      renderer.setRenderTarget(this.target);
      this.quad.render(renderer);
      this.quad.material = this.copyMaterial;
      renderer.setRenderTarget(readBuffer);
      this.quad.render(renderer);
    }
    this.prevViewProjection.copy(this.viewProjection);
    this.hasPrevious = true;
  }

  dispose() {
    this.material.dispose();
    this.copyMaterial.dispose();
    this.quad.dispose();
    this.target.dispose();
  }
}

// ----- 画面の上に重ねる文字（馬名のラベル） -----

/**
 * 指定したレイヤーのものだけを、ポストプロセスの途中の画像の上に重ねて描く。
 * 馬名のラベルはシーン本体と一緒に描くと霧・ぶれ・ぼけ・ブルームがかかって読みにくいので、それらの後から描く
 */
export class LayerOverlayPass extends Pass {
  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly layer: number
  ) {
    super();
    // 入力の上に描き足すだけなので、バッファは入れ替えない
    this.needsSwap = false;
  }

  render(renderer: THREE.WebGLRenderer, _writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    const mask = this.camera.layers.mask;
    const autoClear = renderer.autoClear;
    // 影はシーン本体を描いたときに更新済み。ここでもう一度影を描かない
    const shadowAuto = renderer.shadowMap.autoUpdate;
    this.camera.layers.set(this.layer);
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(readBuffer);
    renderer.render(this.scene, this.camera);
    renderer.shadowMap.autoUpdate = shadowAuto;
    renderer.autoClear = autoClear;
    this.camera.layers.mask = mask;
  }
}

// ----- 映画風の画づくり -----

const CINEMA_FRAGMENT = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform float uTime;
  uniform float uAmount;
  uniform float uAspect;
  varying vec2 vUv;

  float grainHash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    vec2 centered = vUv - 0.5;
    // 周辺ほどレンズの色収差で赤と青がわずかにずれる
    vec2 shift = centered * dot(centered, centered) * 0.012 * uAmount;
    vec3 color = vec3(
      texture2D(tDiffuse, vUv + shift).r,
      texture2D(tDiffuse, vUv).g,
      texture2D(tDiffuse, vUv - shift).b
    );
    // 色調: 暗い所は青緑へ、明るい所は橙へ少し寄せる（トーンマッピング前の明るさで分ける）
    float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
    float shadow = 1.0 - smoothstep(0.0, 0.35, luma);
    float highlight = smoothstep(0.5, 1.6, luma);
    color *= mix(vec3(1.0), vec3(0.92, 1.0, 1.06), shadow * 0.6 * uAmount);
    color *= mix(vec3(1.0), vec3(1.06, 1.0, 0.92), highlight * 0.5 * uAmount);
    // 周辺減光（横長の画面に合わせた楕円）
    vec2 v = centered * vec2(uAspect, 1.0) / uAspect;
    color *= mix(1.0, 1.0 - smoothstep(0.25, 0.75, length(v) * 1.1), 0.55 * uAmount);
    // フィルムの粒子（フレームごとに模様を変える。暗い所ほど目立つ）
    float grain = grainHash(vUv * vec2(1931.0, 1171.0) + fract(uTime * 7.3)) - 0.5;
    color += grain * 0.05 * uAmount * (0.4 + 0.6 * shadow) * max(luma, 0.05);
    gl_FragColor = vec4(max(color, 0.0), 1.0);
  }
`;

/**
 * 映画風の画づくり（色収差・色調・周辺減光・フィルムの粒子）。トーンマッピングの前（明るさがそのままの画像）にかける。
 * 強さ uAmount は 0 で素通し、1 で最大。レース中だけ強めて、レース前の画面はすっきりさせる
 */
export class CinemaGradePass extends Pass {
  private readonly material: THREE.ShaderMaterial;
  private readonly quad: FullScreenQuad;

  constructor() {
    super();
    this.material = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERTEX,
      fragmentShader: CINEMA_FRAGMENT,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDiffuse: { value: null },
        uTime: { value: 0 },
        uAmount: { value: 0 },
        uAspect: { value: 16 / 9 },
      },
    });
    this.quad = new FullScreenQuad(this.material);
  }

  setAmount(amount: number) {
    this.material.uniforms.uAmount.value = amount;
  }

  setSize(width: number, height: number) {
    this.material.uniforms.uAspect.value = width / Math.max(1, height);
  }

  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget) {
    this.material.uniforms.tDiffuse.value = readBuffer.texture;
    this.material.uniforms.uTime.value = performance.now() / 1000;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.material.dispose();
    this.quad.dispose();
  }
}
