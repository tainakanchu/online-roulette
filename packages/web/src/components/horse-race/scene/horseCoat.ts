import * as THREE from "three";
import { NOISE3D_GLSL, noise3DUniform } from "./noise3d";

// 馬の毛並みのシェーダー。共有の 3D テクスチャ（noise3）を「馬の体の座標」で引くソリッドテクスチャなので、
// 胴・胸・尻・首のように別々の部品でも芦毛のまだらが継ぎ目なくつながる。
// 体の座標は、各部品のワールド座標に馬全体（root）の逆行列を掛けて求める（毎フレーム syncCoatSpace で更新）。

/** 1 頭ぶんの毛並みで共有するユニフォーム */
export interface CoatUniforms {
  /** 汗のツヤ 0..1 */
  uSweat: { value: number };
  /** 馬全体（root）のワールド行列の逆行列 */
  uRootInverse: { value: THREE.Matrix4 };
}

export const createCoatUniforms = (): CoatUniforms => ({
  uSweat: { value: 0 },
  uRootInverse: { value: new THREE.Matrix4() },
});

export type CoatMarking = "none" | "star" | "blaze";

export interface CoatOptions {
  color: THREE.ColorRepresentation;
  roughness: number;
  metalness?: number;
  /** 芦毛のまだら */
  dapple: boolean;
  /**
   * 模様を引く座標。"horse" は馬の体の座標（部品をまたいでつながる）、
   * "part" は部品自身の座標（大きく振れる脚に使う。体の座標だと脚の振りで模様が滑って見える）
   */
  space: "horse" | "part";
  /** 顔の白斑（このマテリアルを顔の部品に使うときだけ。部品自身の座標で判定する） */
  marking?: CoatMarking;
}

const COAT_VERTEX = /* glsl */ `
  #include <begin_vertex>
  vCoatPart = position;
  #ifdef COAT_HORSE_SPACE
    vCoatPos = (uRootInverse * modelMatrix * vec4(transformed, 1.0)).xyz;
  #else
    vCoatPos = position;
  #endif
  vCoatUp = normalize(mat3(modelMatrix) * objectNormal).y;
`;

const COAT_COLOR = /* glsl */ `
  {
    // 毛並み: 体の長さ方向（x）に引き伸ばして引いた細かいノイズで、色をわずかに揺らす
    float hair = noise3(vec3(vCoatPos.x * 0.6, vCoatPos.y * 7.0, vCoatPos.z * 7.0)).g;
    diffuseColor.rgb *= 0.92 + 0.16 * hair;
    // 腹側ほど暗い（体の陰と汚れ）
    diffuseColor.rgb *= mix(0.72, 1.0, smoothstep(-0.8, 0.4, vCoatUp));
    #ifdef COAT_DAPPLE
      // 芦毛のまだら: セル（Worley）の中心は明るく、縁は暗い輪になる
      vec4 cells = noise3(vCoatPos * 0.9 + 0.37);
      diffuseColor.rgb *= mix(1.18, 0.78, smoothstep(0.25, 0.5, cells.b)) * (0.9 + 0.2 * cells.a);
    #endif
    #ifdef COAT_BLAZE
      // 流星: 顔の前面（部品の +y 側）を縦に走る白い筋
      float front = vCoatPart.y / max(length(vCoatPart.yz), 1e-4);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.9, 0.86), smoothstep(0.78, 0.88, front));
    #endif
    #ifdef COAT_STAR
      // 星: 額の白い点
      float star = 1.0 - smoothstep(0.035, 0.05, distance(vCoatPart, vec3(0.05, 0.13, 0.0)));
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.9, 0.86), star);
    #endif
    // 汗をかくと毛が濡れて少し暗くなる
    diffuseColor.rgb *= 1.0 - 0.15 * uSweat;
  }
`;

const COAT_ROUGHNESS = /* glsl */ `
  // 背中側ほど毛並みのツヤがあり、汗をかくとさらに光る
  roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.75, smoothstep(0.0, 0.8, vCoatUp));
  roughnessFactor = mix(roughnessFactor, 0.2, uSweat * 0.8);
`;

export const createCoatMaterial = (uniforms: CoatUniforms, options: CoatOptions) => {
  const material = new THREE.MeshStandardMaterial({
    color: options.color,
    roughness: options.roughness,
    metalness: options.metalness ?? 0,
  });
  const defines: Record<string, string> = {};
  if (options.space === "horse") defines.COAT_HORSE_SPACE = "";
  if (options.dapple) defines.COAT_DAPPLE = "";
  if (options.marking === "blaze") defines.COAT_BLAZE = "";
  if (options.marking === "star") defines.COAT_STAR = "";
  // MeshStandardMaterial は実行時に STANDARD を define している（型定義には defines がない）ので、上書きせずに足す。
  // defines はプログラムのキャッシュキーにも入るので、模様の違うマテリアルが同じシェーダーを使い回すことはない
  const withDefines = material as THREE.MeshStandardMaterial & { defines: Record<string, string> };
  withDefines.defines = { ...withDefines.defines, ...defines };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, noise3DUniform());
    shader.vertexShader =
      "uniform mat4 uRootInverse;\nvarying vec3 vCoatPos;\nvarying vec3 vCoatPart;\nvarying float vCoatUp;\n" +
      shader.vertexShader.replace("#include <begin_vertex>", COAT_VERTEX);
    shader.fragmentShader =
      "uniform float uSweat;\nvarying vec3 vCoatPos;\nvarying vec3 vCoatPart;\nvarying float vCoatUp;\n" +
      NOISE3D_GLSL +
      shader.fragmentShader
        .replace("#include <color_fragment>", "#include <color_fragment>\n" + COAT_COLOR)
        .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n" + COAT_ROUGHNESS);
  };
  return material;
};
