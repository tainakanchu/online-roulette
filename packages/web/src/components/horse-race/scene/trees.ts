import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { takeNode } from "./models";
import { getNoise3D, NOISE3D_GLSL } from "./noise3d";
import { COURSE_UNIFORMS_GLSL, WIND_GLSL, type CourseUniforms } from "./surfaceCommon";

// 木（InstancedMesh で並べる樹冠・葉のカード・幹）のジオメトリとシェーダー。
// 樹冠はでこぼこの塊を寄せ集め、外周に葉の房を描いた切り抜きカードを散らして輪郭を細かくする。
// シェーダーでは芝と同じ風で揺らし、逆光では葉が透けて光る。幹には 3D テクスチャで樹皮の縦の溝をつける。

// ----- ジオメトリ -----

/** 種から決まる乱数（mulberry32）。同じ形の木を毎回作れる */
const seededRandom = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** 頂点を押し出すための滑らかな 3D の揺らぎ（おおよそ -1.5..1.5）。同じ位置なら同じ値なので面の継ぎ目が割れない */
const lumpiness = (p: THREE.Vector3, phase: number) =>
  Math.sin(p.x * 2.1 + phase) * Math.sin(p.y * 2.7 + phase * 1.3) * Math.sin(p.z * 2.3 + phase * 0.7) +
  0.5 * Math.sin(p.x * 4.3 + p.z * 3.7 + phase * 2.1) * Math.sin(p.y * 5.1 + phase);

/**
 * 法線を樹冠全体の中心から外向きへ寄せる。葉の塊を 1 つの柔らかい塊として照らし、面ごとのカクつきを消す。
 * 中心を少し下に置くと、上の葉ほど空を向いて明るくなる
 */
export const applyVolumeNormals = (
  geometry: THREE.BufferGeometry,
  center: THREE.Vector3,
  amount: number,
  recompute = true
) => {
  if (recompute) geometry.computeVertexNormals();
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (let i = 0; i < position.count; i += 1) {
    p.fromBufferAttribute(position, i).sub(center).normalize();
    n.fromBufferAttribute(normal, i);
    n.lerp(p, amount).normalize();
    normal.setXYZ(i, n.x, n.y, n.z);
  }
};

const merge = (parts: THREE.BufferGeometry[]) => {
  const merged = mergeGeometries(parts);
  parts.forEach((part) => part.dispose());
  if (!merged) throw new Error("Failed to merge tree geometry");
  return merged;
};

/** 広葉樹の樹冠。中心の大きな塊のまわりに、押し出してでこぼこにした塊を寄せ集める（原点中心、半径 radius 程度） */
export const createBroadleafCrown = (radius: number, seed: number) => {
  const random = seededRandom(seed);
  const parts: THREE.BufferGeometry[] = [];
  const p = new THREE.Vector3();
  for (let i = 0; i < 8; i += 1) {
    const isCore = i === 0;
    const r = radius * (isCore ? 0.62 : 0.34 + random() * 0.16);
    const blob = new THREE.IcosahedronGeometry(r, 1);
    const center = isCore
      ? new THREE.Vector3(0, 0, 0)
      : new THREE.Vector3(random() - 0.5, random() * 0.8 - 0.3, random() - 0.5).multiplyScalar(radius * 1.1);
    const position = blob.getAttribute("position");
    for (let v = 0; v < position.count; v += 1) {
      p.fromBufferAttribute(position, v);
      const bump = 1 + 0.2 * lumpiness(p.clone().add(center), seed + i);
      p.multiplyScalar(bump).add(center);
      position.setXYZ(v, p.x, p.y, p.z);
    }
    parts.push(blob);
  }
  const crown = merge(parts);
  applyVolumeNormals(crown, new THREE.Vector3(0, -radius * 0.3, 0), 0.75);
  return crown;
};

/** 樹冠の表面に散らす葉の房のカード（createLeafCardTexture を貼る） */
export const createLeafCards = (radius: number, seed: number, count: number) => {
  const random = seededRandom(seed);
  const parts: THREE.BufferGeometry[] = [];
  const dir = new THREE.Vector3();
  const facing = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const spin = new THREE.Quaternion();
  const matrix = new THREE.Matrix4();
  const scale = new THREE.Vector3(1, 1, 1);
  const forward = new THREE.Vector3(0, 0, 1);
  for (let i = 0; i < count; i += 1) {
    const size = radius * (0.6 + random() * 0.4);
    const card = new THREE.PlaneGeometry(size, size);
    // 表面付近の点（下側は少なめ）に、外向きを中心にばらけた向きで置く
    dir.set(random() * 2 - 1, random() * 1.5 - 0.5, random() * 2 - 1).normalize();
    const position = dir.clone().multiply(new THREE.Vector3(1, 0.8, 1)).multiplyScalar(radius * (0.6 + random() * 0.3));
    facing.copy(dir).add(new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).multiplyScalar(1.2)).normalize();
    quaternion.setFromUnitVectors(forward, facing);
    spin.setFromAxisAngle(forward, random() * Math.PI * 2);
    card.applyMatrix4(matrix.compose(position, quaternion.multiply(spin), scale));
    parts.push(card);
  }
  const cards = merge(parts);
  applyVolumeNormals(cards, new THREE.Vector3(0, -radius * 0.3, 0), 0.9);
  return cards;
};

