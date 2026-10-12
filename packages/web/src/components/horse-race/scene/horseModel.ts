import * as THREE from "three";
import { createCoatMaterial, createCoatUniforms, type CoatMarking } from "./horseCoat";
import { createTailDepthMaterial, createTailGeometry, createTailMaterial, createTailUniforms } from "./horseTail";
import { createNameLabelTexture, createSilkTexture } from "./textures";
import { createZekkenTexture } from "./paddockTextures";

// プリミティブを組み合わせた手続き生成の競走馬 + 騎手。+X 方向を向く。

const COATS = [
  { body: "#6b3a1c", mane: "#1a0f0a" }, // 鹿毛
  { body: "#8f4a1f", mane: "#5a2a10" }, // 栗毛
  { body: "#3a2216", mane: "#120a06" }, // 黒鹿毛
  { body: "#1d1714", mane: "#0b0807" }, // 青毛
  { body: "#a39d94", mane: "#5d5852" }, // 芦毛
  { body: "#b88a4e", mane: "#e9dcc0" }, // 栃栗毛
];

const SILK_ACCENTS = ["#ffffff", "#111111", "#ffd23f", "#e53935", "#1e88e5", "#43a047"];
/** 芦毛（まだら模様をつける毛色） */
const GREY_COAT = 4;
const MARKINGS: CoatMarking[] = ["none", "star", "blaze"];

export interface HorseSpec {
  number: number;
  name: string;
  color: string;
  seed: number;
}

interface Leg {
  upper: THREE.Group;
  lower: THREE.Group;
  offset: number;
  front: boolean;
}

const cylinderAlongX = (rTop: number, rBottom: number, length: number, segments = 14) => {
  const geometry = new THREE.CylinderGeometry(rTop, rBottom, length, segments);
  geometry.rotateZ(-Math.PI / 2);
  geometry.translate(length / 2, 0, 0);
  return geometry;
};

const ellipsoid = (rx: number, ry: number, rz: number) => {
  const geometry = new THREE.SphereGeometry(1, 28, 20);
  geometry.scale(rx, ry, rz);
  return geometry;
};

/**
 * 走っているときの鼻先が、馬の中心（root）からどれだけ前にあるか（ワールド単位）。
 * 首の付け根 0.78 から、首（長さ 0.98、ギャロップの平均の角度 0.78rad）と、頭（首に対して −1.55rad）の鼻先まで 0.72 を足した長さ。
 * JRA の着順は鼻先（鼻端）が決勝線に達した順なので、レースの位置はこの鼻先の位置として描く
 */
export const HORSE_NOSE_REACH = 0.78 + 0.98 * Math.cos(0.78) + 0.72 * Math.cos(0.78 - 1.55);

/** これより遅いと並足で歩く（ワールド単位/秒） */
const WALK_MAX_SPEED = 4;
/** 並足の 1 完歩の長さ（約 1.7m） */
const WALK_STRIDE = 2.55;
/** 並足の脚を運ぶ順（legs の並び: 左後・右後・左前・右前） */
const WALK_LEG_OFFSET = [0, 0.5, 0.25, 0.75];

export class HorseModel {
  readonly root = new THREE.Group();
  readonly label: THREE.Sprite;
  private readonly body = new THREE.Group();
  private readonly neck = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly tail = new THREE.Group();
  /** 頂点シェーダーで揺らす尻尾（物理エンジンで動かすときは隠す） */
  private tailMesh: THREE.Mesh | null = null;
  /** 尻尾の毛の色（鬣と同じ） */
  readonly tailColor = new THREE.Color();
  private readonly jockey = new THREE.Group();
  /** 騎手の目（頭の中の、目の高さの少し前）。ジョッキー視点のカメラを置く */
  private readonly jockeyEye = new THREE.Object3D();
  /** 騎手の視線の先。ほぼ水平の少し下（馬の耳と首が画面の下の方に入り、前の馬群が見える） */
  private readonly jockeyGaze = new THREE.Object3D();
  private readonly legs: Leg[] = [];
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private phase: number;
  private idleTime = 0;
  private readonly coatUniforms = createCoatUniforms();
  private readonly tailUniforms = createTailUniforms();
  /** 汗のツヤ 0..1。走るほど増え、止まると引いていく */
  private sweat = 0;

