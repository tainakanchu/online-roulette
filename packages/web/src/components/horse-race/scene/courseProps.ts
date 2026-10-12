import * as THREE from "three";
import { createFinishPostArt, createFurlongNumberAtlas } from "./courseSignTextures";
import type { ClothFlags } from "./clothFlag";
import { createFlagMaterial, createFlagUniforms } from "./flag";
import { createFlagCloth } from "./flagTextures";
import { FINISH_X } from "./environment";
import { loadModel, takeNode, type ModelNode } from "./models";
import { createRustyMetalMaterial } from "./rust";

// コース上の標識・備品（ハロン棒・ゴール板・パトロールタワー・発走委員の台と旗・中継カメラ台）。
// Blender で作った public/models/course-props.glb のノードを、シーン側のマテリアルに差し替えて並べる。
// glb のノードは「+Z が走路側」で作ってあるので、内馬場側（走路の +Z 側）に置くものは半回転させる。

/** パトロールタワーを立てる x（内馬場側。ほかの備品はここを避けて置く） */
export const PATROL_TOWER_X = [FINISH_X + 90, FINISH_X - 260, FINISH_X - 520];

export interface CoursePropModels {
  furlongPole: ModelNode;
  finishPost: ModelNode;
  patrolTower: ModelNode;
  starterStand: ModelNode;
  starterFlag: ModelNode;
  cameraPlatform: ModelNode;
  /** 発走委員の台のローカル座標で、旗を付ける位置 */
  flagAttachment: THREE.Vector3;
}

/** course-props.glb を読み込む。ノードが欠けていたら失敗にする（手続き生成の標識のまま使う） */
export const loadCoursePropModels = async (): Promise<CoursePropModels> => {
  const gltf = await loadModel("course-props.glb");
  const node = (name: string) => {
    const found = takeNode(gltf, name);
    if (!found || found.parts.length === 0) throw new Error(`course-props.glb: ${name} not found`);
    return found;
  };
  const attachment = gltf.scene.getObjectByName("StarterStand")?.userData.flag_attachment;
  const flagAttachment = Array.isArray(attachment)
    ? new THREE.Vector3(Number(attachment[0]), Number(attachment[1]), Number(attachment[2]))
    : new THREE.Vector3(0.67, 4.18, 0.53);
  return {
    furlongPole: node("FurlongPole"),
    finishPost: node("FinishPost"),
    patrolTower: node("PatrolTower"),
    starterStand: node("StarterStand"),
    starterFlag: node("StarterFlag"),
    cameraPlatform: node("CameraPlatform"),
    flagAttachment,
  };
};

/**
 * 標識・備品を組み立てる。ジオメトリとマテリアルは使い回し、置くたびに作るのはメッシュだけにする。
 * ハロン棒の数字の面だけは本ごとに UV が違うので複製し、releaseInstances で捨てる
 */
export class CourseProps {
  private readonly materials = new Map<string, THREE.Material>();
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private instanceDisposables: Array<{ dispose: () => void }> = [];
  /** 旗の布のなびき（flag.ts のシェーダー）と、布の色・凹凸のテクスチャ（flagTextures.ts） */
  private readonly flagUniforms: ReturnType<typeof createFlagUniforms>;
  private readonly flagCloth = createFlagCloth();
  private readonly furlongAtlas = createFurlongNumberAtlas();
  private readonly finishArt = createFinishPostArt();
  /** 物理エンジンで布を動かす旗。物理エンジンを読み込むまでは null で、旗は頂点シェーダーでなびかせる */
  private clothFlags: ClothFlags | null = null;

  constructor(
    private readonly models: CoursePropModels,
    sunDirection: THREE.Vector3
  ) {
    this.flagUniforms = createFlagUniforms(sunDirection);
    this.disposables.push(this.furlongAtlas, this.finishArt, this.flagCloth);
  }

  /** 物理エンジンの旗に切り替える（次に組み立てる旗から物理で動かす） */
  setClothFlags(flags: ClothFlags | null) {
    this.clothFlags = flags;
  }

  /** 旗をなびかせる */
  update(time: number) {
    this.flagUniforms.uFlagTime.value = time;
  }

