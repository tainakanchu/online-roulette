import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { takeNode, type ModelPart } from "./models";

// ニュースのキャスター。Blender で作った glb（news-anchors.glb）の部品を組み立て、
// 話す口の動き・まばたき・うなずき・顔の向きをコードで動かす（ボーンやシェイプキーは使わない）。
//   <接頭辞>Body: 胴・腕・脚。原点は座る位置の床
//   <接頭辞>Head: 首から上。原点は首の回転の中心（Body の extras の head_joint）
//   <接頭辞>Mouth: 開いた口の中。原点は口の中心。Y 方向の拡大で口を開け閉めする
//   <接頭辞>Lids: 閉じたまぶた。表示している間がまばたき

export type AnchorRole = "main" | "sub";

/** 座面の高さ（ステージの上面 0.08 + 座面 0.48） */
const SEAT_HEIGHT = 0.56;

const PREFIX: Record<AnchorRole, string> = { main: "AnchorM_", sub: "AnchorF_" };

/** 決定的な乱数（キャスターごとにしゃべりの癖とまばたきの間隔を変える） */
const createRandom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const readJoint = (gltf: GLTF, bodyName: string, key: string): THREE.Vector3 | null => {
  const body = gltf.scene.getObjectByName(bodyName);
  const value = body?.userData?.[key] as unknown;
  const isPoint = Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === "number");
  return isPoint ? new THREE.Vector3(value[0], value[1], value[2]) : null;
};

export class NewsAnchor {
  readonly group = new THREE.Group();
  /** 首の回転の中心。頭・口・まぶたはこの下にぶら下げる */
  private readonly head = new THREE.Group();
  private readonly mouth = new THREE.Group();
  private readonly lids = new THREE.Group();
  private readonly body = new THREE.Group();
  /** お辞儀で上体を前へ傾ける支点（座面の高さ） */
  private readonly lean = new THREE.Group();
  /** お辞儀を始めた時刻（しないときは -Infinity） */
  private bowStart = -Infinity;
  private readonly random: () => number;
  private speaking = false;
  /** 口の開き 0..1 */
  private open = 0;
  private syllablePhase = 0;
  private syllableRate = 7;
  private syllableAmp = 0.8;
  private pauseUntil = 0;
  private nextBlinkAt = 1.5;
  private blinkUntil = 0;
  /** 顔を向けたい方向（ラジアン。+ は自分から見て左 = 画面の右） */
  private targetYaw = 0;
  private yaw = 0;
  private nod = 0;
  private nodVelocity = 0;
  private time = 0;

  constructor(
    gltf: GLTF,
    readonly role: AnchorRole,
    material: (part: ModelPart) => THREE.Material
  ) {
    const prefix = PREFIX[role];
    this.random = createRandom(role === "main" ? 7 : 19);
    this.syllableRate = role === "main" ? 6.6 : 7.4;

    // 部品を親に足し、部品の原点（ワールド座標）を返す。ジオメトリは部品の原点を基準にしている
    const addPart = (name: string, parent: THREE.Object3D) => {
      const node = takeNode(gltf, `${prefix}${name}`);
      if (!node) return null;
      for (const part of node.parts) {
        const mesh = new THREE.Mesh(part.geometry, material(part));
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        parent.add(mesh);
      }
      return node.origin;
    };

    const bodyOrigin = addPart("Body", this.body) ?? new THREE.Vector3();
    this.group.position.copy(bodyOrigin);
    // 体は座面の高さを支点にして傾ける（床を支点にすると脚まで傾く）
    this.lean.position.y = SEAT_HEIGHT;
    this.body.position.y = -SEAT_HEIGHT;
    this.lean.add(this.body);
    this.group.add(this.lean);
    // 首の回転の中心は Head の原点（無ければ extras の head_joint）
    const headOrigin =
      addPart("Head", this.head) ??
      readJoint(gltf, `${prefix}Body`, "head_joint") ??
      bodyOrigin.clone().add(new THREE.Vector3(0, 1.1, 0));
    this.head.position.copy(headOrigin).sub(bodyOrigin);
    this.body.add(this.head);
    // 口とまぶたは頭と一緒に回すので、頭の下に、首の回転の中心からの位置で置く
    for (const [name, group] of [
      ["Mouth", this.mouth],
      ["Lids", this.lids],
    ] as const) {
      const origin = addPart(name, group);
      if (!origin) continue;
      group.position.copy(origin).sub(headOrigin);
      this.head.add(group);
    }
    this.mouth.scale.y = 0.001;
    this.mouth.visible = false;
    this.lids.visible = false;
  }

