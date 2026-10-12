import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { loadModel, takeNode, type ModelNode } from "./models";
import { createGateDetail, type GateDetail } from "./gateTextures";
import { createSignTexture } from "./textures";
import { createWornPaintMaterial } from "./wornPaint";

// スタートゲート（発馬機）。Blender で作ったモジュール（public/models/starting-gate.glb）を馬の頭数ぶん並べて組む。
// glb を読み込む前や読み込めなかったときは、箱を組み合わせた簡易なゲートを使う。

/** glb のモジュールは馬房の幅 1.7 で作ってあり、頭数に合わせて幅方向（z）だけ伸び縮みさせる */
const MODULE_PITCH = 1.7;
/** 馬房の前端と後端の x。馬は鼻先から尾の先まで約 3.9 あるので、その外側に扉が来る奥行きにする */
const STALL_FRONT = 2.3;
const STALL_BACK = -2.3;
/**
 * ゲート用の 3D テクスチャ（剥がれ・錆・汚れ）。生成に 100ms ほどかかり、ゲートは頭数が変わるたびに組み直すので、
 * 1 回だけ作って使い回し、シーンを破棄するときに releaseGateDetail で捨てる
 */
let gateDetail: GateDetail | null = null;
const getGateDetail = () => {
  gateDetail ??= createGateDetail();
  return gateDetail.texture;
};
export const releaseGateDetail = () => {
  gateDetail?.dispose();
  gateDetail = null;
};

/** 看板の文字を何馬房ごとに繰り返すか（看板の 1 馬房ぶんの面は横長なので、2 馬房で文字の縦横比がほぼ合う） */
const SIGN_BAYS_PER_TEXT = 2;

export interface GateModel {
  partition: ModelNode;
  doorLeft: ModelNode;
  doorRight: ModelNode;
  rearDoorLeft: ModelNode;
  rearDoorRight: ModelNode;
  trussBay: ModelNode;
  signPanel: ModelNode;
  endFrameLeft: ModelNode;
  endFrameRight: ModelNode;
  /** 前扉を開ききったときの Y 回転（ラジアン）。Blender 側で決めた向き */
  openAngles: { left: number; right: number };
}

/** starting-gate.glb を読み込む。ノードが欠けていたら失敗にする（簡易なゲートのまま使う） */
export const loadGateModel = async (): Promise<GateModel> => {
  const gltf = await loadModel("starting-gate.glb");
  const node = (name: string) => {
    const found = takeNode(gltf, name);
    if (!found || found.parts.length === 0) throw new Error(`starting-gate.glb: ${name} not found`);
    return found;
  };
  const openAngle = (name: string, fallback: number) => {
    const degrees = gltf.scene.getObjectByName(name)?.userData.open_angle_degrees;
    return typeof degrees === "number" ? THREE.MathUtils.degToRad(degrees) : fallback;
  };
  return {
    partition: node("Partition"),
    doorLeft: node("DoorLeft"),
    doorRight: node("DoorRight"),
    rearDoorLeft: node("RearDoorLeft"),
    rearDoorRight: node("RearDoorRight"),
    trussBay: node("TrussBay"),
    signPanel: node("SignPanel"),
    endFrameLeft: node("EndFrameLeft"),
    endFrameRight: node("EndFrameRight"),
    openAngles: { left: openAngle("DoorLeft", Math.PI / 2), right: openAngle("DoorRight", -Math.PI / 2) },
  };
};

interface DoorSet {
  meshes: THREE.InstancedMesh[];
  /** 各馬房の蝶番の位置 */
  hinges: THREE.Vector3[];
  openAngle: number;
  scaleZ: number;
}