  constructor(readonly spec: HorseSpec) {
    const coat = COATS[spec.seed % COATS.length];
    this.phase = (spec.seed % 628) / 100;

    const coatIndex = spec.seed % COATS.length;
    const coatOptions = { color: coat.body, roughness: 0.42, metalness: 0.05, dapple: coatIndex === GREY_COAT };
    // 胴・首・頭は馬の体の座標で模様を引いて部品の継ぎ目をなくし、大きく振れる脚は部品自身の座標で引く
    const coatMat = this.track(createCoatMaterial(this.coatUniforms, { ...coatOptions, space: "horse" }));
    const legCoatMat = this.track(createCoatMaterial(this.coatUniforms, { ...coatOptions, space: "part" }));
    // 顔の白斑（なし・星・流星）。流星のときは額の星もつける
    const marking = MARKINGS[(spec.seed >> 9) % MARKINGS.length];
    const faceMat =
      marking === "blaze"
        ? this.track(createCoatMaterial(this.coatUniforms, { ...coatOptions, space: "horse", marking: "blaze" }))
        : coatMat;
    const skullMat =
      marking === "none"
        ? coatMat
        : this.track(createCoatMaterial(this.coatUniforms, { ...coatOptions, space: "horse", marking: "star" }));
    const maneMat = this.track(
      new THREE.MeshStandardMaterial({ color: coat.mane, roughness: 0.8 })
    );
    const hoofMat = this.track(new THREE.MeshStandardMaterial({ color: "#1a1714", roughness: 0.6 }));
    const sockMat = this.track(new THREE.MeshStandardMaterial({ color: "#efe9df", roughness: 0.7 }));
    const leatherMat = this.track(new THREE.MeshStandardMaterial({ color: "#2b1a10", roughness: 0.5 }));
    const eyeMat = this.track(new THREE.MeshStandardMaterial({ color: "#050505", roughness: 0.2 }));
    const silkTex = this.track(
      createSilkTexture(spec.color, spec.seed >> 3, SILK_ACCENTS[(spec.seed >> 6) % SILK_ACCENTS.length])
    );
    const silkMat = this.track(
      new THREE.MeshStandardMaterial({ map: silkTex, roughness: 0.35, metalness: 0.1 })
    );
    const capMat = this.track(new THREE.MeshStandardMaterial({ color: spec.color, roughness: 0.3 }));
    const breechesMat = this.track(new THREE.MeshStandardMaterial({ color: "#f4f4f4", roughness: 0.6 }));
    const bootMat = this.track(new THREE.MeshStandardMaterial({ color: "#151515", roughness: 0.4 }));
    const skinMat = this.track(new THREE.MeshStandardMaterial({ color: "#e0b48f", roughness: 0.7 }));
    // ゼッケン（JRA と同じく馬番と馬名）。パドックでは騎手がいないので、鞍の下の布がよく見える
    const clothTex = this.track(createZekkenTexture(spec.number, spec.name, spec.color));
    const clothMat = this.track(
      new THREE.MeshStandardMaterial({ map: clothTex, roughness: 0.8, side: THREE.DoubleSide })
    );

    const mesh = (geometry: THREE.BufferGeometry, material: THREE.Material) => {
      this.track(geometry);
      const m = new THREE.Mesh(geometry, material);
      m.castShadow = true;
      m.receiveShadow = true;
      return m;
    };

    // ----- 胴体 -----
    this.root.add(this.body);
    const torso = mesh(ellipsoid(0.95, 0.46, 0.4), coatMat);
    torso.position.set(0, 1.38, 0);
    const chest = mesh(ellipsoid(0.5, 0.5, 0.41), coatMat);
    chest.position.set(0.55, 1.36, 0);
    const rump = mesh(ellipsoid(0.52, 0.5, 0.43), coatMat);
    rump.position.set(-0.58, 1.44, 0);
    const belly = mesh(ellipsoid(0.7, 0.3, 0.3), coatMat);
    belly.position.set(0, 1.18, 0);
    this.body.add(torso, chest, rump, belly);

    // ----- 首・頭 -----
    this.neck.position.set(0.78, 1.58, 0);
    this.neck.rotation.z = 0.82;
    this.body.add(this.neck);
    const neckMesh = mesh(cylinderAlongX(0.17, 0.3, 1.0), coatMat);
    neckMesh.scale.set(1, 1, 0.75);
    const mane = mesh(new THREE.BoxGeometry(0.95, 0.07, 0.06), maneMat);
    mane.position.set(0.5, 0.2, 0);
    mane.rotation.z = -0.08;
    this.neck.add(neckMesh, mane);

    this.head.position.set(0.98, 0, 0);
    this.head.rotation.z = -1.6;
    this.neck.add(this.head);
    const skull = mesh(ellipsoid(0.2, 0.14, 0.12), skullMat);
    skull.position.set(0.12, 0, 0);
    const face = mesh(cylinderAlongX(0.085, 0.13, 0.42), faceMat);
    face.position.set(0.2, -0.02, 0);
    const muzzle = mesh(ellipsoid(0.1, 0.09, 0.085), maneMat);
    muzzle.position.set(0.62, -0.03, 0);
    this.head.add(skull, face, muzzle);
    for (const side of [-1, 1]) {
      const ear = mesh(new THREE.ConeGeometry(0.035, 0.14, 8), coatMat);
      ear.position.set(0.0, 0.14, side * 0.06);
      ear.rotation.z = 0.35;
      const eye = mesh(new THREE.SphereGeometry(0.028, 10, 8), eyeMat);
      eye.position.set(0.16, 0.05, side * 0.105);
      // ブリンカー（騎手の勝負服と同色）
      const blinker = mesh(new THREE.BoxGeometry(0.1, 0.07, 0.015), capMat);
      blinker.position.set(0.16, 0.06, side * 0.125);
      this.head.add(ear, eye, blinker);
    }

    // ----- 尻尾 -----
    this.tail.position.set(-1.02, 1.6, 0);
    this.tail.rotation.z = 0.9;
    this.body.add(this.tail);
    // 尻尾は毛の房を束ねた形で、なびきは頂点シェーダー（horseTail.ts）で動かす
    const tailMesh = mesh(createTailGeometry(spec.seed), this.track(createTailMaterial(coat.mane, this.tailUniforms)));
    tailMesh.customDepthMaterial = this.track(createTailDepthMaterial(this.tailUniforms));
    this.tail.add(tailMesh);
    this.tailMesh = tailMesh;
    this.tailColor.set(coat.mane);

    // ----- 脚 -----
    const socks = (spec.seed >> 4) % 4; // 0..3 本の白ソックス
    const legDefs: Array<[number, number, number, boolean]> = [
      [-0.62, -0.2, 0.0, false], // 左後
      [-0.62, 0.2, 0.1, false], // 右後
      [0.6, -0.19, 0.45, true], // 左前
      [0.6, 0.19, 0.55, true], // 右前
    ];
    legDefs.forEach(([x, z, offset, front], i) => {
      const upper = new THREE.Group();
      upper.position.set(x, 1.22, z);
      const upperMesh = mesh(
        new THREE.CylinderGeometry(front ? 0.1 : 0.13, 0.065, 0.58, 12),
        legCoatMat
      );
      upperMesh.position.y = -0.29;
      upper.add(upperMesh);
      const lower = new THREE.Group();
      lower.position.y = -0.56;
      upper.add(lower);
      const lowerMesh = mesh(
        new THREE.CylinderGeometry(0.055, 0.05, 0.52, 10),
        i < socks ? sockMat : legCoatMat
      );
      lowerMesh.position.y = -0.26;
      const hoof = mesh(new THREE.CylinderGeometry(0.065, 0.08, 0.1, 10), hoofMat);
      hoof.position.y = -0.56;
      lower.add(lowerMesh, hoof);
      this.body.add(upper);
      this.legs.push({ upper, lower, offset, front });
    });

    // ----- 鞍・ゼッケン -----
    const saddle = mesh(new THREE.BoxGeometry(0.5, 0.07, 0.46), leatherMat);
    saddle.position.set(-0.02, 1.81, 0);
    this.body.add(saddle);
    for (const side of [-1, 1]) {
      const cloth = mesh(new THREE.PlaneGeometry(0.62, 0.42), clothMat);
      cloth.position.set(-0.05, 1.56, side * 0.415);
      if (side < 0) cloth.rotation.y = Math.PI;
      this.body.add(cloth);
    }

    // ----- 騎手 -----
    this.jockey.position.set(0.02, 1.86, 0);
    this.body.add(this.jockey);
    const torsoJ = mesh(new THREE.CapsuleGeometry(0.16, 0.34, 6, 14), silkMat);
    torsoJ.rotation.z = -1.15;
    torsoJ.position.set(0.2, 0.34, 0);
    const headJ = mesh(new THREE.SphereGeometry(0.12, 16, 12), skinMat);
    // 前傾した騎手も、頭は首を起こして鞍から 0.6m ほど上にある（馬の耳越しに前を見る）
    headJ.position.set(0.5, 0.66, 0);
    const cap = mesh(
      new THREE.SphereGeometry(0.135, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2),
      capMat
    );
    cap.position.set(0.5, 0.68, 0);
    cap.rotation.z = -0.4;
    this.jockey.add(torsoJ, headJ, cap);
    // 目と視線の先は騎手の体に付けておき、騎手の上下動・前後の揺れ・前傾ごと動かす
    this.jockeyEye.position.set(0.59, 0.69, 0);
    this.jockeyGaze.position.set(12.6, -0.7, 0);
    this.jockey.add(this.jockeyEye, this.jockeyGaze);
    for (const side of [-1, 1]) {
      const thigh = mesh(cylinderAlongX(0.075, 0.09, 0.42), breechesMat);
      thigh.position.set(-0.02, 0.18, side * 0.17);
      thigh.rotation.z = -0.5;
      const shin = mesh(new THREE.CylinderGeometry(0.06, 0.055, 0.42, 10), bootMat);
      shin.position.set(0.3, -0.08, side * 0.24);
      shin.rotation.z = 0.5;
      const arm = mesh(cylinderAlongX(0.05, 0.06, 0.5), silkMat);
      arm.position.set(0.34, 0.42, side * 0.17);
      arm.rotation.z = -0.75;
      arm.rotation.y = side * 0.25;
      this.jockey.add(thigh, shin, arm);
    }

    // ----- 馬名ラベル -----
    const labelTex = this.track(createNameLabelTexture(spec.number, spec.name, spec.color));
    const labelMat = this.track(
      new THREE.SpriteMaterial({ map: labelTex, depthTest: false, transparent: true })
    );
    this.label = new THREE.Sprite(labelMat);
    this.label.scale.set(2.6, 0.57, 1);
    this.label.position.set(0, 3.05, 0);
    this.label.renderOrder = 10;
    // ターフビジョンの中継映像には映さない（シーンのカメラだけがレイヤー 1 を映す）
    this.label.layers.set(1);
    this.root.add(this.label);
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  /**
   * @param dt 経過秒
   * @param speed 前進速度（ワールド単位/秒）
   * @param effort 追い込み具合 0..1（騎手のアクション）
   */
  update(dt: number, speed: number, effort = 0) {
    const s = Math.min(1, Math.max(0, speed / 16));
    this.idleTime += dt;
    // 追い込むほど早く汗をかく
    this.sweat = s < 0.02 ? Math.max(0, this.sweat - dt * 0.05) : Math.min(1, this.sweat + dt * 0.04 * s * (0.4 + effort));
    this.coatUniforms.uSweat.value = this.sweat;
    // 尻尾のなびきは速さに急に追従させず、なめらかに寄せる
    this.tailUniforms.uTailTime.value = this.idleTime;
    this.tailUniforms.uTailSpeed.value += (s - this.tailUniforms.uTailSpeed.value) * (1 - Math.exp(-dt * 3));

    // パドックを引かれて歩く速さ（並足）。ギャロップとは脚の運びが違う
    const isWalking = speed > 0.05 && speed < WALK_MAX_SPEED;
    if (isWalking) {
      this.walk(dt, speed);
      return;
    }

    if (s < 0.02) {
      // 待機中: 呼吸と首振り
      const breathe = Math.sin(this.idleTime * 2 + this.phase) * 0.015;
      this.body.position.y = breathe;
      this.body.rotation.z = 0;
      this.neck.rotation.z = 0.95 + Math.sin(this.idleTime * 0.9 + this.phase) * 0.06;
      this.head.rotation.z = -1.65;
      this.tail.rotation.z = 1.2 + Math.sin(this.idleTime * 1.3 + this.phase) * 0.08;
      this.tail.rotation.y = Math.sin(this.idleTime * 0.7 + this.phase) * 0.2;
      for (const leg of this.legs) {
        leg.upper.rotation.z = 0;
        leg.lower.rotation.z = 0;
      }
      this.jockey.position.y = 1.86;
      this.jockey.rotation.z = 0.25;
      return;
    }

    // 回転襲歩（ギャロップ）: 速いほど歩幅とピッチが上がる
    this.phase += dt * Math.PI * 2 * (1.2 + 1.3 * s);
    const p = this.phase;
    const amp = 0.25 + 0.55 * s;
    for (const leg of this.legs) {
      const local = p - leg.offset * Math.PI * 2;
      leg.upper.rotation.z = Math.sin(local) * amp * (leg.front ? 1 : 0.85);
      const bend = Math.max(0, Math.sin(local - 1.3)) * (0.4 + 1.0 * s);
      leg.lower.rotation.z = leg.front ? -bend : bend * 0.8;
    }
    this.body.position.y = Math.sin(p * 1 + 0.6) * 0.07 * s + 0.02;
    this.body.rotation.z = Math.sin(p + 2.1) * 0.05 * s;
    this.neck.rotation.z = 0.78 + Math.sin(p + 1.0) * 0.13 * s;
    this.head.rotation.z = -1.55 + Math.sin(p + 1.8) * 0.08 * s;
    this.tail.rotation.z = 0.55 + Math.sin(p * 0.5) * 0.15;
    this.tail.rotation.y = Math.sin(p * 0.37) * 0.15;
    // 騎手は前傾。追い込み時は大きく押す
    const push = (0.04 + 0.08 * effort) * s;
    this.jockey.position.y = 1.86 - Math.sin(p + 0.6) * push;
    this.jockey.position.x = 0.02 + Math.sin(p + 2.2) * push * 0.8;
    this.jockey.rotation.z = -0.05 + Math.sin(p + 1.6) * 0.05 * effort;
  }

  /**
   * 並足（常歩）。左後 → 左前 → 右後 → 右前 の順に 1/4 ずつずれて脚を運ぶ 4 拍子の歩き方で、
   * 首は 1 歩ごとに上下に振る（1 完歩で 2 回）。歩幅は約 1.7m（2.55 単位）
   */
  private walk(dt: number, speed: number) {
    this.phase += (dt * Math.PI * 2 * speed) / WALK_STRIDE;
    const p = this.phase;
    for (const leg of this.legs) {
      const local = p - WALK_LEG_OFFSET[this.legs.indexOf(leg)] * Math.PI * 2;
      leg.upper.rotation.z = Math.sin(local) * 0.3 * (leg.front ? 1 : 0.85);
      // 脚を前へ運ぶ間だけ膝（前脚）・飛節（後ろ脚）を曲げる
      const bend = Math.max(0, Math.sin(local + 0.4)) * 0.55;
      leg.lower.rotation.z = leg.front ? -bend : bend * 0.8;
    }
    this.body.position.y = Math.sin(p * 2) * 0.012;
    this.body.rotation.z = 0;
    this.neck.rotation.z = 0.92 + Math.sin(p * 2 + 0.8) * 0.05;
    this.head.rotation.z = -1.62 + Math.sin(p * 2 + 1.4) * 0.03;
    this.tail.rotation.z = 1.15 + Math.sin(p) * 0.05;
    this.tail.rotation.y = Math.sin(p * 0.5 + this.idleTime * 0.3) * 0.15;
  }

  /** 騎手を乗せる / 降ろす（パドックでは騎乗合図まで鞍だけ） */
  setJockeyVisible(visible: boolean) {
    this.jockey.visible = visible;
  }

  /** 引き手綱をつなぐ頭絡の位置（ワールド座標） */
  bridlePosition(out: THREE.Vector3) {
    return this.head.localToWorld(out.set(0.12, -0.1, 0));
  }

  /**
   * 物理エンジンで尻尾を動かすときに読む部品。尻尾の付け根（-X が尻尾の伸びる向き）・胴・後ろ脚の上下。
   * どれもワールド行列を読むだけで、物理の側からは動かさない
   */
  get physicsParts() {
    return {
      tail: this.tail as THREE.Object3D,
      body: this.body as THREE.Object3D,
      hindLegs: this.legs.filter((leg) => !leg.front).map((leg) => ({ upper: leg.upper, lower: leg.lower })),
    };
  }

  /** 走る速さ 0..1（なめらかにした値。尻尾の空気の乱れの強さに使う） */
  get gallop() {
    return this.tailUniforms.uTailSpeed.value;
  }

  /** 物理エンジンで動かす尻尾に切り替えたら、頂点シェーダーで揺らす尻尾を隠す */
  setTailSimulated(simulated: boolean) {
    if (this.tailMesh) this.tailMesh.visible = !simulated;
  }

  /**
   * ジョッキー視点のカメラの位置と注視点（ワールド座標）。
   * カメラは騎手の頭の中にあるが、頭と帽子の球は外向きの面しか描かないので、内側からは見えない
   */
  jockeyView(eye: THREE.Vector3, target: THREE.Vector3) {
    this.jockeyEye.getWorldPosition(eye);
    this.jockeyGaze.getWorldPosition(target);
  }

  /** 毛並みの模様を体に貼りつけるため、描画直前（行列の更新後）に呼ぶ */
  syncCoatSpace() {
    this.coatUniforms.uRootInverse.value.copy(this.root.matrixWorld).invert();
  }

  /** 後脚の蹄のワールド座標（土煙用） */
  hindHoofWorld(target: THREE.Vector3) {
    return target.set(this.root.position.x - 0.7, 0.05, this.root.position.z);
  }

  dispose() {
    for (const item of this.disposables) item.dispose();
  }
}
