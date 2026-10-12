import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { takeNode } from "./models";
import { createConcreteMaterial } from "./props";
import { createRustyMetalMaterial } from "./rust";
import type { CourseUniforms } from "./surfaceCommon";

// ターフビジョンの構造物（筐体・枠・柱・キャットウォーク・背面パネル）。
// Blender で作った public/models/turf-vision.glb を、シーン側のマテリアルに差し替えて置く。
// 画面の中身（LED の表示と中継映像）は turfVision.ts が担当し、glb の開口（幅 36 × 高さ 14）に重ねる。

/**
 * turf-vision.glb の構造物を作る。ノードが欠けていたら例外にして、呼び出し側で簡易な枠のままにする
 * @returns 原点（画面の中心の真下の地面）を基準にしたグループ。+Z が画面の向く側
 */
export const createVisionStructure = (gltf: GLTF, uniforms: CourseUniforms) => {
  const node = takeNode(gltf, "TurfVisionStructure");
  if (!node?.parts.length) throw new Error("turf-vision.glb: TurfVisionStructure not found");
  const disposables: Array<{ dispose: () => void }> = [];
  const materials = new Map<string, THREE.Material>();
  const material = (name: string) => {
    const cached = materials.get(name);
    if (cached) return cached;
    let created: THREE.Material;
    switch (name) {
      case "FrameDark":
        created = createRustyMetalMaterial({ paint: "#26282c", rust: 0.08, scale: 1.2, roughness: 0.45, metalness: 0.4 });
        break;
      case "SteelGrey":
        created = createRustyMetalMaterial({ paint: "#a7abb0", rust: 0.16, scale: 1.4, roughness: 0.5, metalness: 0.4 });
        break;
      case "PanelBack":
        created = createRustyMetalMaterial({ paint: "#bfc2c5", rust: 0.1, scale: 1.2, roughness: 0.55, metalness: 0.3 });
        break;
      case "Concrete":
        created = createConcreteMaterial(uniforms, { color: "#b9b4ab" });
        break;
      case "Lamp":
        // 航空障害灯。ブルームで少し光って見える明るさ
        created = new THREE.MeshStandardMaterial({ color: "#ff2a1a", emissive: "#ff1a10", emissiveIntensity: 2.5 });
        break;
      default:
        created = new THREE.MeshStandardMaterial({ color: "#808080", roughness: 0.6 });
    }
    materials.set(name, created);
    disposables.push(created);
    return created;
  };

  const group = new THREE.Group();
  for (const part of node.parts) {
    const mesh = new THREE.Mesh(part.geometry, material(part.materialName));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
    disposables.push(part.geometry);
  }
  return { group, dispose: () => disposables.forEach((d) => d.dispose()) };
};
