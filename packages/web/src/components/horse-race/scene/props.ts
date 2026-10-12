import * as THREE from "three";
import { NOISE3D_GLSL, noise3DUniform } from "./noise3d";
import { COURSE_UNIFORMS_GLSL, SKY_GLSL, type CourseUniforms } from "./surfaceCommon";

// 小物のシェーダー（コンクリートと舗装、ターフビジョンの LED）。
// 汚れやムラは共有の 3D テクスチャ（noise3）をワールド座標で引くので、柱のような曲面でも継ぎ目が出ない。

const CONCRETE_VERTEX = /* glsl */ `
  #include <begin_vertex>
  // インスタンス描画（花壇の縁石など、同じ形をいくつも置くもの）では個体ごとの配置を掛けてワールド座標にする
  #ifdef USE_INSTANCING
    mat4 concreteModel = modelMatrix * instanceMatrix;
  #else
    mat4 concreteModel = modelMatrix;
  #endif
  vConcreteWorld = (concreteModel * vec4(transformed, 1.0)).xyz;
  vConcreteNormal = normalize(mat3(concreteModel) * objectNormal);
`;

const CONCRETE_COLOR = /* glsl */ `
  vec3 concreteP = vConcreteWorld;
  vec3 concreteN = normalize(vConcreteNormal);
  float concreteUp = smoothstep(0.5, 0.8, concreteN.y);
  // 大小のムラと、壁面では上から流れた雨だれ（縦に引き伸ばして引く）
  float concreteStain = noise3(concreteP * 0.1).r * 0.6 + noise3(concreteP * 0.8).g * 0.4;
  float concreteDrip = noise3(vec3(concreteP.x * 0.8, concreteP.y * 0.04, concreteP.z * 0.8)).g * (1.0 - concreteUp);
  diffuseColor.rgb *= (0.78 + 0.35 * concreteStain) * (1.0 - 0.18 * smoothstep(0.55, 0.8, concreteDrip));
  // 舗装の目地（上を向いた面だけ）
  vec2 concreteTile = abs(fract(concreteP.xz / uJointSpacing) - 0.5) * 2.0;
  float concreteJoint = 1.0 - smoothstep(0.9, 0.95, max(concreteTile.x, concreteTile.y));
  diffuseColor.rgb *= mix(1.0, mix(0.6, 1.0, concreteJoint), concreteUp * uJoints);
  // 雨のあとは上を向いた面が濡れて暗くなる
  diffuseColor.rgb *= mix(1.0, 0.6, uWetness * concreteUp);
`;

const CONCRETE_ROUGHNESS = /* glsl */ `
  roughnessFactor = mix(roughnessFactor, 0.35, uWetness * concreteUp);
`;

const CONCRETE_OUTPUT = /* glsl */ `
  {
    // 濡れた舗装には空がうっすら映る
    vec3 viewDir = normalize(concreteP - cameraPosition);
    float fresnel = 0.02 + 0.98 * pow(1.0 - max(dot(-viewDir, concreteN), 0.0), 5.0);
    float gloss = uWetness * concreteUp * 0.5 * (0.6 + 0.4 * concreteStain);
    outgoingLight = mix(outgoingLight, skyColor(reflect(viewDir, concreteN)), fresnel * gloss);
  }
`;

export interface ConcreteOptions {
  color: THREE.ColorRepresentation;
  /** 上を向いた面に舗装の目地を入れる */
  joints?: boolean;
  /** 目地の間隔（ワールド単位） */
  jointSpacing?: number;
}

