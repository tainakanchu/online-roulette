import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { takeNode } from "./models";
import { createRailDetail } from "./railTextures";
import { BUMP_GLSL, COURSE_UNIFORMS_GLSL, type CourseUniforms } from "./surfaceCommon";

// 柵（ラチ）。Blender で作った 1 区間（長さ 3、支柱 1 本 + 手すり）を、コースに沿ってインスタンス描画で並べる。
// 白い塗装の汚れ・泥はね・擦り傷・凹凸は、柵用の 3D テクスチャ（railTextures.ts）をワールド座標で引く。
//   R: 汚れ・雨だれ  G: 泥はね  B: 擦り傷・小さな欠け  A: 表面の高さ

/** glb の 1 区間の長さ（支柱の間隔） */
const SEGMENT_LENGTH = 3;
/** 柵用の 3D テクスチャ 1 周期のワールド単位 */
const DETAIL_SCALE = 3;

const RAIL_VERTEX = /* glsl */ `
  #include <begin_vertex>
  #ifdef USE_INSTANCING
    mat4 railModel = modelMatrix * instanceMatrix;
  #else
    mat4 railModel = modelMatrix;
  #endif
  vRailWorld = (railModel * vec4(transformed, 1.0)).xyz;
  vRailNormal = normalize(mat3(railModel) * objectNormal);
`;

const RAIL_COLOR = /* glsl */ `
  vec3 railCoord = vRailWorld / ${DETAIL_SCALE.toFixed(1)};
  vec4 railDetail = texture(uRailDetail, railCoord);
  // 泥はねは低い所ほど多く、馬場が渋るほど増える
  float railLow = 1.0 - smoothstep(0.1, 0.9, vRailWorld.y);
  float railMud = smoothstep(0.15, 0.5, railDetail.g) * (0.3 + 0.7 * railLow) * (0.6 + 0.8 * uWetness);
  float railGrime = smoothstep(0.12, 0.6, railDetail.r);
  float railScuff = smoothstep(0.3, 0.6, railDetail.b);
  vec3 railColor = diffuseColor.rgb * (1.0 - 0.22 * railGrime);
  railColor = mix(railColor, vec3(0.22, 0.15, 0.09), clamp(railMud, 0.0, 0.9));
  // 擦れて塗装の下の灰色の地が見える
  railColor = mix(railColor, vec3(0.42, 0.42, 0.43), railScuff * 0.8);
  diffuseColor.rgb = railColor;
`;

const RAIL_ROUGHNESS = /* glsl */ `
  roughnessFactor = min(1.0, roughnessFactor + 0.12 * railGrime + 0.5 * railMud);
`;

const RAIL_NORMAL = /* glsl */ `
  {
    // 欠けは 1cm ほど凹む。遠くでは凹凸を平らに寄せてちらつかせない
    float railFine = 1.0 - clamp(length(fwidth(railCoord)) * 40.0, 0.0, 1.0);
    vec3 railNormal = bumpNormal(vRailWorld, normalize(vRailNormal) * faceDirection, railDetail.a * 0.02 * railFine);
    normal = normalize((viewMatrix * vec4(railNormal, 0.0)).xyz);
  }
`;

const createRailPaintMaterial = (uniforms: CourseUniforms, detail: THREE.Data3DTexture, color: THREE.Color) => {
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.05 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, { uRailDetail: { value: detail } });
    shader.vertexShader =
      "varying vec3 vRailWorld;\nvarying vec3 vRailNormal;\n" +
      shader.vertexShader.replace("#include <begin_vertex>", RAIL_VERTEX);
    shader.fragmentShader =
      "varying vec3 vRailWorld;\nvarying vec3 vRailNormal;\nuniform sampler3D uRailDetail;\n" +
      COURSE_UNIFORMS_GLSL +
      BUMP_GLSL +
      shader.fragmentShader
        .replace("#include <color_fragment>", "#include <color_fragment>\n" + RAIL_COLOR)
        .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n" + RAIL_ROUGHNESS)
        .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\n" + RAIL_NORMAL);
  };
  return material;
};

export interface RailLayout {
  /** 柵を張る x の範囲 */
  start: number;
  end: number;
  /** 内ラチ（走路の -Z 側に走路がある）と外ラチ（+Z 側に走路がある）の z */
  innerZ: number;
  outerZ: number;
}

/**
 * glb の柵を並べる。ノードが欠けていたら例外にして、呼び出し側で手続き生成の柵のままにする。
 * glb の区間は「走路が +Z 側」で作ってあるので、走路が -Z 側にある内ラチは Y 軸まわりに半回転させて置く
 */
export const createModelRails = (gltf: GLTF, uniforms: CourseUniforms, layout: RailLayout) => {
  const group = new THREE.Group();
  const detail = createRailDetail();
  const disposables: Array<{ dispose: () => void }> = [detail];
  const count = Math.ceil((layout.end - layout.start) / SEGMENT_LENGTH);
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const position = new THREE.Vector3();
  const unit = new THREE.Vector3(1, 1, 1);

  const sides = [
    { node: "InnerRailSegment", z: layout.innerZ, turned: true },
    { node: "OuterRailSegment", z: layout.outerZ, turned: false },
  ];
  for (const side of sides) {
    const segment = takeNode(gltf, side.node);
    if (!segment?.parts.length) throw new Error(`rails.glb: ${side.node} not found`);
    quaternion.setFromAxisAngle(up, side.turned ? Math.PI : 0);
    for (const part of segment.parts) {
      const material =
        part.materialName === "RailWhite"
          ? createRailPaintMaterial(uniforms, detail.texture, part.color)
          : new THREE.MeshStandardMaterial({ color: "#3a3c40", roughness: 0.6, metalness: 0.3 });
      const mesh = new THREE.InstancedMesh(part.geometry, material, count);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      for (let i = 0; i < count; i += 1) {
        // 半回転した区間は支柱から -X へ伸びるので、支柱を区間の終わりの側に置く
        position.set(layout.start + (side.turned ? i + 1 : i) * SEGMENT_LENGTH, 0, side.z);
        mesh.setMatrixAt(i, matrix.compose(position, quaternion, unit));
      }
      group.add(mesh);
      disposables.push(part.geometry, material, { dispose: () => mesh.dispose() });
    }
  }
  return { group, dispose: () => disposables.forEach((d) => d.dispose()) };
};
