import * as THREE from "three";
import { FINISH_X } from "./environment";
import { loadModel, takeNode, type ModelNode, type ModelPart } from "./models";
import { createPigeonFeatherDetail } from "./pigeonTextures";

// 走路に降りているドバトの群れ。餌をついばんだり歩いたりしていて、馬群が近づくと一斉に飛び立つ。
// 鳩は Blender で作った public/models/pigeon.glb。頭・翼・尾は関節ごとに別の部品なので、
// 部品ごとに InstancedMesh にまとめ、毎フレーム鳩ごとの姿勢（ついばむ・歩く・羽ばたく）から部品の行列を作る。
// glb の部品は +X が前（くちばしの向き）、+Y が上、+Z が左。

const PART_NAMES = [
  "PigeonBody",
  "PigeonHead",
  "PigeonLegs",
  "PigeonWingsFolded",
  "PigeonWingL",
  "PigeonWingR",
  "PigeonTailFolded",
  "PigeonTailSpread",
] as const;
type PartName = (typeof PART_NAMES)[number];

/** 広げた翼と尾は裏からも見えるので両面を描く */
const DOUBLE_SIDED = new Set<PartName>(["PigeonWingL", "PigeonWingR", "PigeonTailSpread"]);

/** 群れの数と 1 群れの羽数の上限 */
const FLOCKS = 3;
const MAX_PER_FLOCK = 10;
const MAX_PIGEONS = FLOCKS * MAX_PER_FLOCK;

export interface PigeonModel {
  parts: Map<PartName, ModelNode>;
  /** 胴（立った姿勢の足元が原点）から見た関節の位置 */
  headJoint: THREE.Vector3;
  shoulderLeft: THREE.Vector3;
  shoulderRight: THREE.Vector3;
  tailJoint: THREE.Vector3;
}

const toVector = (value: unknown, fallback: THREE.Vector3) =>
  Array.isArray(value) && value.length === 3
    ? new THREE.Vector3(Number(value[0]), Number(value[1]), Number(value[2]))
    : fallback;

/** pigeon.glb を読み込む。部品が欠けていたら失敗にする（鳩なしで走らせる） */
export const loadPigeonModel = async (): Promise<PigeonModel> => {
  const gltf = await loadModel("pigeon.glb");
  const parts = new Map<PartName, ModelNode>();
  for (const name of PART_NAMES) {
    const node = takeNode(gltf, name);
    if (!node || node.parts.length === 0) throw new Error(`pigeon.glb: ${name} not found`);
    parts.set(name, node);
  }
  const extras: Record<string, unknown> = gltf.scene.getObjectByName("PigeonBody")?.userData ?? {};
  return {
    parts,
    headJoint: toVector(extras.head_joint, new THREE.Vector3(0.062, 0.199, 0)),
    shoulderLeft: toVector(extras.shoulder_left, new THREE.Vector3(0.025, 0.204, 0.049)),
    shoulderRight: toVector(extras.shoulder_right, new THREE.Vector3(0.025, 0.204, -0.049)),
    tailJoint: toVector(extras.tail_joint, new THREE.Vector3(-0.128, 0.157, 0)),
  };
};

// ----- 羽毛のマテリアル -----

/**
 * 羽毛。色の模様は頂点カラー（Blender 側で塗った青灰色・翼帯・首）、細かい質感は羽毛の 3D テクスチャ（pigeonTextures.ts）。
 *   R: 羽の重なりの明暗  G: 羽軸と羽枝の筋  B: 羽の縁の毛羽立ち  A: 高さ
 * 首の金属光沢の強さは頂点カラーのアルファに入っていて、見る角度で緑〜紫に色を変える
 */
const createFeatherMaterial = (detail: THREE.Data3DTexture, side: THREE.Side) => {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, side });
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFeather = { value: detail };
    shader.vertexShader =
      "varying vec3 vFeatherLocal;\n" +
      shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\n  vFeatherLocal = transformed;");
    shader.fragmentShader =
      "varying vec3 vFeatherLocal;\nuniform sampler3D uFeather;\n" +
      shader.fragmentShader
        .replace(
          "#include <color_fragment>",
          /* glsl */ `#include <color_fragment>
  #ifdef USE_COLOR_ALPHA
    // アルファは不透明度ではなく光沢の強さ
    float featherSheen = vColor.a;
    diffuseColor.a = 1.0;
  #else
    float featherSheen = 0.0;
  #endif
  vec3 featherCoord = vFeatherLocal / 0.12;
  vec4 feather = texture(uFeather, featherCoord);
  // 羽 1 枚が 1 画素より小さくなる遠くでは模様を消して、ちらつかせない
  float featherFine = 1.0 - clamp(length(fwidth(featherCoord)) * 4.0, 0.0, 1.0);
  diffuseColor.rgb *= mix(1.0, (0.82 + 0.36 * feather.r) * (0.94 + 0.12 * feather.g), featherFine);`
        )
        .replace(
          "#include <normal_fragment_maps>",
          /* glsl */ `#include <normal_fragment_maps>
  {
    float featherFacing = abs(dot(normal, normalize(vViewPosition)));
    // 首の光沢: 正面から見ると緑、斜めから見ると紫
    vec3 iridescent = mix(vec3(0.42, 0.14, 0.46), vec3(0.1, 0.45, 0.22), smoothstep(0.25, 0.9, featherFacing));
    diffuseColor.rgb = mix(diffuseColor.rgb, iridescent, featherSheen * 0.85);
    // 輪郭では羽の縁の毛羽立ちが光を拾って、ふんわり明るく見える
    diffuseColor.rgb += feather.b * pow(1.0 - featherFacing, 2.0) * 0.12 * featherFine;
  }`
        );
  };
  material.customProgramCacheKey = () => `pigeon-feather-${side}`;
  return material;
};

