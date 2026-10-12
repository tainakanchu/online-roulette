import * as THREE from "three";

// 空・芝・ダートのシェーダーで共有するユニフォームと GLSL 関数

export interface CourseUniforms {
  uTime: { value: number };
  uWindDir: { value: THREE.Vector2 };
  /** 風の強さ（風速 3m/s を 1 とする。芝の倒れ方・木のしなりの大きさ） */
  uWindStrength: { value: number };
  /** 馬場の水分 0（良）..1（不良） */
  uWetness: { value: number };
  uSkyTop: { value: THREE.Color };
  uSkyHorizon: { value: THREE.Color };
  uSkySun: { value: THREE.Color };
  uSunDir: { value: THREE.Vector3 };
  /** 雲の量 0（快晴）..1（一面の曇り） */
  uCloudCover: { value: number };
}

/** 天気ごとの空の色。馬場状態（水分）に合わせて快晴〜曇天の間で補間する */
export const CLEAR_SKY = { top: "#1d5ccf", horizon: "#9fc8ee", cloudCover: 0.2 };
export const OVERCAST_SKY = { top: "#7e8895", horizon: "#b2b9c1", cloudCover: 0.93 };

/** 馬場の水分 0..1 から曇り具合 0..1 へ。稍重までは青空が残り、不良で一面の曇り空になるよう、ゆるやかに立ち上げる */
export const overcastAmount = (wetness: number) => Math.pow(Math.min(1, Math.max(0, wetness)), 1.5);

export const createCourseUniforms = (sunDirection: THREE.Vector3): CourseUniforms => ({
  uTime: { value: 0 },
  uWindDir: { value: new THREE.Vector2(0.86, 0.5).normalize() },
  uWindStrength: { value: 1 },
  uWetness: { value: 0 },
  uSkyTop: { value: new THREE.Color(CLEAR_SKY.top) },
  uSkyHorizon: { value: new THREE.Color(CLEAR_SKY.horizon) },
  uSkySun: { value: new THREE.Color("#fff3d6") },
  uSunDir: { value: sunDirection.clone().normalize() },
  uCloudCover: { value: CLEAR_SKY.cloudCover },
});

export const COURSE_UNIFORMS_GLSL = /* glsl */ `
  uniform float uTime;
  uniform vec2 uWindDir;
  uniform float uWindStrength;
  uniform float uWetness;
  uniform vec3 uSkyTop;
  uniform vec3 uSkyHorizon;
  uniform vec3 uSkySun;
  uniform vec3 uSunDir;
  uniform float uCloudCover;
`;

/** 2D のハッシュとバリューノイズ（0..1） */
export const NOISE_GLSL = /* glsl */ `
  float hash21(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
      mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }
`;

/** 風の強さ 0..1。風下へ流れる大きな波に、横方向のゆっくりした強弱を掛ける（芝と木で共有） */
export const WIND_GLSL = /* glsl */ `
  float windStrength(vec2 p) {
    float wave = sin(dot(p, uWindDir) * 0.18 - uTime * 1.3);
    float swell = 0.75 + 0.25 * sin(dot(p, uWindDir.yx) * 0.07 + uTime * 0.4);
    return 0.5 + 0.5 * wave * swell;
  }
`;

/** 空の色。空のドームと、濡れた馬場に映り込む空で同じ式を使う */
export const SKY_GLSL = /* glsl */ `
  vec3 skyColor(vec3 dir) {
    float h = clamp(dir.y, 0.0, 1.0);
    // 地平線のすぐ上から青くなる（地平線付近だけが白っぽい）
    vec3 col = mix(uSkyHorizon, uSkyTop, pow(h, 0.4));
    // 太陽の円盤と光輪は、雲が厚いほど隠れる
    float sun = max(dot(dir, normalize(uSunDir)), 0.0);
    float sunVisible = 1.0 - smoothstep(0.5, 0.95, uCloudCover);
    return col + uSkySun * (pow(sun, 600.0) * 4.0 * sunVisible + pow(sun, 12.0) * 0.25 * (0.3 + 0.7 * sunVisible));
  }
`;

/**
 * 濡れた面に空を映す（フレネル反射）。gloss は 0..1。
 * 環境マップを用意せず、空のドームと同じ式で反射方向の空の色を求める
 */
export const WET_REFLECTION_GLSL = /* glsl */ `
  vec3 wetReflection(vec3 color, vec3 worldPos, vec3 worldNormal, float gloss) {
    vec3 viewDir = normalize(worldPos - cameraPosition);
    float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(-viewDir, worldNormal), 0.0), 5.0);
    return mix(color, skyColor(reflect(viewDir, worldNormal)), fresnel * gloss);
  }
`;

/**
 * 高さ（ワールド単位）の画面上の変化から、ワールド空間の法線 n を傾ける（Mikkelsen のバンプマッピング）。
 * 接線属性を持たない面でも使える。位置の微分は正規化しない（正規化すると凹凸の強さが距離で変わり、遠くでちらつく）
 */
export const BUMP_GLSL = /* glsl */ `
  vec3 bumpNormal(vec3 worldPos, vec3 n, float height) {
    vec3 sigmaX = dFdx(worldPos);
    vec3 sigmaY = dFdy(worldPos);
    vec3 r1 = cross(sigmaY, n);
    vec3 r2 = cross(n, sigmaX);
    float det = dot(sigmaX, r1);
    vec3 grad = sign(det) * (dFdx(height) * r1 + dFdy(height) * r2);
    return normalize(abs(det) * n - grad);
  }
`;

/** 地面系のマテリアルで使う共通の宣言と関数 */
export const SURFACE_GLSL = COURSE_UNIFORMS_GLSL + NOISE_GLSL + WIND_GLSL + SKY_GLSL + WET_REFLECTION_GLSL + BUMP_GLSL;