/** 針葉樹の樹冠。外周をギザギザにした円錐を段に重ねる（原点中心、高さ 2.6 × radius） */
export const createConiferCrown = (radius: number, seed: number) => {
  const random = seededRandom(seed);
  const height = radius * 2.6;
  const tiers = 5;
  const parts: THREE.BufferGeometry[] = [];
  const p = new THREE.Vector3();
  for (let t = 0; t < tiers; t += 1) {
    const tierHeight = height * 0.36;
    const tierRadius = radius * (1 - t * 0.17);
    const cone = new THREE.ConeGeometry(tierRadius, tierHeight, 14, 2);
    const position = cone.getAttribute("position");
    for (let v = 0; v < position.count; v += 1) {
      p.fromBufferAttribute(position, v);
      // 先端以外の頂点を角度ごとに出し入れして、枝先のギザギザにする
      const isTip = p.y > tierHeight / 2 - 1e-3;
      if (!isTip) {
        const angle = Math.atan2(p.z, p.x);
        const jag = 1 + 0.26 * Math.sin(angle * 9 + seed + t * 1.7) + 0.16 * (random() - 0.5);
        p.x *= jag;
        p.z *= jag;
      }
      position.setXYZ(v, p.x, p.y, p.z);
    }
    cone.translate(0, -height / 2 + tierHeight / 2 + t * height * 0.16, 0);
    parts.push(cone);
  }
  const crown = merge(parts);
  applyVolumeNormals(crown, new THREE.Vector3(0, -height * 0.3, 0), 0.6);
  return crown;
};

/** 先細りで少し曲がった幹と、樹冠の中へ伸びる枝（根元が原点） */
export const createTrunkGeometry = (height: number, seed: number) => {
  const random = seededRandom(seed);
  const trunk = new THREE.CylinderGeometry(0.16, 0.3, height, 8, 4);
  trunk.translate(0, height / 2, 0);
  const position = trunk.getAttribute("position");
  for (let v = 0; v < position.count; v += 1) {
    const y = position.getY(v);
    position.setX(v, position.getX(v) + Math.sin(y * 0.9) * 0.08);
  }
  const parts: THREE.BufferGeometry[] = [trunk];
  for (let i = 0; i < 3; i += 1) {
    const length = 1.2 + random() * 0.6;
    const branch = new THREE.CylinderGeometry(0.04, 0.09, length, 6);
    branch.translate(0, length / 2, 0);
    branch.rotateZ(0.6 + random() * 0.4);
    branch.rotateY((i / 3) * Math.PI * 2 + random());
    branch.translate(0, height * (0.62 + random() * 0.2), 0);
    parts.push(branch);
  }
  const geometry = merge(parts);
  geometry.computeVertexNormals();
  return geometry;
};

