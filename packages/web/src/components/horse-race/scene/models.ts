import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";

// Blender で作った glb（public/models 以下）の読み込み。
// 読み込みは非同期なので、シーンは手続き生成の仮の形で先に表示し、読み込めたら差し替える。

const loader = new GLTFLoader();
const cache = new Map<string, Promise<GLTF>>();

/** public/models/<file> を読み込む。同じファイルは 1 回だけ読む */
export const loadModel = (file: string): Promise<GLTF> => {
  let pending = cache.get(file);
  if (!pending) {
    pending = loader.loadAsync(`${import.meta.env.BASE_URL}models/${file}`);
    // 失敗したら次回また読み直せるようにする
    pending.catch(() => cache.delete(file));
    cache.set(file, pending);
  }
  return pending;
};

export interface ModelPart {
  geometry: THREE.BufferGeometry;
  /** Blender 側で付けたマテリアル名（シーン側でこの名前を見て独自のマテリアルに差し替える） */
  materialName: string;
  /** Blender 側で付けたベースカラー（差し替えたマテリアルの色に使う） */
  color: THREE.Color;
}

export interface ModelNode {
  /** ノードの原点を基準にしたジオメトリ（マテリアルごと） */
  parts: ModelPart[];
  /** ノードの原点のワールド座標（扉の蝶番の位置など） */
  origin: THREE.Vector3;
}

/**
 * ノード名でメッシュを探し、ノード自身の原点を基準にしたジオメトリをマテリアルごとに返す。
 * Blender のメッシュは複数マテリアルだと glTF では子メッシュ（プリミティブ）に分かれるので、配下をすべて集める
 */
export const takeNode = (gltf: GLTF, nodeName: string): ModelNode | null => {
  const node = gltf.scene.getObjectByName(nodeName);
  if (!node) return null;
  gltf.scene.updateMatrixWorld(true);
  const toNode = node.matrixWorld.clone().invert();
  const parts: ModelPart[] = [];
  node.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = (object.geometry as THREE.BufferGeometry).clone();
    geometry.applyMatrix4(toNode.clone().multiply(object.matrixWorld));
    const material = (Array.isArray(object.material) ? object.material[0] : object.material) as
      | THREE.MeshStandardMaterial
      | undefined;
    parts.push({
      geometry,
      materialName: material?.name ?? "",
      color: material?.color?.clone() ?? new THREE.Color("#ffffff"),
    });
  });
  return { parts, origin: new THREE.Vector3().setFromMatrixPosition(node.matrixWorld) };
};