  /** 話し始める / 話し終える。話し始めにうなずく */
  setSpeaking(speaking: boolean) {
    if (speaking && !this.speaking) {
      this.nodVelocity += 0.5;
      this.pauseUntil = this.time + 0.12;
    }
    this.speaking = speaking;
  }

  /** 番組の終わりのお辞儀（頭を下げ、上体を少し前へ倒し、ひと呼吸おいて戻す） */
  bow() {
    this.bowStart = this.time;
  }

  /** 顔を向ける方向（ラジアン）。0 で正面のカメラ */
  setLook(yaw: number) {
    this.targetYaw = yaw;
  }

  update(dt: number) {
    this.time += dt;
    this.updateMouth(dt);
    this.updateBlink();

    // うなずきは減衰するバネ。話している間は文の区切りで小さくうなずく
    this.nodVelocity += (-this.nod * 60 - this.nodVelocity * 9) * dt;
    this.nod += this.nodVelocity * dt;
    this.yaw += (this.targetYaw - this.yaw) * (1 - Math.exp(-dt * 3.5));
    const t = this.time;
    const idle = this.role === "main" ? 0 : 1.7;
    // 話している間は頭が少し動く。聞いている間はほとんど動かない
    const talk = this.speaking ? 1 : 0.35;
    this.head.rotation.set(
      this.nod * 0.12 + Math.sin(t * 1.9 + idle) * 0.012 * talk,
      this.yaw + Math.sin(t * 0.7 + idle) * 0.02 * talk,
      Math.sin(t * 0.53 + idle) * 0.012,
      "YXZ"
    );
    // お辞儀: 0.5 秒で下げ、0.5 秒止めて、0.7 秒で戻す
    const b = t - this.bowStart;
    const bow = b < 0 ? 0 : b < 0.5 ? Math.sin((b / 0.5) * Math.PI * 0.5) : b < 1 ? 1 : b < 1.7 ? 0.5 + 0.5 * Math.cos(((b - 1) / 0.7) * Math.PI) : 0;
    this.head.rotation.x += bow * 0.38;
    // 上体の傾きは、デスクに置いた手が天板に沈まないよう小さく
    this.lean.rotation.x = bow * 0.05;
    // 呼吸で胸がわずかに上下する
    this.body.scale.y = 1 + Math.sin(t * 1.6 + idle) * 0.0025;
  }

  /**
   * 口の動き。1 音節ごとに開いて閉じ、音節ごとに開きの大きさを変え、ときどき息継ぎで止まる
   */
  private updateMouth(dt: number) {
    let target = 0;
    if (this.speaking && this.time >= this.pauseUntil) {
      this.syllablePhase += dt * this.syllableRate;
      if (this.syllablePhase >= 1) {
        this.syllablePhase -= 1;
        this.syllableAmp = 0.35 + this.random() * 0.65;
        // 息継ぎ（読点・句点）
        if (this.random() < 0.1) {
          this.pauseUntil = this.time + 0.18 + this.random() * 0.25;
          this.nodVelocity += 0.25;
        }
      }
      target = this.syllableAmp * Math.pow(Math.sin(this.syllablePhase * Math.PI), 0.8);
    }
    this.open += (target - this.open) * (1 - Math.exp(-dt * 28));
    this.mouth.visible = this.open > 0.03;
    this.mouth.scale.y = Math.max(0.001, this.open);
  }

  private updateBlink() {
    if (this.time >= this.nextBlinkAt) {
      this.blinkUntil = this.time + 0.13;
      // ときどき 2 回続けてまばたきする
      const twice = this.random() < 0.15;
      this.nextBlinkAt = this.time + (twice ? 0.28 : 2.2 + this.random() * 3.2);
    }
    this.lids.visible = this.time < this.blinkUntil;
  }

  dispose() {
    this.group.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
  }
}