// ----- 鳩 1 羽の状態 -----

type PigeonState = "ground" | "flying" | "gone";
type GroundAction = "peck" | "walk" | "look";

interface Pigeon {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  /** 群れの中心（歩いて離れすぎたら戻る） */
  home: THREE.Vector3;
  yaw: number;
  pitch: number;
  roll: number;
  state: PigeonState;
  /** 先頭の馬がこの x を越えたら飛び立つ */
  triggerX: number;
  /** 気づいてから飛び立つまでの遅れ（秒） */
  delay: number;
  alarmed: boolean;
  /** 飛び立ってからの秒数 */
  airTime: number;
  flapPhase: number;
  action: GroundAction;
  actionTime: number;
  actionLength: number;
  headPitch: number;
  headShift: number;
  seed: number;
}

/** 種から決まる乱数（mulberry32）。群れの並びをレースごとに変えつつ、同じ種なら同じにする */
const seededRandom = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export class Pigeons {
  readonly group = new THREE.Group();
  private readonly meshes = new Map<PartName, THREE.InstancedMesh[]>();
  private readonly materials: THREE.Material[] = [];
  private readonly detail = createPigeonFeatherDetail();
  private pigeons: Pigeon[] = [];
  private raceSeed = 1;
  private random = seededRandom(1);
  // 毎フレームの行列計算で使い回す
  private readonly base = new THREE.Matrix4();
  private readonly local = new THREE.Matrix4();
  private readonly out = new THREE.Matrix4();
  private readonly euler = new THREE.Euler(0, 0, 0, "YZX");
  private readonly quaternion = new THREE.Quaternion();
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  private readonly unit = new THREE.Vector3(1, 1, 1);

  constructor(private readonly model: PigeonModel) {
    const feather = createFeatherMaterial(this.detail, THREE.FrontSide);
    const featherBothSides = createFeatherMaterial(this.detail, THREE.DoubleSide);
    const plain = new Map<string, THREE.Material>();
    const materialFor = (name: PartName, part: ModelPart) => {
      if (part.materialName === "Feather") return DOUBLE_SIDED.has(name) ? featherBothSides : feather;
      const cached = plain.get(part.materialName);
      if (cached) return cached;
      // くちばし・目・脚も頂点カラーで塗ってある。目は濡れたように光る
      const created = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: part.materialName === "Eye" ? 0.15 : 0.55,
      });
      plain.set(part.materialName, created);
      this.materials.push(created);
      return created;
    };
    this.materials.push(feather, featherBothSides);
    for (const name of PART_NAMES) {
      const node = model.parts.get(name);
      if (!node) continue;
      const list = node.parts.map((part) => {
        const mesh = new THREE.InstancedMesh(part.geometry, materialFor(name, part), MAX_PIGEONS);
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        // 群れは走路のあちこちに散らばり、飛ぶと高く上がるので、まとめた境界球での視錐台カリングはしない
        mesh.frustumCulled = false;
        this.group.add(mesh);
        return mesh;
      });
      this.meshes.set(name, list);
    }
  }

  /**
   * レースの前に群れを置き直す。発走地点からゴールまでの 3 か所に、走路の上に降りた群れを置く
   * @param startX 発走地点
   */
  reset(startX: number) {
    this.raceSeed += 1;
    this.random = seededRandom(this.raceSeed * 7919);
    const random = this.random;
    this.pigeons = [];
    const course = FINISH_X - startX;
    for (let f = 0; f < FLOCKS; f += 1) {
      const center = new THREE.Vector3(startX + course * (0.3 + 0.25 * f) + (random() - 0.5) * 10, 0, (random() - 0.5) * 16);
      const count = 6 + Math.floor(random() * (MAX_PER_FLOCK - 5));
      for (let i = 0; i < count; i += 1) {
        // 群れの中心のまわりに、互いに少し離れて散らばる
        const angle = random() * Math.PI * 2;
        const radius = 0.4 + Math.sqrt(random()) * 2.2;
        const position = center.clone().add(new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius));
        this.pigeons.push({
          position,
          velocity: new THREE.Vector3(),
          home: center.clone(),
          yaw: random() * Math.PI * 2,
          pitch: 0,
          roll: 0,
          state: "ground",
          // 馬群が 100〜150m 手前に来たら気づく（群れの中でも気づく早さは鳩ごとに違う）
          triggerX: center.x - (17 + random() * 8),
          delay: random() * 0.35,
          alarmed: false,
          airTime: 0,
          flapPhase: random() * Math.PI * 2,
          action: "peck",
          actionTime: random() * 2,
          actionLength: 0.5 + random(),
          headPitch: 0,
          headShift: 0,
          seed: random(),
        });
      }
    }
    this.writeMatrices();
  }

  /**
   * @param dt 経過秒（スローモーション中は遅くなった時間）
   * @param leaderX 先頭の馬の x。レース中でなければ -Infinity（飛び立たない）
   */
  update(dt: number, leaderX: number) {
    for (const pigeon of this.pigeons) {
      if (pigeon.state === "gone") continue;
      if (pigeon.state === "ground") {
        if (!pigeon.alarmed && leaderX > pigeon.triggerX) pigeon.alarmed = true;
        if (pigeon.alarmed) {
          pigeon.delay -= dt;
          // 気づいた鳩は首を上げて身構える
          pigeon.headPitch += (0.25 - pigeon.headPitch) * (1 - Math.exp(-dt * 12));
          if (pigeon.delay <= 0) this.takeOff(pigeon);
        } else {
          this.updateGround(pigeon, dt);
        }
      } else {
        this.updateFlight(pigeon, dt);
      }
    }
    this.writeMatrices();
  }

  /** 地上: ついばむ・歩く・あたりを見回す、を順に繰り返す */
  private updateGround(pigeon: Pigeon, dt: number) {
    const random = this.random;
    pigeon.actionTime += dt;
    if (pigeon.actionTime > pigeon.actionLength) {
      pigeon.actionTime = 0;
      const roll = random();
      pigeon.action = roll < 0.5 ? "peck" : roll < 0.8 ? "walk" : "look";
      pigeon.actionLength = pigeon.action === "peck" ? 0.35 + random() * 0.25 : 0.8 + random() * 1.6;
      // 群れの中心から離れすぎたら、中心の方へ向き直る
      const away = pigeon.position.distanceTo(pigeon.home) > 2.6;
      if (away) {
        pigeon.yaw = Math.atan2(-(pigeon.home.z - pigeon.position.z), pigeon.home.x - pigeon.position.x);
      } else if (pigeon.action !== "peck") {
        pigeon.yaw += (random() - 0.5) * 1.6;
      }
    }
    const t = pigeon.actionTime / pigeon.actionLength;
    let targetPitch = 0;
    let shift = 0;
    switch (pigeon.action) {
      case "peck":
        // 素早く地面をつついて戻る
        targetPitch = -1.05 * Math.sin(Math.min(1, t) * Math.PI);
        break;
      case "walk": {
        // 鳩は一歩ごとに首を前後に振る（頭は空間に止まったまま、体が追いつく）
        const step = pigeon.actionTime * 4.2 + pigeon.seed * 6;
        shift = Math.sin(step * Math.PI * 2) * 0.025;
        targetPitch = -0.15;
        const speed = 0.32;
        pigeon.position.x += Math.cos(pigeon.yaw) * speed * dt;
        pigeon.position.z -= Math.sin(pigeon.yaw) * speed * dt;
        break;
      }
      case "look":
        targetPitch = 0.15 + Math.sin(pigeon.actionTime * 3 + pigeon.seed * 9) * 0.1;
        break;
    }
    pigeon.headPitch += (targetPitch - pigeon.headPitch) * (1 - Math.exp(-dt * 25));
    pigeon.headShift = shift;
  }

  /** 馬群と反対側の斜め前へ、走路の外に向かって飛び立つ */
  private takeOff(pigeon: Pigeon) {
    const random = this.random;
    pigeon.state = "flying";
    pigeon.airTime = 0;
    // 走路の中心より内馬場側にいる鳩は内馬場へ、スタンド側の鳩はスタンドの方へ逃げる（ときどき逆へ）
    const side = (pigeon.position.z >= 0 ? 1 : -1) * (random() < 0.85 ? 1 : -1);
    pigeon.velocity.set(1.5 + random() * 4, 4.5 + random() * 2, side * (3 + random() * 3));
    pigeon.headShift = 0;
  }

  private updateFlight(pigeon: Pigeon, dt: number) {
    pigeon.airTime += dt;
    const v = pigeon.velocity;
    // 飛び立ちは急上昇し、すぐに水平に近い上昇へ移る。水平の速さは秒速 9 ほどまで上げる
    v.y += (1.4 - v.y) * (1 - Math.exp(-dt * 1.1));
    const horizontal = Math.hypot(v.x, v.z);
    const target = 9;
    if (horizontal < target) {
      const gain = Math.min(target, horizontal + 5 * dt) / Math.max(horizontal, 1e-3);
      v.x *= gain;
      v.z *= gain;
    }
    pigeon.position.addScaledVector(v, dt);
    pigeon.yaw = Math.atan2(-v.z, v.x);
    pigeon.pitch = Math.atan2(v.y, Math.hypot(v.x, v.z)) * 0.8;
    // 羽ばたき: 飛び立ちは速く、上がりきったら少し遅く。ときどき滑空する
    const rate = pigeon.airTime < 1.2 ? 9 : 6.5;
    pigeon.flapPhase += dt * rate * Math.PI * 2;
    pigeon.roll = Math.sin(pigeon.airTime * 1.7 + pigeon.seed * 10) * 0.12;
    pigeon.headPitch += (-pigeon.pitch * 0.6 - pigeon.headPitch) * (1 - Math.exp(-dt * 8));
    if (pigeon.airTime > 7 || pigeon.position.y > 45) pigeon.state = "gone";
  }

  /** 羽ばたきの角度（上向きが正）。滑空中は翼を少し上げて止める */
  private flapAngle(pigeon: Pigeon) {
    const gliding = pigeon.airTime > 2.2 && Math.sin(pigeon.airTime * 0.9 + pigeon.seed * 7) > 0.55;
    return gliding ? 0.12 : 0.15 + Math.sin(pigeon.flapPhase) * 0.95;
  }

  private writeMatrices() {
    const { headJoint, shoulderLeft, shoulderRight, tailJoint } = this.model;
    for (let i = 0; i < MAX_PIGEONS; i += 1) {
      const pigeon = this.pigeons[i];
      const visible = pigeon !== undefined && pigeon.state !== "gone";
      if (!visible) {
        for (const name of PART_NAMES) this.setPart(name, i, this.hidden);
        continue;
      }
      const flying = pigeon.state === "flying";
      this.euler.set(pigeon.roll, pigeon.yaw, pigeon.pitch, "YZX");
      this.quaternion.setFromEuler(this.euler);
      this.base.compose(pigeon.position, this.quaternion, this.unit);

      this.setPart("PigeonBody", i, this.base);
      // 頭は首の付け根を中心に上下に振り、歩くときは前後にずらす
      this.local.makeRotationZ(pigeon.headPitch).setPosition(headJoint.x + pigeon.headShift, headJoint.y, headJoint.z);
      this.setPart("PigeonHead", i, this.out.multiplyMatrices(this.base, this.local));
      this.setPart("PigeonLegs", i, flying ? this.hidden : this.base);
      this.setPart("PigeonWingsFolded", i, flying ? this.hidden : this.base);
      this.setPart("PigeonTailFolded", i, flying ? this.hidden : this.base);
      if (!flying) {
        this.setPart("PigeonWingL", i, this.hidden);
        this.setPart("PigeonWingR", i, this.hidden);
        this.setPart("PigeonTailSpread", i, this.hidden);
        continue;
      }
      // 翼は肩を中心に体の軸（X）まわりに回す。左翼（+Z）は負の回転で上がり、右翼は正の回転で上がる
      const flap = this.flapAngle(pigeon);
      this.local.makeRotationX(-flap).setPosition(shoulderLeft);
      this.setPart("PigeonWingL", i, this.out.multiplyMatrices(this.base, this.local));
      this.local.makeRotationX(flap).setPosition(shoulderRight);
      this.setPart("PigeonWingR", i, this.out.multiplyMatrices(this.base, this.local));
      // 広げた尾は打ち下ろしに合わせて少し上下する
      this.local.makeRotationZ(-0.1 + Math.sin(pigeon.flapPhase + 1.2) * 0.08).setPosition(tailJoint);
      this.setPart("PigeonTailSpread", i, this.out.multiplyMatrices(this.base, this.local));
    }
    for (const list of this.meshes.values()) {
      for (const mesh of list) mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private setPart(name: PartName, index: number, matrix: THREE.Matrix4) {
    const list = this.meshes.get(name);
    if (!list) return;
    for (const mesh of list) mesh.setMatrixAt(index, matrix);
  }

  dispose() {
    for (const list of this.meshes.values()) list.forEach((mesh) => mesh.dispose());
    this.materials.forEach((material) => material.dispose());
    this.detail.dispose();
    for (const node of this.model.parts.values()) node.parts.forEach((part) => part.geometry.dispose());
  }
}