export class StartingGate {
  readonly group = new THREE.Group();
  private readonly materials = new Map<string, THREE.Material>();
  private readonly disposables: Array<{ dispose: () => void }> = [];
  /** 箱で組んだ簡易なゲートの扉 */
  private readonly simpleDoors: Array<{ pivot: THREE.Group; dir: number }> = [];
  /** glb で組んだゲートの前扉（InstancedMesh） */
  private readonly modelDoors: DoorSet[] = [];
  private openAmount = 0;
  private opening = false;
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(lanes: number[], laneWidth: number, model: GateModel | null) {
    if (model) this.buildFromModel(lanes, laneWidth, model);
    else this.buildSimple(lanes, laneWidth);
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  /** Blender 側のマテリアル名 → シーンのマテリアル（錆や汚れはシェーダーで足す） */
  private material(name: string): THREE.Material {
    let material = this.materials.get(name);
    if (material) return material;
    switch (name) {
      case "GateGreen":
        // 緑の鉄骨は塗装が剥げて錆が垂れる（部材が細かく面が多いので、錆は控えめにしないと全体が茶色に見える）
        material = createWornPaintMaterial({
          paint: "#1f6b2e",
          wear: 0.2,
          roughness: 0.5,
          metalness: 0.25,
          detail: getGateDetail(),
          scale: 1.4,
        });
        break;
      case "GateWhite":
        material = createWornPaintMaterial({
          paint: "#f2f2ee",
          // 白い扉や柱はこまめに塗り直されるので、剥がれは小さく少なめ
          wear: 0.08,
          roughness: 0.4,
          metalness: 0.12,
          detail: getGateDetail(),
          scale: 1.1,
        });
        break;
      case "GateSign": {
        const texture = this.track(createSignTexture("LUCKY ROULETTE", "#f4f4f0", "#1f6b2e"));
        texture.wrapS = THREE.RepeatWrapping;
        material = new THREE.MeshStandardMaterial({ map: texture, roughness: 0.5 });
        break;
      }
      case "GatePad":
        material = new THREE.MeshStandardMaterial({ color: "#232325", roughness: 0.85 });
        break;
      case "GateRubber":
        material = new THREE.MeshStandardMaterial({ color: "#121212", roughness: 0.9 });
        break;
      case "GateLamp":
        // 枠入り確認ランプ。ブルームで少し光って見える明るさ
        material = new THREE.MeshStandardMaterial({ color: "#ff3b30", emissive: "#ff2a1a", emissiveIntensity: 2.2 });
        break;
      default:
        material = new THREE.MeshStandardMaterial({ color: "#888888", roughness: 0.6 });
    }
    this.materials.set(name, this.track(material));
    return material;
  }

  private buildFromModel(lanes: number[], laneWidth: number, model: GateModel) {
    const scaleZ = laneWidth / MODULE_PITCH;
    const top = lanes.length ? lanes[0] + laneWidth / 2 : 0;
    const bottom = lanes.length ? lanes[lanes.length - 1] - laneWidth / 2 : 0;
    // 動かない部品はマテリアルごとに 1 つのジオメトリにまとめて描画回数を減らす
    const staticParts = new Map<string, THREE.BufferGeometry[]>();
    /** @param bay 看板の文字の位置合わせに使う馬房の番号（+Z 側から 0, 1, ...） */
    const place = (node: ModelNode, position: THREE.Vector3, stretch: boolean, bay = 0) => {
      this.matrix.compose(position, this.quaternion.identity(), new THREE.Vector3(1, 1, stretch ? scaleZ : 1));
      for (const part of node.parts) {
        const geometry = part.geometry.clone().applyMatrix4(this.matrix);
        const uv = geometry.getAttribute("uv");
        if (part.materialName === "GateSign" && uv) {
          // 看板の面の u は馬房ごとに -Z 側が 0。正面（+X）から見て左から右へ読めるよう反転し、馬房の番号ぶんずらす
          for (let i = 0; i < uv.count; i += 1) uv.setX(i, (bay + 1 - uv.getX(i)) / SIGN_BAYS_PER_TEXT);
        }
        const list = staticParts.get(part.materialName) ?? [];
        list.push(geometry);
        staticParts.set(part.materialName, list);
      }
    };
    lanes.forEach((z, bay) => {
      place(model.trussBay, new THREE.Vector3(0, 0, z), true);
      place(model.signPanel, new THREE.Vector3(0, 0, z), true, bay);
      // 後扉は閉じたまま
      place(model.rearDoorLeft, new THREE.Vector3(model.rearDoorLeft.origin.x, 0, z + model.rearDoorLeft.origin.z * scaleZ), true);
      place(model.rearDoorRight, new THREE.Vector3(model.rearDoorRight.origin.x, 0, z + model.rearDoorRight.origin.z * scaleZ), true);
    });
    // 仕切りは馬房の境目ごと（頭数 + 1 枚）。厚みは変えない
    for (let i = 0; i <= lanes.length; i += 1) {
      place(model.partition, new THREE.Vector3(0, 0, top - i * laneWidth), false);
    }
    place(model.endFrameLeft, new THREE.Vector3(0, 0, bottom), false);
    place(model.endFrameRight, new THREE.Vector3(0, 0, top), false);
    for (const [name, geometries] of staticParts) {
      const merged = mergeGeometries(geometries);
      geometries.forEach((g) => g.dispose());
      if (!merged) continue;
      const mesh = new THREE.Mesh(this.track(merged), this.material(name));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }

    // 前扉は開閉するので、左右それぞれを馬房の数だけ InstancedMesh で並べる
    const doors: Array<[ModelNode, number]> = [
      [model.doorLeft, model.openAngles.left],
      [model.doorRight, model.openAngles.right],
    ];
    for (const [node, openAngle] of doors) {
      const hinges = lanes.map((z) => new THREE.Vector3(node.origin.x, node.origin.y, z + node.origin.z * scaleZ));
      const meshes = node.parts.map((part) => {
        const mesh = new THREE.InstancedMesh(this.track(part.geometry.clone()), this.material(part.materialName), lanes.length);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        // 扉は開くと元の範囲からはみ出すので、境界球によるカリングをしない
        mesh.frustumCulled = false;
        this.group.add(mesh);
        this.disposables.push({ dispose: () => mesh.dispose() });
        return mesh;
      });
      this.modelDoors.push({ meshes, hinges, openAngle, scaleZ });
    }
    this.apply();
  }

  /** glb を読み込む前に使う、箱を組み合わせた簡易なゲート */
  private buildSimple(lanes: number[], laneWidth: number) {
    const frameMat = this.material("GateGreen");
    const whiteMat = this.material("GateWhite");
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D = this.group) => {
      this.track(geo);
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };
    const half = (lanes.length * laneWidth) / 2 + 0.4;
    const centerZ = lanes.length ? (lanes[0] + lanes[lanes.length - 1]) / 2 : 0;
    const depth = STALL_FRONT - STALL_BACK;
    const middle = (STALL_FRONT + STALL_BACK) / 2;
    const beam = add(new THREE.BoxGeometry(0.5, 0.4, half * 2 + 0.6), frameMat);
    beam.position.set(STALL_FRONT - 0.3, 3.2, centerZ);
    const beamBack = add(new THREE.BoxGeometry(0.4, 0.3, half * 2 + 0.6), frameMat);
    beamBack.position.set(STALL_BACK + 0.15, 3.2, centerZ);
    const roofPanel = add(new THREE.BoxGeometry(depth - 0.2, 0.08, half * 2 + 0.6), whiteMat);
    roofPanel.position.set(middle, 3.42, centerZ);
    // 仕切りは柵状にして、中の馬が見えるようにする
    for (let i = 0; i <= lanes.length; i += 1) {
      const z = centerZ - half + 0.4 + i * laneWidth;
      for (const y of [1.05, 2.2, 3.0]) {
        const bar = add(new THREE.BoxGeometry(depth - 0.4, 0.12, 0.08), y === 2.2 ? whiteMat : frameMat);
        bar.position.set(middle, y, z);
      }
      for (const x of [STALL_BACK + 0.15, middle, STALL_FRONT - 0.3]) {
        const leg = add(new THREE.BoxGeometry(0.14, 3.2, 0.14), frameMat);
        leg.position.set(x, 1.6, z);
      }
    }
    // 前扉（中央から両開き）
    lanes.forEach((laneZ) => {
      for (const dir of [-1, 1]) {
        const pivot = new THREE.Group();
        pivot.position.set(STALL_FRONT - 0.25, 1.35, laneZ + dir * (laneWidth / 2 - 0.05));
        const door = add(new THREE.BoxGeometry(0.06, 1.1, laneWidth / 2 - 0.08), whiteMat, pivot);
        door.position.z = -dir * (laneWidth / 4 - 0.02);
        this.group.add(pivot);
        this.simpleDoors.push({ pivot, dir });
      }
    });
  }

  open() {
    this.opening = true;
  }

  close() {
    this.opening = false;
    this.openAmount = 0;
    this.apply();
  }

  /** 作り直したゲートに、開閉の途中の状態を引き継ぐ */
  copyStateFrom(other: StartingGate) {
    this.opening = other.opening;
    this.openAmount = other.openAmount;
    this.apply();
  }

  update(dt: number) {
    if (!this.opening || this.openAmount >= 1) return;
    this.openAmount = Math.min(1, this.openAmount + dt * 4.5);
    this.apply();
  }

  private apply() {
    const eased = 1 - Math.pow(1 - this.openAmount, 3);
    for (const { pivot, dir } of this.simpleDoors) {
      pivot.rotation.y = dir * eased * 1.75;
    }
    const scale = new THREE.Vector3();
    for (const { meshes, hinges, openAngle, scaleZ } of this.modelDoors) {
      this.quaternion.setFromAxisAngle(this.up, openAngle * eased);
      scale.set(1, 1, scaleZ);
      hinges.forEach((hinge, i) => {
        this.matrix.compose(hinge, this.quaternion, scale);
        for (const mesh of meshes) mesh.setMatrixAt(i, this.matrix);
      });
      for (const mesh of meshes) mesh.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }
}