/** 葉の房を描いた切り抜き用テクスチャ（色はインスタンス色を掛けるので明るい灰色で描く） */
export const createLeafCardTexture = () => {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas not available");
  const random = seededRandom(5);
  for (let i = 0; i < 170; i += 1) {
    // 中心ほど葉が密になるよう、半径は乱数の積で偏らせる
    const r = random() * random() * size * 0.42;
    const a = random() * Math.PI * 2;
    const x = size / 2 + Math.cos(a) * r;
    const y = size / 2 + Math.sin(a) * r;
    const length = 9 + random() * 10;
    const tone = Math.round(150 + random() * 105);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(random() * Math.PI * 2);
    ctx.fillStyle = `rgb(${tone},${tone},${tone})`;
    ctx.beginPath();
    ctx.ellipse(0, 0, length, length * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(0,0,0,0.25)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-length, 0);
    ctx.lineTo(length, 0);
    ctx.stroke();
    ctx.restore();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
};

// ----- シェーダー -----

const TREE_GLSL = COURSE_UNIFORMS_GLSL + NOISE3D_GLSL + WIND_GLSL;

const LEAF_VERTEX = /* glsl */ `
  #ifdef USE_INSTANCING
    mat4 leafModel = modelMatrix * instanceMatrix;
  #else
    mat4 leafModel = modelMatrix;
  #endif
  vec3 treeOrigin = (leafModel * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  // 樹冠の下端 0 〜 上端 1
  float crown = clamp((position.y - uCrownMin) / (uCrownMax - uCrownMin), 0.0, 1.0);
  float gust = windStrength(treeOrigin.xz);
  // 樹冠ごと風下へしなる（上ほど大きく）。木ごとに位相をずらしてゆっくり揺り戻す
  float sway = (0.12 + 0.3 * gust) * uWindStrength * (0.8 + 0.2 * sin(uTime * 1.7 + treeOrigin.x * 0.31 + treeOrigin.z * 0.17));
  // 木ごとに向きを回して置いているので、ワールドの風向きをローカルへ戻してから押す（回転 + ほぼ一様な拡大の逆行列）
  vec3 windWorld = vec3(uWindDir.x, 0.0, uWindDir.y) * sway * crown * crown;
  transformed += transpose(mat3(leafModel)) * windWorld / dot(leafModel[0].xyz, leafModel[0].xyz);
  // 葉先の細かい震え
  transformed += normal * sin(uTime * 7.0 + dot(position, vec3(3.1, 1.7, 2.3)) + treeOrigin.x) * 0.035 * (0.5 + gust);
  vLeafCrown = crown;
  vLeafWorld = (leafModel * vec4(transformed, 1.0)).xyz;
`;

const LEAF_COLOR = /* glsl */ `
  // 葉の塊ごとの明暗と、樹冠の下側ほど陰になる暗さ
  // ワールド座標から 3D ノイズ（R: なめらかな fBm）を引いて塊の陰影をつける
  float leafClump = noise3(vLeafWorld * 0.12).r;
  diffuseColor.rgb *= (0.7 + 0.6 * leafClump) * mix(0.55, 1.1, vLeafCrown);
`;

const LEAF_TRANSLUCENCY = /* glsl */ `
  // 逆光で葉が透ける（太陽の方を向いて見るほど、葉の色で明るく光る）
  vec3 leafView = normalize(vLeafWorld - cameraPosition);
  float backlit = pow(max(dot(leafView, normalize(uSunDir)), 0.0), 5.0);
  outgoingLight += diffuseColor.rgb * uSkySun * backlit * 1.4 * (0.35 + 0.65 * vLeafCrown);
`;

export interface LeafMaterialOptions {
  /** 葉のカード用の切り抜きテクスチャ */
  map?: THREE.Texture;
  /** 頂点カラー（Blender で焼き込んだ葉ごとの色の揺らぎと陰）を使う */
  vertexColors?: boolean;
  /** 1 枚の板の葉なので裏からも描く */
  doubleSided?: boolean;
}

/**
 * 樹冠・葉のマテリアル。色はインスタンスごとに setColorAt で与える
 * @param crown 樹冠の下端と上端の高さ（ジオメトリの座標。上下の位置から揺れ幅と陰を決める）
 */
export const createLeafMaterial = (
  uniforms: CourseUniforms,
  crown: { min: number; max: number },
  options: LeafMaterialOptions = {}
) => {
  const material = new THREE.MeshStandardMaterial({
    color: "#ffffff",
    roughness: 0.9,
    map: options.map ?? null,
    alphaTest: options.map ? 0.5 : 0,
    vertexColors: options.vertexColors ?? false,
    side: options.map || options.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, {
      uCrownMin: { value: crown.min },
      uCrownMax: { value: crown.max },
      uNoise3D: { value: getNoise3D() },
    });
    shader.vertexShader =
      "uniform float uCrownMin;\nuniform float uCrownMax;\nvarying float vLeafCrown;\nvarying vec3 vLeafWorld;\n" +
      TREE_GLSL +
      shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\n" + LEAF_VERTEX);
    shader.fragmentShader =
      "varying float vLeafCrown;\nvarying vec3 vLeafWorld;\n" +
      TREE_GLSL +
      shader.fragmentShader
        .replace("#include <color_fragment>", "#include <color_fragment>\n" + LEAF_COLOR)
        // 葉のカードは両面描画。裏から見ても外向きの法線のまま照らす（面ごとに明暗が反転しないように）
        .replace("#include <normal_fragment_begin>", "#include <normal_fragment_begin>\n  normal = normalize(vNormal);")
        .replace("#include <opaque_fragment>", LEAF_TRANSLUCENCY + "\n#include <opaque_fragment>");
  };
  return material;
};

const BARK_COLOR = /* glsl */ `
  // 樹皮の縦の溝。ローカル座標を y 方向に引き伸ばして 3D ノイズ（R と G）をサンプリングする。
  // 円柱の周方向・高さ方向ともに継ぎ目なく滑らかな溝模様が得られる
  vec3 barkCoord = vec3(vTrunkLocal.x * 1.8, vTrunkLocal.y * 0.15, vTrunkLocal.z * 1.8);
  float bark = noise3(barkCoord).r * 0.6 + noise3(barkCoord * 2.5).g * 0.4;
  diffuseColor.rgb *= 0.6 + 0.8 * bark;
`;

/** 幹のマテリアル */
export const createTrunkMaterial = (
  uniforms: CourseUniforms,
  color: THREE.ColorRepresentation,
  options: { vertexColors?: boolean } = {}
) => {
  const material = new THREE.MeshStandardMaterial({ color, roughness: 1, vertexColors: options.vertexColors ?? false });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, {
      uNoise3D: { value: getNoise3D() },
    });
    shader.vertexShader =
      "varying vec3 vTrunkLocal;\n" +
      shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\n  vTrunkLocal = position;");
    shader.fragmentShader =
      "varying vec3 vTrunkLocal;\n" +
      TREE_GLSL +
      shader.fragmentShader.replace("#include <color_fragment>", "#include <color_fragment>\n" + BARK_COLOR);
  };
  return material;
};