/** コンクリート（柱・脚・エプロンの舗装）。馬場が濡れていると舗装も濡れる */
export const createConcreteMaterial = (uniforms: CourseUniforms, options: ConcreteOptions) => {
  const material = new THREE.MeshStandardMaterial({ color: options.color, roughness: 0.9 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, noise3DUniform(), {
      uJoints: { value: options.joints ? 1 : 0 },
      uJointSpacing: { value: options.jointSpacing ?? 2 },
    });
    shader.vertexShader =
      "varying vec3 vConcreteWorld;\nvarying vec3 vConcreteNormal;\n" +
      shader.vertexShader.replace("#include <begin_vertex>", CONCRETE_VERTEX);
    shader.fragmentShader =
      "varying vec3 vConcreteWorld;\nvarying vec3 vConcreteNormal;\nuniform float uJoints;\nuniform float uJointSpacing;\n" +
      COURSE_UNIFORMS_GLSL +
      NOISE3D_GLSL +
      SKY_GLSL +
      shader.fragmentShader
        .replace("#include <color_fragment>", "#include <color_fragment>\n" + CONCRETE_COLOR)
        .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n" + CONCRETE_ROUGHNESS)
        .replace("#include <opaque_fragment>", CONCRETE_OUTPUT + "\n#include <opaque_fragment>");
  };
  return material;
};

/**
 * LED モジュールの見た目（ledTextures.ts のテクスチャ）。画面の UV と、画面に並ぶモジュールの数から引く。
 *   R: モジュールごとの明るさ  G: 継ぎ目  B: 色味のずれ  A: 輝度の落ちた素子
 */
export const LED_MODULE_GLSL = /* glsl */ `
  uniform sampler2D uLedModules;
  uniform vec2 uModuleCount;
  uniform float uModulesPerTile;
  vec3 applyLedModules(vec3 color, vec2 screenUv) {
    vec2 moduleUv = screenUv * uModuleCount / uModulesPerTile;
    vec4 module = texture2D(uLedModules, moduleUv);
    // 1 モジュールが画面上で 25 ピクセルより小さくなる遠景では、継ぎ目の細い線が画素とずれて格子のちらつきになるので消す
    // （fwidth はモジュール単位の座標が 1 ピクセルで進む量 = 1 / モジュールの画面上の大きさ）
    float moduleFine = 1.0 - smoothstep(0.04, 0.1, length(fwidth(moduleUv * uModulesPerTile)));
    color *= 0.88 + 0.24 * module.r;
    // 色温度のずれ: 0.5 が無補正、大きいほど青寄り
    float shift = (module.b - 0.5) * 0.06;
    color *= vec3(1.0 - shift, 1.0, 1.0 + shift);
    color *= module.a;
    // 継ぎ目は発光しない細い線。色は変えずに暗くするだけにする（黒の上で明るい線にならないように）
    color *= 1.0 - module.g * 0.45 * moduleFine;
    return color;
  }
`;

const LED_FRAGMENT = /* glsl */ `
  {
    // LED の粒。近くでは丸い発光点の並びに見え、遠くでは平均の明るさへ寄せてモアレを出さない
    vec2 led = vMapUv * uLedCount;
    float dotMask = 1.0 - smoothstep(0.32, 0.45, length(fract(led) - 0.5));
    float far = clamp(length(fwidth(led)) * 1.2, 0.0, 1.0);
    // 丸い粒の面積は全体の約半分なので、2 倍して平均の明るさをそろえる
    diffuseColor.rgb *= mix(dotMask * 2.0, 1.0, far);
    diffuseColor.rgb = applyLedModules(diffuseColor.rgb, vMapUv);
  }
`;

export interface LedModules {
  texture: THREE.Texture;
  /** 画面に並ぶモジュールの数（横, 縦） */
  count: THREE.Vector2;
  /** テクスチャ 1 枚に並ぶモジュールの数 */
  perTile: number;
}

/** LED モジュールのユニフォーム（画面と中継映像の枠で共有する） */
export const ledModuleUniforms = (modules: LedModules) => ({
  uLedModules: { value: modules.texture },
  uModuleCount: { value: modules.count },
  uModulesPerTile: { value: modules.perTile },
});

/** ターフビジョンの画面（Canvas の映像を LED の粒で表示する） */
export const createLedScreenMaterial = (map: THREE.Texture, ledCount: THREE.Vector2, modules: LedModules) => {
  const material = new THREE.MeshBasicMaterial({ map, toneMapped: false });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, ledModuleUniforms(modules), { uLedCount: { value: ledCount } });
    shader.fragmentShader =
      "uniform vec2 uLedCount;\n" +
      LED_MODULE_GLSL +
      shader.fragmentShader.replace("#include <map_fragment>", "#include <map_fragment>\n" + LED_FRAGMENT);
  };
  return material;
};
