import * as THREE from "three";
import { NOISE3D_GLSL, noise3DUniform } from "./noise3d";
import { BUMP_GLSL } from "./surfaceCommon";

// 使い込まれた塗装金属のマテリアル（スタートゲートの鉄骨・パイプ・扉）。
// 剥がれ・錆・雨だれ・塗膜の凹凸は、ゲート用の 3D テクスチャ（gateTextures.ts）をワールド座標で引く。
//   R: 塗装の剥がれ  G: 錆の濃さ  B: 汚れ・雨だれ  A: 塗膜の高さ

const WORN_VERTEX = /* glsl */ `
  #include <begin_vertex>
  #ifdef USE_INSTANCING
    mat4 wornModel = modelMatrix * instanceMatrix;
  #else
    mat4 wornModel = modelMatrix;
  #endif
  vWornWorld = (wornModel * vec4(transformed, 1.0)).xyz;
  vWornNormal = normalize(mat3(wornModel) * objectNormal);
`;

const WORN_COLOR = /* glsl */ `
  vec3 wornCoord = vWornWorld / uWornScale;
  vec4 wornDetail = texture(uWornDetail, wornCoord);
  // 剥がれ: テクスチャの欠けは一様に散らばっているので、共有の 3D ノイズで「傷みやすい区域」を大きく絞る。
  // 錆びやすさが大きいほど区域が広がり、欠けのしきい値も下がる
  float wornZone = smoothstep(0.62 - uWear * 0.8, 0.72 - uWear * 0.8, noise3(vWornWorld * 0.12).r);
  float wornChip = smoothstep(0.72 - uWear * 0.6, 0.8 - uWear * 0.6, wornDetail.r) * wornZone;
  float wornGrime = smoothstep(0.35, 0.85, wornDetail.b);
  vec3 wornPaint = diffuseColor.rgb;
  // 剥がれの周りの塗装には錆が滲み、雨だれの筋は塗装をくすませる
  wornPaint = mix(wornPaint, wornPaint * vec3(0.85, 0.68, 0.52), smoothstep(0.35, 0.8, wornDetail.g) * uWear);
  wornPaint *= 1.0 - 0.32 * wornGrime;
  // 剥がれた所は、錆の薄いところでは灰色の地金が見え、濃いところほど赤茶から黒ずんだ錆になる
  vec3 wornRust = mix(vec3(0.45, 0.16, 0.06), vec3(0.14, 0.06, 0.03), wornDetail.g);
  wornRust = mix(vec3(0.32, 0.32, 0.33), wornRust, smoothstep(0.15, 0.5, wornDetail.g));
  diffuseColor.rgb = mix(wornPaint, wornRust, wornChip);
`;

const WORN_ROUGHNESS = /* glsl */ `
  roughnessFactor = mix(roughnessFactor, 0.92, wornChip);
  roughnessFactor = min(1.0, roughnessFactor + 0.12 * wornGrime);
  metalnessFactor = mix(metalnessFactor, 0.05, wornChip);
`;

const WORN_NORMAL = /* glsl */ `
  {
    // 塗膜の高さ（剥がれは 1cm ほど凹む）で法線を傾ける。遠くでは凹凸を平らに寄せてちらつかせない
    float wornFine = 1.0 - clamp(length(fwidth(wornCoord)) * 40.0, 0.0, 1.0);
    vec3 wornNormal = bumpNormal(vWornWorld, normalize(vWornNormal) * faceDirection, wornDetail.a * 0.014 * wornFine);
    normal = normalize((viewMatrix * vec4(wornNormal, 0.0)).xyz);
  }
`;

export interface WornPaintOptions {
  paint: THREE.ColorRepresentation;
  /** 錆びやすさ 0..1（剥がれの面積と、塗装への錆の滲み） */
  wear: number;
  roughness: number;
  metalness: number;
  /** ゲート用の 3D テクスチャ（createGateDetail） */
  detail: THREE.Data3DTexture;
  /** テクスチャ 1 周期のワールド単位 */
  scale: number;
}

export const createWornPaintMaterial = (options: WornPaintOptions) => {
  const material = new THREE.MeshStandardMaterial({
    color: options.paint,
    roughness: options.roughness,
    metalness: options.metalness,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, noise3DUniform(), {
      uWornDetail: { value: options.detail },
      uWornScale: { value: options.scale },
      uWear: { value: options.wear },
    });
    shader.vertexShader =
      "varying vec3 vWornWorld;\nvarying vec3 vWornNormal;\n" +
      shader.vertexShader.replace("#include <begin_vertex>", WORN_VERTEX);
    shader.fragmentShader =
      "varying vec3 vWornWorld;\nvarying vec3 vWornNormal;\nuniform sampler3D uWornDetail;\nuniform float uWornScale;\nuniform float uWear;\n" +
      NOISE3D_GLSL +
      BUMP_GLSL +
      shader.fragmentShader
        .replace("#include <color_fragment>", "#include <color_fragment>\n" + WORN_COLOR)
        .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\n" + WORN_ROUGHNESS)
        .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\n" + WORN_NORMAL);
  };
  return material;
};