// ----- Blender で作った木（public/models/trees.glb） -----

/** 木 1 本の置き場所。手続き生成の木と同じ配置で glb の木に差し替える */
export interface TreePlacement {
  x: number;
  z: number;
  scale: number;
  angle: number;
  /** 0: ケヤキ 1: クス 2: スギ */
  species: number;
  /** 近景用の細かいモデル（葉が 1 枚ずつ見える）を使う */
  detailed: boolean;
  /** 葉の色味（インスタンス色として頂点カラーに掛ける） */
  tint: THREE.Color;
}

const SPECIES_NODES = ["keyaki", "kusu", "sugi"];
/** glb の木は高さ 8〜11 単位で作ってあるので、手続き生成の木の大きさにそろえる */
const MODEL_SCALE = 0.8;

/**
 * glb の木をインスタンス描画で並べる。種類 × LOD × 幹 / 葉ごとに 1 つの InstancedMesh にする。
 * ノードが欠けていたら例外にして、呼び出し側で手続き生成の木のままにする
 */
export const createModelTrees = (gltf: GLTF, placements: TreePlacement[], uniforms: CourseUniforms) => {
  const group = new THREE.Group();
  const disposables: Array<{ dispose: () => void }> = [];
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();

  SPECIES_NODES.forEach((name, species) => {
    for (const detailed of [true, false]) {
      const targets = placements.filter((p) => p.species === species && p.detailed === detailed);
      if (targets.length === 0) continue;
      const lod = detailed ? 0 : 1;
      const trunk = takeNode(gltf, `${name}_LOD${lod}_trunk`);
      const leaves = takeNode(gltf, `${name}_LOD${lod}_leaves`);
      if (!trunk?.parts.length || !leaves?.parts.length) throw new Error(`trees.glb: ${name} LOD${lod} not found`);

      const meshes: THREE.InstancedMesh[] = [];
      for (const part of trunk.parts) {
        const hasColors = part.geometry.hasAttribute("color");
        const material = createTrunkMaterial(uniforms, part.color, { vertexColors: hasColors });
        meshes.push(new THREE.InstancedMesh(part.geometry, material, targets.length));
      }
      for (const part of leaves.parts) {
        const geometry = part.geometry;
        geometry.computeBoundingBox();
        const box = geometry.boundingBox ?? new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
        // 葉を樹冠全体の塊として柔らかく照らすため、法線を樹冠の中心（少し下）から外向きへ半分寄せる
        const center = box.getCenter(new THREE.Vector3());
        center.y -= (box.max.y - box.min.y) * 0.2;
        applyVolumeNormals(geometry, center, 0.5, false);
        const material = createLeafMaterial(
          uniforms,
          { min: box.min.y, max: box.max.y },
          { vertexColors: geometry.hasAttribute("color"), doubleSided: true }
        );
        const mesh = new THREE.InstancedMesh(geometry, material, targets.length);
        // 遠景用の葉の塊は面が大きく光をまともに受けて明るく見えるので、近景用の葉の明るさに合わせて落とす
        const shade = detailed ? 1 : 0.88;
        const tint = new THREE.Color();
        targets.forEach((p, i) => mesh.setColorAt(i, tint.copy(p.tint).multiplyScalar(shade)));
        meshes.push(mesh);
      }

      targets.forEach((p, i) => {
        quaternion.setFromAxisAngle(up, p.angle);
        position.set(p.x, 0, p.z);
        scale.setScalar(p.scale * MODEL_SCALE);
        matrix.compose(position, quaternion, scale);
        for (const mesh of meshes) mesh.setMatrixAt(i, matrix);
      });
      for (const mesh of meshes) {
        group.add(mesh);
        disposables.push(mesh.geometry, mesh.material as THREE.Material, { dispose: () => mesh.dispose() });
      }
    }
  });

  return { group, dispose: () => disposables.forEach((d) => d.dispose()) };
};