  /** 前回の組み立てで複製したジオメトリを捨てる（コースを組み直すたびに呼ぶ） */
  releaseInstances() {
    this.instanceDisposables.forEach((d) => d.dispose());
    this.instanceDisposables = [];
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  /** Blender 側のマテリアル名 → シーンのマテリアル。屋外の塗装はうっすら錆びさせる */
  private material(name: string, color: THREE.Color): THREE.Material {
    const cached = this.materials.get(name);
    if (cached) return cached;
    let material: THREE.Material;
    switch (name) {
      case "PaintWhite":
        material = createRustyMetalMaterial({ paint: "#f4f4f1", rust: 0.1, scale: 1.6, roughness: 0.45, metalness: 0.08 });
        break;
      case "PaintRed":
        material = createRustyMetalMaterial({ paint: "#d32f2f", rust: 0.1, scale: 1.6, roughness: 0.4, metalness: 0.08 });
        break;
      case "SteelGrey":
        material = createRustyMetalMaterial({ paint: "#9ea3a8", rust: 0.22, scale: 1.2, roughness: 0.5, metalness: 0.4 });
        break;
      case "Dark":
        material = new THREE.MeshStandardMaterial({ color: "#26282c", roughness: 0.55, metalness: 0.3 });
        break;
      case "Glass":
        material = new THREE.MeshStandardMaterial({ color: "#1d3346", roughness: 0.08, metalness: 0.7 });
        break;
      case "Tire":
        // スタート台を引いて運ぶ台車のタイヤ
        material = new THREE.MeshStandardMaterial({ color: "#1c1c1e", roughness: 0.92 });
        break;
      case "FlagCloth":
        material = createFlagMaterial(this.flagUniforms, {
          color: "#d0161c",
          map: this.flagCloth.map,
          detail: this.flagCloth.detail,
        });
        break;
      default:
        // パラソルの布など。Blender 側の色をそのまま使う
        material = new THREE.MeshStandardMaterial({ color, roughness: 0.7 });
    }
    this.materials.set(name, this.track(material));
    return material;
  }

  private simulatedFlagMaterial() {
    const cached = this.materials.get("FlagClothSimulated");
    if (cached) return cached;
    const material = this.track(
      createFlagMaterial(this.flagUniforms, {
        color: "#d0161c",
        map: this.flagCloth.map,
        detail: this.flagCloth.detail,
        simulated: true,
      })
    );
    this.materials.set("FlagClothSimulated", material);
    return material;
  }

  private signMaterial(key: string, texture: THREE.Texture) {
    const cached = this.materials.get(key);
    if (cached) return cached;
    const material = this.track(new THREE.MeshStandardMaterial({ map: texture, roughness: 0.5, side: THREE.DoubleSide }));
    this.materials.set(key, material);
    return material;
  }

  /**
   * ノードをメッシュにする
   * @param sign 数字や絵を描く面（SignFace）のマテリアルと、面ごとに UV を変えるときの変換
   */
  private build(node: ModelNode, sign?: { material: THREE.Material; uv?: (uv: THREE.BufferAttribute) => void }) {
    const group = new THREE.Group();
    for (const part of node.parts) {
      let geometry = part.geometry;
      let material: THREE.Material;
      if (part.materialName === "SignFace" && sign) {
        material = sign.material;
        // glTF の UV は画像の上が v = 0 だが、Canvas のテクスチャ（flipY）は下が v = 0 なので縦を反転してから使う
        geometry = geometry.clone();
        const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
        for (let i = 0; i < uv.count; i += 1) uv.setY(i, 1 - uv.getY(i));
        sign.uv?.(uv);
        this.instanceDisposables.push(geometry);
      } else {
        material = this.material(part.materialName, part.color);
      }
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    return group;
  }

  /** ハロン棒。標示板に残り距離（100m 単位）の数字を出す */
  furlongPole(remainingMeters: number) {
    const { offset, repeat } = this.furlongAtlas.cellUv(remainingMeters);
    return this.build(this.models.furlongPole, {
      material: this.signMaterial("furlong", this.furlongAtlas.texture),
      uv: (uv) => {
        for (let i = 0; i < uv.count; i += 1) {
          uv.setXY(i, uv.getX(i) * repeat.x + offset.x, uv.getY(i) * repeat.y + offset.y);
        }
      },
    });
  }

  finishPost() {
    return this.build(this.models.finishPost, { material: this.signMaterial("finish", this.finishArt.texture) });
  }

  patrolTower() {
    return this.build(this.models.patrolTower);
  }

  cameraPlatform() {
    return this.build(this.models.cameraPlatform);
  }

  /** 発走委員の台と、なびく赤い旗 */
  starterStand() {
    const group = this.build(this.models.starterStand);
    if (this.clothFlags) {
      // 布は物理で動かす。竿の上端の位置（旗を付ける位置）だけを台に付けておく。
      // 台は置かれてから位置が決まるので、布は次の物理の更新で竿の位置へ移る（付け根の飛びを検出して置き直す）
      const anchor = new THREE.Object3D();
      anchor.position.copy(this.models.flagAttachment);
      group.add(anchor);
      this.instanceDisposables.push(this.clothFlags.create(anchor, this.simulatedFlagMaterial()));
      return group;
    }
    const flag = this.build(this.models.starterFlag);
    flag.position.copy(this.models.flagAttachment);
    flag.traverse((object) => {
      object.castShadow = false;
    });
    group.add(flag);
    return group;
  }

  dispose() {
    this.releaseInstances();
    this.disposables.forEach((d) => d.dispose());
    const { furlongPole, finishPost, patrolTower, starterStand, starterFlag, cameraPlatform } = this.models;
    for (const node of [furlongPole, finishPost, patrolTower, starterStand, starterFlag, cameraPlatform]) {
      node.parts.forEach((part) => part.geometry.dispose());
    }
  }
}
