import * as THREE from "three";
import { getNoise3D, NOISE3D_GLSL } from "./noise3d";
import { COURSE_UNIFORMS_GLSL, SKY_GLSL, type CourseUniforms } from "./surfaceCommon";

// 水面のシェーダー（内馬場の池）。
// 波は向きと波長の違う正弦波と 3D ノイズ（z 軸を時間で送る）のさざ波を重ねた「傾き」だけを求めて法線に使い、頂点は動かさない。
// 映り込みは環境マップを用意せず、空のドームと同じ式（skyColor）で反射方向の空の色を求める。

const WATER_VERTEX = /* glsl */ `
  varying vec3 vWorld;
  varying vec2 vLocal;
  void main() {
    // 円形ジオメトリのローカル座標（中心 0、岸 1）。岸からの距離に使う
    vLocal = position.xy;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const WATER_FRAGMENT = /* glsl */ `
  ${COURSE_UNIFORMS_GLSL}
  ${NOISE3D_GLSL}
  ${SKY_GLSL}
  uniform vec3 uDeep;
  uniform vec3 uShallow;
  uniform vec3 uShore;
  varying vec3 vWorld;
  varying vec2 vLocal;

  // 1 本の正弦波の傾き（高さ a・sin(k(d・p - ct)) の勾配）
  vec2 waveSlope(vec2 p, vec2 dir, float wavelength, float amplitude, float speed) {
    float k = 6.28318 / wavelength;
    return dir * (amplitude * k * cos(k * (dot(dir, p) - uTime * speed)));
  }

  // さざ波の高さ。3 次元目を時間にした 3D ノイズを風下へ流す
  // noise3 の R チャンネル（なめらか fBm）と G チャンネル（細かいノイズ）を合成する
  float ripple(vec2 p) {
    // R（fBm）は 1 周期に 4〜16 個、G は 32〜64 個の山があるので、R を細かめ・G を粗めに引いて
    // 波長 0.3〜1 単位ほどのさざ波にそろえる
    vec3 pA = vec3(p * 0.6 - uWindDir * (uTime * 0.12), uTime * 0.08);
    vec3 pB = vec3(p * 0.09 + uWindDir.yx * (uTime * 0.02), uTime * 0.05 + 0.37);
    return noise3(pA).r * 0.6 + noise3(pB).g * 0.4;
  }

  void main() {
    vec2 p = vWorld.xz;
    // 遠くでは細かい波を弱めて、きらめきのちらつきを抑える
    float detail = 1.0 - clamp(length(fwidth(p)) * 1.5, 0.0, 1.0);
    vec2 slope = waveSlope(p, uWindDir, 6.0, 0.012, 1.4)
      + waveSlope(p, normalize(uWindDir + vec2(0.4, -0.7)), 3.1, 0.018, 1.0)
      + waveSlope(p, normalize(uWindDir + vec2(-0.6, 0.5)), 1.7, 0.008, 0.8);
    vec2 e = vec2(0.05, 0.0);
    slope += vec2(ripple(p + e.xy) - ripple(p - e.xy), ripple(p + e.yx) - ripple(p - e.yx)) / (2.0 * e.x) * 0.06 * detail;
    slope *= mix(0.4, 1.0, detail);
    vec3 normal = normalize(vec3(-slope.x, 1.0, -slope.y));

    vec3 viewDir = normalize(vWorld - cameraPosition);
    vec3 reflected = reflect(viewDir, normal);
    // 波で反射方向が水面より下を向いたときは、地平線付近の空で代用する
    reflected.y = abs(reflected.y);
    float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(-viewDir, normal), 0.0), 5.0);

    // 水の中の色: 岸に近いほど浅く緑がかり、中央ほど深い青。太陽が低いほど暗い
    float radius = length(vLocal);
    vec3 body = mix(uDeep, uShallow, smoothstep(0.5, 0.95, radius)) * (0.55 + 0.45 * normalize(uSunDir).y * 2.0);
    vec3 color = mix(body, skyColor(reflected), fresnel);
    // 太陽のきらめき（波の斜面が太陽を鏡のように映す点）
    float glint = pow(max(dot(reflected, normalize(uSunDir)), 0.0), 500.0);
    color += uSkySun * glint * 10.0 * detail;

    // 岸辺: 寄せる波の白い泡と、その外側の濡れた土
    // 3D ノイズ（z = 時間）で岸の揺らぎを作る
    float wobble = (noise3(vec3(p * 0.05, uTime * 0.02)).r - 0.5) * 0.05;
    float edge = radius + wobble;
    float foam = smoothstep(0.9, 0.97, edge) * (0.55 + 0.45 * sin(uTime * 1.6 - radius * 60.0));
    color = mix(color, vec3(0.92, 0.95, 0.97), clamp(foam, 0.0, 1.0) * 0.45);
    color = mix(color, uShore, smoothstep(0.97, 1.0, edge));
    gl_FragColor = vec4(color, 1.0);
  }
`;

export interface WaterOptions {
  /** 深いところの水の色 */
  deep: THREE.ColorRepresentation;
  /** 浅いところ（岸寄り）の水の色 */
  shallow: THREE.ColorRepresentation;
  /** 岸の濡れた土の色 */
  shore: THREE.ColorRepresentation;
}

/** 円形（CircleGeometry）の水面用。ジオメトリの半径 1 を岸として扱う */
export const createWaterMaterial = (uniforms: CourseUniforms, options: WaterOptions) =>
  new THREE.ShaderMaterial({
    vertexShader: WATER_VERTEX,
    fragmentShader: WATER_FRAGMENT,
    uniforms: {
      ...uniforms,
      uNoise3D: { value: getNoise3D() },
      uDeep: { value: new THREE.Color(options.deep) },
      uShallow: { value: new THREE.Color(options.shallow) },
      uShore: { value: new THREE.Color(options.shore) },
    },
  });

