import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  aheadDistance,
  canMerge,
  followSpeeds,
  formatWeightChange,
  lapLength,
  paddockGap,
  sOnUpperStraight,
  stadiumPoint,
  stepRing,
  type RingOptions,
  type StadiumShape,
} from "../../../utils/paddock";
import { createFoliageMaterial } from "./courseExtras";
import { PADDOCK_AREA } from "./environment";
import type { HorseModel } from "./horseModel";
import { loadModel, takeNode, type ModelPart } from "./models";
import { createRustyMetalMaterial } from "./rust";
import { addDetail } from "./newsMaterials";
import {
  createArmbandDetail,
  createHelmetShellDetail,
  createLeadRopeDetail,
  createPiqueKnitDetail,
  createShoeLeatherDetail,
  createSlacksTwillDetail,
} from "./paddockGroomTextures";
import {
  createBuildingWallDetail,
  createCurbStoneDetail,
  createFlowerBedDetail,
  createPaddockLawnDetail,
  createRoofPanelDetail,
  createSoilDetail,
  createSteelFrameDetail,
  createTerraceConcreteDetail,
} from "./paddockSetTextures";
import {
  createPaddockBoardBackground,
  createPaddockLawnTexture,
  createPaddockSignTexture,
  createPaddockTrackDetail,
} from "./paddockTextures";
import { createCrowdMaterial } from "./stands";
import type { CourseUniforms } from "./surfaceCommon";

// パドック（下見所）。内馬場のターフビジョンの裏に置き、レース前は出走馬が厩務員に引かれて左回りで周回する。
// JRA のパドックと同じく、引き手は馬の左（周回の内側）を歩き、馬番の順に 1 列で回る。
// 参加者が増えると、その馬が装鞍所からの入口を通って入ってきて列に加わり、減ると入口から出ていく。
// セット（paddock.glb）と厩務員（paddock-groom.glb）は Blender で作り、材質・歩かせ方・掲示板の中身はここで付ける。

/** パドックの中心（内馬場のターフビジョンの裏。−Z の方に走路とスタンドがある） */
export const PADDOCK_CENTER = new THREE.Vector3(PADDOCK_AREA.x, 0, PADDOCK_AREA.z);

export interface PaddockModels {
  set: GLTF;
  groom: GLTF;
}

export const loadPaddockModels = (): Promise<PaddockModels> =>
  Promise.all([loadModel("paddock.glb"), loadModel("paddock-groom.glb")]).then(([set, groom]) => ({ set, groom }));

/** 掲示板とテロップに出す 1 頭分の情報 */
export interface PaddockEntry {
  number: number;
  name: string;
  color: string;
  /** 馬体重（kg） */
  weight: number;
  /** 前走からの増減（kg） */
  change: number;
  odds: number;
  popularity: number;
}

export interface PaddockBoardLabels {
  odds: (odds: number) => string;
}

/** 引かれて歩く速さ（ワールド単位/秒。人の歩く速さ 1.5m/s ほど） */
const WALK_SPEED = 2.2;
/** 人の 1 歩（ワールド単位） */
const GROOM_STEP = 1.05;
/** 引き手が歩く所。馬の中心から左（周回の内側）へ、少し前（肩の横） */
const GROOM_SIDE = 1.15;
const GROOM_AHEAD = 0.75;
/** 入口の通路（周回路から装鞍所の門まで）の長さ */
const ENTRANCE_LENGTH = 27;
/** 地下馬道の出口の通路（周回路の −X の端から外へ）の長さ */
const EXIT_LENGTH = 21;
/** 出入りのときに向きを変える区間（通路の周回路寄りの端） */
const TURN_LENGTH = 4;
/** これより前の馬に近づかない（馬 1 頭の長さに、前を歩く引き手の分と少しのゆとり） */
const MIN_GAP = 5;
/** 入ってくる馬は、周回路の手前（手すりの切れ目の外）で、列に空きができるのを待つ */
const WAIT_LANE = 4.5;

type WalkerState = "entering" | "circling" | "leaving" | "stopped";

/** 引き手（厩務員）。体・左右の脚・振る腕を部品ごとに動かす */
class Groom {
  readonly group = new THREE.Group();
  readonly legL = new THREE.Group();
  readonly legR = new THREE.Group();
  readonly arm = new THREE.Group();
  /** 綱を握る手（group の中の位置） */
  readonly hand = new THREE.Vector3();
  private stride = 0;

  constructor(parts: GroomParts) {
    for (const mesh of parts.body) this.group.add(mesh.clone());
    for (const [pivot, part] of [
      [this.legL, parts.legL],
      [this.legR, parts.legR],
      [this.arm, parts.arm],
    ] as const) {
      if (!part) continue;
      pivot.position.copy(part.origin);
      for (const mesh of part.meshes) pivot.add(mesh.clone());
      this.group.add(pivot);
    }
    this.hand.copy(parts.hand);
  }

  /** 歩いた距離だけ脚と腕を振る（止まっていれば揃える） */
  walk(distance: number, moving: boolean, dt: number) {
    this.stride += distance / GROOM_STEP;
    const target = moving ? 1 : 0;
    const swing = Math.sin(this.stride * Math.PI);
    const amount = THREE.MathUtils.lerp(this.legL.userData.amount ?? 0, target, 1 - Math.exp(-dt * 6));
    this.legL.userData.amount = amount;
    this.legL.rotation.z = swing * 0.42 * amount;
    this.legR.rotation.z = -swing * 0.42 * amount;
    this.arm.rotation.z = -swing * 0.32 * amount;
    this.group.position.y = Math.abs(Math.cos(this.stride * Math.PI)) * 0.03 * amount;
  }
}

interface GroomPartNode {
  meshes: THREE.Mesh[];
  origin: THREE.Vector3;
}

interface GroomParts {
  body: THREE.Mesh[];
  legL: GroomPartNode | null;
  legR: GroomPartNode | null;
  arm: GroomPartNode | null;
  hand: THREE.Vector3;
}

interface Walker {
  horse: HorseModel;
  groom: Groom;
  rope: THREE.Mesh;
  /** 周回路の上の位置（1 周ごとに増え続ける） */
  s: number;
  state: WalkerState;
  /** 入口の通路の上の位置（周回路側 0 〜 門 ENTRANCE_LENGTH） */
  lane: number;
  speed: number;
  onLeft: (() => void) | null;
}

export class Paddock {
  readonly group = new THREE.Group();
  /** 歩く馬以外（引き手・綱）。レース中は隠す */
  private readonly walkersGroup = new THREE.Group();
  private readonly shape: StadiumShape = { straightHalf: 27, radius: 18 };
  private entranceX = 22;
  private readonly materials = new Map<string, THREE.Material>();
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly grooms: GroomParts[] = [];
  private walkers: Walker[] = [];
  /** 先頭の馬の位置。列はここから間隔をあけて続く */
  private leadS = 10;
  private active = true;
  private readonly crowdUniforms = { uTime: { value: 0 }, uAmp: { value: 0.03 } };
  private readonly board: PaddockBoard;
  private readonly local = new THREE.Vector3();
  private readonly v = new THREE.Vector3();
  private readonly w = new THREE.Vector3();

  constructor(
    models: PaddockModels,
    private readonly uniforms: CourseUniforms,
    foliage: THREE.Data3DTexture | null
  ) {
    this.group.position.copy(PADDOCK_CENTER);
    this.readShape(models.set);
    this.board = this.track(new PaddockBoard(this.track(createPaddockBoardBackground())));
    this.buildSet(models.set, foliage);
    this.buildLawnLogo();
    this.buildCrowd();
    this.readGrooms(models.groom);
    this.group.add(this.walkersGroup);
  }

  /** 周回路の形（直線の半分・半径） */
  get stadium(): StadiumShape {
    return this.shape;
  }

  /** 掲示板に出す出走馬の情報 */
  setEntries(entries: PaddockEntry[], labels: PaddockBoardLabels) {
    this.board.draw(entries, labels);
  }

  /**
   * 出走馬を合わせる。新しい馬は装鞍所からの入口を通って入ってきて列に加わり（animateEntry が false ならすぐ列に並ぶ）、
   * いなくなった馬は地下馬道の出口から出ていく（出ていき終えたら onLeft を呼ぶ）。replaced は、馬番や色が変わって作り直した馬（古い馬の位置を引き継ぐ）
   */
  sync(
    horses: HorseModel[],
    options: { animateEntry: boolean; replaced: Map<HorseModel, HorseModel>; onLeft: (horse: HorseModel) => void }
  ) {
    const current = new Set(horses);
    for (const walker of this.walkers) {
      if (current.has(walker.horse) || walker.state === "leaving") continue;
      const isReplaced = [...options.replaced.values()].includes(walker.horse);
      if (isReplaced) continue;
      walker.state = "leaving";
      walker.onLeft = () => options.onLeft(walker.horse);
    }
    const known = new Map(this.walkers.map((walker) => [walker.horse, walker]));
    // まとめて増えたときは、馬番の順に通路に 1 列に並んで入ってくる（重ならないよう間隔をあけて、門の外から）
    let queueEnd = Math.max(
      ENTRANCE_LENGTH - MIN_GAP,
      ...this.walkers.filter((walker) => walker.state === "entering").map((walker) => walker.lane)
    );
    const ordered = horses.map((horse, i) => ({ horse, i })).sort((a, b) => a.horse.spec.number - b.horse.spec.number);
    ordered.forEach(({ horse, i }) => {
      if (known.has(horse)) return;
      const old = options.replaced.get(horse);
      const previous = old ? known.get(old) : undefined;
      if (previous) {
        // 同じ馬（名前が同じ）を作り直しただけ。位置と歩き方を引き継ぎ、古い馬の引き手と綱を使い回す
        previous.horse = horse;
        known.set(horse, previous);
        return;
      }
      const walker = this.createWalker(horse, i);
      if (options.animateEntry) {
        walker.state = "entering";
        queueEnd += MIN_GAP;
        walker.lane = queueEnd;
      } else {
        walker.s = this.leadS - this.order(horse, horses) * paddockGap(this.shape, horses.length);
      }
      this.walkers.push(walker);
      known.set(horse, walker);
    });
    // 作り直して使われなくなった古い馬の歩き手を消す（previous.horse を差し替え済み）
    this.walkers = this.walkers.filter((walker) => walker.state === "leaving" || current.has(walker.horse));
    this.placeAll(0);
  }

  /** 騎乗合図（止まーれー）。全馬その場で止まる */
  stopAll() {
    for (const walker of this.walkers) if (walker.state === "circling") walker.state = "stopped";
  }

  /**
   * パドックで周回させる / やめる。やめている間（レース中）は馬を動かさず、引き手と綱を隠す。
   * 再開したら、馬を列の位置に並べ直す（ゲートやゴールの先から戻す）
   */
  setActive(active: boolean) {
    this.active = active;
    this.walkersGroup.visible = active;
    if (!active) return;
    const circling = this.walkers.filter((walker) => walker.state !== "leaving");
    const gap = paddockGap(this.shape, circling.length);
    const horses = circling.map((walker) => walker.horse);
    for (const walker of circling) {
      walker.state = "circling";
      walker.s = this.leadS - this.order(walker.horse, horses) * gap;
      walker.horse.setJockeyVisible(false);
    }
    this.placeAll(0);
  }

  get isActive() {
    return this.active;
  }

  /** 馬の今の位置（ワールド座標）と向き。カメラが追うのに使う */
  horsePose(horse: HorseModel, position: THREE.Vector3) {
    position.copy(horse.root.position);
    return horse.root.rotation.y;
  }

  /** 入ってきている途中の馬のうち、いちばん周回路に近い馬（いなければ null） */
  get enteringHorse(): HorseModel | null {
    const entering = this.walkers.filter((walker) => walker.state === "entering").sort((a, b) => a.lane - b.lane);
    return entering[0]?.horse ?? null;
  }

  /** 入口の門（ワールド座標） */
  entranceGate(out: THREE.Vector3) {
    return out.set(this.entranceX, 0, this.shape.radius + ENTRANCE_LENGTH).add(PADDOCK_CENTER);
  }

  update(dt: number, time: number) {
    this.crowdUniforms.uTime.value = time;
    if (!this.active) return;
    this.leadS += WALK_SPEED * dt;
    this.placeAll(dt);
  }

  dispose() {
    this.group.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
    this.materials.forEach((material) => material.dispose());
    this.disposables.forEach((item) => item.dispose());
  }

  // ----- 内部 -----

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  /** 馬番の順で何番目か（列の先頭が 0） */
  private order(horse: HorseModel, horses: HorseModel[]) {
    const sorted = [...horses].sort((a, b) => a.spec.number - b.spec.number);
    return Math.max(0, sorted.indexOf(horse));
  }

  /** glb の extras から周回路の形を読む（無ければ既定の形） */
  private readShape(gltf: GLTF) {
    const node = gltf.scene.getObjectByName("Paddock_Track");
    const track = node?.userData?.track as { straight_half?: number; radius?: number } | undefined;
    if (typeof track?.straight_half === "number") this.shape.straightHalf = track.straight_half;
    if (typeof track?.radius === "number") this.shape.radius = track.radius;
    const entrance = node?.userData?.entrance as { x?: number } | undefined;
    if (typeof entrance?.x === "number") this.entranceX = entrance.x;
  }

  private createWalker(horse: HorseModel, index: number): Walker {
    const parts = this.grooms[index % Math.max(1, this.grooms.length)];
    const groom = parts ? new Groom(parts) : new Groom({ body: [], legL: null, legR: null, arm: null, hand: new THREE.Vector3() });
    this.walkersGroup.add(groom.group);
    // 引き手綱（手から頭絡へ、少したるませる）
    const rope = new THREE.Mesh(createRopeGeometry(), this.ropeMaterial());
    rope.frustumCulled = false;
    rope.castShadow = true;
    this.walkersGroup.add(rope);
    horse.setJockeyVisible(false);
    return { horse, groom, rope, s: this.leadS, state: "circling", lane: 0, speed: WALK_SPEED, onLeft: null };
  }

  /** 引き手綱（ナイロンの撚りロープ）。撚りの筋は 3D テクスチャ */
  private ropeMaterial() {
    let material = this.materials.get("rope");
    if (!material) {
      material = addDetail(new THREE.MeshStandardMaterial({ color: "#26324a", roughness: 0.6 }), {
        texture: this.texture("rope", createLeadRopeDetail),
        period: 0.12,
        space: "world",
        color: `diffuseColor.rgb *= (0.75 + 0.45 * detail.r) * (0.95 + 0.1 * detail.g);`,
        bump: 0.0008,
      });
      this.materials.set("rope", material);
    }
    return material;
  }

  /**
   * 全員を歩かせて置く。
   * - 周回路の馬は、すぐ前の馬との間隔で速さを決めて歩く（追い越さない・重ならない。utils/paddock.ts の followSpeeds）
   * - 入ってくる馬は、入口の通路に 1 列に並んで前の馬との間隔をあけて進み、周回路の手前で列に空きができるのを待って加わる
   * - 出ていく馬は、周回路の −X の端（地下馬道の出口）まで回ってから出ていく（入ってくる馬とすれ違わない）
   */
  private placeAll(dt: number) {
    const lap = lapLength(this.shape);
    const entryS = sOnUpperStraight(this.shape, this.entranceX);
    const exitS = 3 * this.shape.straightHalf + 1.5 * Math.PI * this.shape.radius;
    const onRing = this.walkers.filter((walker) => walker.state !== "entering" && walker.lane === 0);
    const entering = this.walkers
      .filter((walker) => walker.state === "entering")
      .sort((a, b) => a.lane - b.lane);
    const ring: RingOptions = {
      lap,
      gap: paddockGap(this.shape, onRing.length + entering.length),
      minGap: MIN_GAP,
      walkSpeed: WALK_SPEED,
    };

    // ----- 周回路 -----
    const positions = onRing.map((walker) => walker.s);
    const speeds = followSpeeds(positions, ring).map((speed, i) => (onRing[i].state === "stopped" ? 0 : speed));
    const next = stepRing(positions, speeds, dt, ring);
    onRing.forEach((walker, i) => {
      const before = walker.s;
      walker.s = next[i];
      const moved = dt > 0 ? (walker.s - before) / dt : 0;
      walker.speed += (moved - walker.speed) * (1 - Math.exp(-dt * 6));
      // 出ていく馬は地下馬道の出口の所で周回路を外れる
      const isPassingExit = walker.state === "leaving" && aheadDistance(before, exitS, lap) <= walker.s - before;
      if (isPassingExit) walker.lane = 0.001;
      const point = stadiumPoint(this.shape, walker.s);
      this.local.set(point.x, 0, point.z);
      this.placeWalker(walker, point.heading, dt);
    });

    // ----- 入口の通路（周回路に近い馬から） -----
    let aheadLane = -Infinity;
    for (const walker of entering) {
      // 前の馬（周回路寄り）に MIN_GAP より近づかず、先頭の馬は周回路の手前で待つ
      const stopLane = Math.max(aheadLane + MIN_GAP, 0);
      const isFirst = aheadLane === -Infinity;
      const mayMerge =
        isFirst &&
        walker.lane <= WAIT_LANE + 1e-3 &&
        canMerge(
          onRing.map((w) => w.s),
          entryS,
          lap,
          MIN_GAP + WAIT_LANE * 1.3,
          MIN_GAP
        );
      const limit = isFirst && !mayMerge ? Math.max(stopLane, WAIT_LANE) : stopLane;
      const before = walker.lane;
      walker.lane = Math.max(limit, walker.lane - WALK_SPEED * dt);
      const moved = dt > 0 ? (before - walker.lane) / dt : 0;
      walker.speed += (moved - walker.speed) * (1 - Math.exp(-dt * 6));
      aheadLane = walker.lane;
      if (walker.lane <= 0) {
        // 周回路に出た。ここから列の最後尾として歩く
        walker.state = "circling";
        walker.lane = 0;
        walker.s = entryS;
      }
      // 列が長いときは門の外（装鞍所の方）から並んで来る
      const lane = walker.lane;
      this.local.set(this.entranceX, 0, this.shape.radius + lane);
      // 周回路に近づいたら、周回の向き（+X）へ曲がる
      const turn = 1 - THREE.MathUtils.clamp(lane / TURN_LENGTH, 0, 1);
      this.placeWalker(walker, THREE.MathUtils.lerp(Math.PI / 2, 0, turn), dt);
    }

    // ----- 地下馬道の出口の通路 -----
    const finished: Walker[] = [];
    for (const walker of this.walkers) {
      if (walker.state !== "leaving" || walker.lane === 0) continue;
      walker.lane += WALK_SPEED * dt;
      walker.speed += (WALK_SPEED - walker.speed) * (1 - Math.exp(-dt * 6));
      const lane = Math.min(walker.lane, EXIT_LENGTH);
      this.local.set(-this.shape.straightHalf - this.shape.radius - lane, 0, 0);
      // 周回路の端では +Z へ進んでいるので、外（−X）へ曲がる
      const turn = 1 - THREE.MathUtils.clamp(lane / TURN_LENGTH, 0, 1);
      this.placeWalker(walker, THREE.MathUtils.lerp(Math.PI, Math.PI * 1.5, turn), dt);
      if (walker.lane >= EXIT_LENGTH) finished.push(walker);
    }
    for (const walker of finished) {
      this.walkers = this.walkers.filter((w) => w !== walker);
      this.walkersGroup.remove(walker.groom.group, walker.rope);
      walker.rope.geometry.dispose();
      walker.onLeft?.();
    }
  }

  /** 馬・引き手・綱を置く。local は周回路の座標（パドックの中心が原点） */
  private placeWalker(walker: Walker, heading: number, dt: number) {
    const { horse, groom, rope } = walker;
    horse.root.position.copy(this.local).add(PADDOCK_CENTER);
    horse.root.rotation.y = heading;
    horse.update(dt, walker.speed);
    // 引き手は馬の左（進む向きの左 = 周回の内側）、肩の横
    const forwardX = Math.cos(heading);
    const forwardZ = -Math.sin(heading);
    groom.group.position.set(
      this.local.x + forwardX * GROOM_AHEAD + forwardZ * GROOM_SIDE,
      groom.group.position.y,
      this.local.z + forwardZ * GROOM_AHEAD - forwardX * GROOM_SIDE
    );
    groom.group.rotation.y = heading;
    groom.walk(walker.speed * dt, walker.speed > 0.3, dt);
    // 綱: 手から頭絡へ、真ん中を少したるませる
    groom.group.updateMatrixWorld(true);
    const hand = this.v.copy(groom.hand).applyMatrix4(groom.group.matrix);
    horse.root.updateMatrixWorld(true);
    const bridle = horse.bridlePosition(this.w).sub(PADDOCK_CENTER);
    for (let i = 0; i < ROPE_POINTS; i += 1) {
      const t = i / (ROPE_POINTS - 1);
      ROPE_CENTERS[i].set(
        hand.x + (bridle.x - hand.x) * t,
        hand.y + (bridle.y - hand.y) * t - Math.sin(t * Math.PI) * 0.18,
        hand.z + (bridle.z - hand.z) * t
      );
    }
    updateRopeGeometry(rope.geometry, ROPE_CENTERS);
  }

  // ----- セット -----

  private buildSet(gltf: GLTF, foliage: THREE.Data3DTexture | null) {
    const signs: Record<string, THREE.Texture> = {
      JockeyRoomSign: this.track(createPaddockSignTexture("jockeyRoom")),
      SaddlingGateSign: this.track(createPaddockSignTexture("saddlingGate")),
    };
    for (const child of [...gltf.scene.children]) {
      const node = takeNode(gltf, child.name);
      if (!node) continue;
      for (const part of node.parts) {
        let material: THREE.Material;
        if (child.name === "PaddockBoardScreen") {
          material = this.board.material;
        } else if (signs[child.name]) {
          material = new THREE.MeshStandardMaterial({ map: signs[child.name], roughness: 0.5 });
          this.materials.set(`sign:${child.name}`, material);
        } else {
          material = this.material(part, foliage);
        }
        // glb はパドックの中心が原点の座標で作ってあるので、ノードの原点の位置にそのまま置く
        const mesh = new THREE.Mesh(part.geometry, material);
        mesh.position.copy(node.origin);
        mesh.receiveShadow = true;
        mesh.castShadow = !["PaddockTrack", "PaddockLawn", "Concrete", "Soil"].includes(part.materialName);
        this.group.add(mesh);
      }
    }
  }

  /**
   * セットの材質。どれもアセットごとの 3D テクスチャ（paddockSetTextures.ts）で、色の揺らぎ・汚れ・粗さ・凹凸を足す。
   * 屋外の舗装と段々は、馬場が渋る（雨の）日は競馬場と同じく濡れて暗く艶が出る
   */
  private material(part: ModelPart, foliage: THREE.Data3DTexture | null): THREE.Material {
    const name = part.materialName;
    let material = this.materials.get(name);
    if (material) return material;
    const color = part.color;
    const wet = { uniforms: { uWetness: this.uniforms.uWetness }, declarations: "uniform float uWetness;" };
    const standard = (params: THREE.MeshStandardMaterialParameters = {}) =>
      new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...params });
    switch (name) {
      case "PaddockTrack":
        // 赤茶のゴムチップ舗装。いつも馬が歩く所は擦れて少し明るい
        material = addDetail(standard({ roughness: 0.85 }), {
          texture: this.texture("track", createPaddockTrackDetail),
          period: 3,
          space: "world",
          color: `diffuseColor.rgb *= (0.75 + 0.5 * detail.r) * (0.92 + 0.16 * detail.g) * (1.0 - 0.25 * uWetness);`,
          roughness: `roughnessFactor = mix(clamp(detail.b + 0.15, 0.55, 1.0), 0.35, uWetness * 0.7);`,
          bump: 0.002,
          ...wet,
        });
        break;
      case "PaddockLawn":
        material = addDetail(standard({ roughness: 0.9 }), {
          texture: this.texture("lawn", createPaddockLawnDetail),
          period: 1.2,
          space: "world",
          color: `diffuseColor.rgb *= 0.8 + 0.4 * detail.r;
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.25, 1.1, 0.6), detail.g * 0.6);`,
          roughness: `roughnessFactor = clamp(0.85 + (detail.b - 0.5) * 0.2, 0.6, 1.0);`,
          bump: 0.002,
        });
        break;
      case "Hedge":
        material = foliage
          ? createFoliageMaterial(this.uniforms, foliage, `#${color.getHexString()}`)
          : standard({ roughness: 0.9 });
        break;
      case "FlowerBed":
        // 花の色は頂点カラー（Blender 側で付けた COLOR_0）
        material = addDetail(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }), {
          texture: this.texture("flower", createFlowerBedDetail),
          period: 0.5,
          space: "world",
          color: `diffuseColor.rgb *= (0.7 + 0.5 * detail.r) * (0.92 + 0.12 * detail.g);`,
          bump: 0.002,
        });
        break;
      case "Soil":
        material = addDetail(standard({ roughness: 0.95 }), {
          texture: this.texture("soil", createSoilDetail),
          period: 0.8,
          space: "world",
          color: `diffuseColor.rgb *= 0.75 + 0.5 * detail.r;
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.36, 0.28), detail.g * 0.5);
            diffuseColor.rgb *= 1.0 - 0.25 * max(detail.b, uWetness);`,
          roughness: `roughnessFactor = clamp(0.95 - max(detail.b, uWetness) * 0.5, 0.35, 1.0);`,
          bump: 0.003,
          ...wet,
        });
        break;
      case "RailWhite":
        // 白い塗装の手すり。コースのラチと同じ錆びの材質（塗装が剥げた所から錆が浮き、雨で錆が下へ垂れる）
        material = createRustyMetalMaterial({ paint: "#f4f4f0", rust: 0.22, scale: 1.4, roughness: 0.4, metalness: 0.1 });
        break;
      case "Concrete":
      case "ConcreteDark":
        // 観客の段々・通路・広場。雨だれの黒ずみと踏み跡、雨の日は濡れて暗く艶が出る
        material = addDetail(standard({ roughness: 0.9 }), {
          texture: this.texture("concrete", createTerraceConcreteDetail),
          period: 2.5,
          space: "world",
          // B は手すりの支柱や金具から流れて広がった錆のしみ。コンクリートに染みた錆は薄い茶色なので、控えめに混ぜる
          // （濃いオレンジで強く混ぜると、同じ形のしみが模様のように並んで見える）
          color: `diffuseColor.rgb *= (0.82 + 0.3 * detail.r) * (1.0 - 0.25 * detail.g);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.45, 0.32, 0.22), smoothstep(0.08, 0.8, detail.b) * 0.45);
            diffuseColor.rgb *= 1.0 - 0.3 * uWetness;`,
          roughness: `roughnessFactor = mix(roughnessFactor, 0.3, uWetness * 0.7);`,
          bump: 0.002,
          ...wet,
        });
        break;
      case "Curb":
        material = addDetail(standard({ roughness: 0.7 }), {
          texture: this.texture("curb", createCurbStoneDetail),
          period: 0.6,
          space: "world",
          // B は上面の角に溜まる土の汚れと点錆
          color: `diffuseColor.rgb *= 0.75 + 0.5 * detail.r;
            diffuseColor.rgb += vec3(0.08) * detail.g;
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.36, 0.25, 0.16), detail.b * 0.45);`,
          roughness: `roughnessFactor = clamp(0.65 + detail.b * 0.25, 0.3, 0.95);`,
          bump: 0.0015,
        });
        break;
      case "BuildingWall":
        // 騎手控え室の外壁パネル。目地と、上から垂れた雨だれの筋
        material = addDetail(standard({ roughness: 0.75 }), {
          texture: this.texture("wall", createBuildingWallDetail),
          period: 2,
          space: "world",
          // G は 0〜0.6 が灰色の雨だれ、0.6〜1 が窓枠や金具から垂れた錆の筋
          color: `diffuseColor.rgb *= (0.9 + 0.2 * detail.r) * (1.0 - 0.35 * detail.b);
            float wallGrime = smoothstep(0.05, 0.6, detail.g) * (1.0 - step(0.6, detail.g));
            float wallRust = smoothstep(0.6, 0.95, detail.g);
            diffuseColor.rgb *= 1.0 - 0.3 * wallGrime;
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.4, 0.24, 0.13), wallRust * 0.5);`,
          bump: 0.002,
        });
        break;
      case "BoardFrame":
      case "RoofSteel":
        // 掲示板の枠・柱・鉄骨。ボルトのまわりや下端に錆がにじむ
        material = addDetail(standard({ roughness: 0.5, metalness: 0.4 }), {
          texture: this.texture("steel", createSteelFrameDetail),
          period: 0.8,
          space: "world",
          // G は錆の量（0.5 で塗装の上ににじむ薄い錆、1 で塗装が剥げて浮いた錆）。
          // 垂れ筋（0.3〜0.6）は塗装に茶色い錆がにじむ程度、塊の芯（0.7〜1）は剥げて浮いた錆の色にする。
          // 錆色は茶色寄りにする（鮮やかなオレンジで塗りつぶすと、暗い塗装の上で斑点が浮いて見える）
          color: `float steelStain = smoothstep(0.08, 0.5, detail.g) * 0.45;
            float steelRust = smoothstep(0.5, 0.9, detail.g) * 0.9;
            vec3 steelRustColor = mix(vec3(0.4, 0.22, 0.11), vec3(0.24, 0.13, 0.07), detail.a);
            diffuseColor.rgb *= 0.88 + 0.24 * detail.r;
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.3, 0.19, 0.12), steelStain);
            diffuseColor.rgb = mix(diffuseColor.rgb, steelRustColor, steelRust);`,
          roughness: `roughnessFactor = mix(0.4, max(detail.b, 0.75), smoothstep(0.3, 0.9, detail.g));`,
          bump: 0.0015,
        });
        break;
      case "Roof":
        // 折板屋根。谷に汚れと苔が溜まる
        material = addDetail(standard({ roughness: 0.55, metalness: 0.3 }), {
          texture: this.texture("roof", createRoofPanelDetail),
          period: 3,
          space: "world",
          // G は谷に溜まる錆の帯と、山の釘まわりの点錆・苔
          color: `diffuseColor.rgb *= 0.8 + 0.35 * detail.r;
            diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.4, 0.24, 0.12), vec3(0.28, 0.3, 0.2), detail.r), smoothstep(0.3, 0.85, detail.g) * 0.7);`,
          roughness: `roughnessFactor = clamp(roughnessFactor + (detail.b - 0.5) * 0.3, 0.25, 0.9);`,
          bump: 0.01,
        });
        break;
      case "Glass":
        material = standard({ color: "#3a4a5a", roughness: 0.08, metalness: 0.6, transparent: true, opacity: 0.55 });
        break;
      case "Screen":
        material = this.board.material;
        break;
      default:
        material = standard({ roughness: 0.7 });
    }
    this.materials.set(name, material);
    return material;
  }

  private readonly detailTextures = new Map<string, THREE.Data3DTexture>();

  /** 3D テクスチャは最初に要ったときに 1 回だけ作り、同じ種類の材質で使い回す */
  private texture(key: string, create: () => THREE.Data3DTexture) {
    let texture = this.detailTextures.get(key);
    if (!texture) {
      texture = this.track(create());
      this.detailTextures.set(key, texture);
    }
    return texture;
  }

  /** 芝生の中央に、刈り込みの縞と競馬場のエンブレム */
  private buildLawnLogo() {
    const texture = this.track(createPaddockLawnTexture());
    texture.anisotropy = 8;
    const material = new THREE.MeshStandardMaterial({
      map: texture,
      roughness: 0.95,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.materials.set("lawnLogo", material);
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(40, 14), material);
    // 走路側（−Z）から見て文字が読めるよう、u を −X 向き、v = 1（文字の上）を奥（+Z）に向けて寝かせる
    plane.rotation.x = -Math.PI / 2;
    plane.rotation.z = Math.PI;
    plane.position.y = 0.06;
    plane.receiveShadow = true;
    this.group.add(plane);
  }

  /** 手前（走路側）の直線と −X 側の半円の段々に、パドックを見る観客を立たせる */
  private buildCrowd() {
    const { straightHalf: h, radius: r } = this.shape;
    const steps = 4;
    const stepDepth = 2;
    const stepRise = 0.45;
    const start = 6;
    const spots: THREE.Vector3[] = [];
    const random = mulberry32(2024);
    for (let k = 0; k < steps; k += 1) {
      const offset = r + start + (k + 0.5) * stepDepth;
      const y = (k + 1) * stepRise;
      // 手前の直線
      for (let x = -h; x <= h; x += 0.8) {
        if (random() < 0.5) spots.push(new THREE.Vector3(x + (random() - 0.5) * 0.3, y, -offset));
      }
      // −X 側の半円（地下馬道の出口の所はあける）
      const arc = Math.PI * offset;
      for (let d = 0; d < arc; d += 0.8) {
        const a = d / offset;
        const z = -Math.cos(a) * offset;
        const isExit = Math.abs(z) < 5;
        if (isExit || random() > 0.5) continue;
        spots.push(new THREE.Vector3(-h - Math.sin(a) * offset, y, z));
      }
    }
    const geometry = new THREE.CapsuleGeometry(0.17, 0.42, 3, 6);
    const material = createCrowdMaterial(this.crowdUniforms);
    this.materials.set("crowd", material);
    const crowd = new THREE.InstancedMesh(geometry, material, spots.length);
    const phases = new Float32Array(spots.length);
    const energies = new Float32Array(spots.length);
    const palette = ["#e53935", "#1e88e5", "#fdd835", "#43a047", "#fb8c00", "#ffffff", "#212121", "#8d6e63", "#90a4ae"];
    const matrix = new THREE.Matrix4();
    const color = new THREE.Color();
    // スタンドの観客（座っている）と同じ形を、立っている人の大きさに広げる（横には広げすぎず、人の体の幅に）
    const scale = new THREE.Vector3(2.1, 2.9, 2.1);
    spots.forEach((spot, i) => {
      matrix.compose(spot.clone().setY(spot.y + 1.1), new THREE.Quaternion(), scale);
      crowd.setMatrixAt(i, matrix);
      crowd.setColorAt(i, color.set(palette[Math.floor(random() * palette.length)]));
      phases[i] = random() * Math.PI * 2;
      // パドックの観客は静かに見ている
      energies[i] = 0.2 + random() * 0.4;
    });
    geometry.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phases, 1));
    geometry.setAttribute("aEnergy", new THREE.InstancedBufferAttribute(energies, 1));
    this.group.add(crowd);
    this.disposables.push({ dispose: () => crowd.dispose() });
  }

  /** 厩務員の 2 種類（GroomA・GroomB）の部品を読む。ジオメトリと材質は全員で使い回す */
  private readGrooms(gltf: GLTF) {
    // 服と装具は、アセットごとの 3D テクスチャ（paddockGroomTextures.ts）をモデルの座標で貼る（歩いても体に貼りついたまま）
    const groomMaterial = (part: ModelPart) => {
      const key = `groom:${part.materialName}`;
      let material = this.materials.get(key);
      if (material) return material;
      const color = part.color;
      const standard = (roughness: number) => new THREE.MeshStandardMaterial({ color, roughness });
      switch (part.materialName) {
        case "GroomShirt":
          // ポロシャツの鹿の子編み
          material = addDetail(standard(0.85), {
            texture: this.texture("pique", createPiqueKnitDetail),
            period: 0.04,
            space: "object",
            color: `diffuseColor.rgb *= (0.9 + 0.15 * detail.r) * (1.0 - 0.1 * detail.g);`,
            bump: 0.0006,
          });
          break;
        case "GroomPants":
          material = addDetail(standard(0.8), {
            texture: this.texture("slacks", createSlacksTwillDetail),
            period: 0.05,
            space: "object",
            color: `diffuseColor.rgb *= 0.85 + 0.25 * detail.r;
              diffuseColor.rgb += vec3(0.04) * detail.g;`,
            bump: 0.0006,
          });
          break;
        case "Helmet":
          // 艶のある樹脂の帽体。擦れた所はつやが消える
          material = addDetail(standard(0.3), {
            texture: this.texture("helmet", createHelmetShellDetail),
            period: 0.3,
            space: "object",
            color: `diffuseColor.rgb *= 1.0 - 0.15 * detail.g;
              diffuseColor.rgb += vec3(0.06) * detail.r;`,
            roughness: `roughnessFactor = clamp(detail.b, 0.08, 0.6);`,
            bump: 0.0008,
          });
          break;
        case "GroomShoes":
          material = addDetail(standard(0.5), {
            texture: this.texture("shoe", createShoeLeatherDetail),
            period: 0.15,
            space: "object",
            color: `diffuseColor.rgb *= 0.9 + 0.2 * detail.r;`,
            roughness: `roughnessFactor = clamp(0.35 + detail.b * 0.4, 0.25, 0.8);`,
            bump: 0.001,
          });
          break;
        case "Armband":
          material = addDetail(standard(0.9), {
            texture: this.texture("armband", createArmbandDetail),
            period: 0.06,
            space: "object",
            color: `diffuseColor.rgb *= 0.88 + 0.2 * detail.r;`,
            bump: 0.0005,
          });
          break;
        default:
          material = standard(0.6);
      }
      this.materials.set(key, material);
      return material;
    };
    const meshesOf = (name: string) => {
      const node = takeNode(gltf, name);
      if (!node) return null;
      const meshes = node.parts.map((part) => {
        this.disposables.push(part.geometry);
        const mesh = new THREE.Mesh(part.geometry, groomMaterial(part));
        mesh.castShadow = true;
        return mesh;
      });
      return { meshes, origin: node.origin };
    };
    for (const prefix of ["GroomA_", "GroomB_"]) {
      const body = meshesOf(`${prefix}Body`);
      if (!body) continue;
      const bodyNode = gltf.scene.getObjectByName(`${prefix}Body`);
      const hand = bodyNode?.userData?.lead_hand as number[] | undefined;
      const relative = (part: GroomPartNode | null) =>
        part ? { meshes: part.meshes, origin: part.origin.clone().sub(body.origin) } : null;
      // 部品のジオメトリは自分の原点が基準。体の原点（足元）からの位置に置き直す
      body.meshes.forEach((mesh) => mesh.position.copy(body.origin));
      this.grooms.push({
        body: body.meshes,
        legL: relative(meshesOf(`${prefix}LegL`)),
        legR: relative(meshesOf(`${prefix}LegR`)),
        arm: relative(meshesOf(`${prefix}ArmL`) ?? meshesOf(`${prefix}ArmR`)),
        hand: Array.isArray(hand) && hand.length === 3 ? new THREE.Vector3(hand[0], hand[1], hand[2]) : new THREE.Vector3(0.3, 1.5, 0.3),
      });
    }
  }
}

/** 綱の点の数（綱に沿った分割）と、断面の角の数・太さ */
const ROPE_POINTS = 9;
const ROPE_SIDES = 5;
const ROPE_RADIUS = 0.022;
const ROPE_CENTERS = Array.from({ length: ROPE_POINTS }, () => new THREE.Vector3());
const ropeTangent = new THREE.Vector3();
const ropeNormal = new THREE.Vector3();
const ropeBinormal = new THREE.Vector3();
const ropeUp = new THREE.Vector3(0, 1, 0);

/** 綱の管（中心の点ごとに、断面の角の数だけ頂点を並べる） */
const createRopeGeometry = () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(ROPE_POINTS * ROPE_SIDES * 3), 3));
  const index: number[] = [];
  for (let i = 0; i < ROPE_POINTS - 1; i += 1) {
    for (let j = 0; j < ROPE_SIDES; j += 1) {
      const a = i * ROPE_SIDES + j;
      const b = i * ROPE_SIDES + ((j + 1) % ROPE_SIDES);
      index.push(a, a + ROPE_SIDES, b, b, a + ROPE_SIDES, b + ROPE_SIDES);
    }
  }
  geometry.setIndex(index);
  return geometry;
};

/** 中心の点に沿って管の頂点を置き直す（毎フレーム。点が少ないので軽い） */
const updateRopeGeometry = (geometry: THREE.BufferGeometry, centers: THREE.Vector3[]) => {
  const positions = geometry.getAttribute("position") as THREE.BufferAttribute;
  centers.forEach((center, i) => {
    const before = centers[Math.max(0, i - 1)];
    const after = centers[Math.min(centers.length - 1, i + 1)];
    ropeTangent.subVectors(after, before).normalize();
    ropeNormal.crossVectors(ropeTangent, ropeUp);
    if (ropeNormal.lengthSq() < 1e-6) ropeNormal.set(1, 0, 0);
    ropeNormal.normalize();
    ropeBinormal.crossVectors(ropeTangent, ropeNormal);
    for (let j = 0; j < ROPE_SIDES; j += 1) {
      const angle = (j / ROPE_SIDES) * Math.PI * 2;
      const c = Math.cos(angle) * ROPE_RADIUS;
      const s = Math.sin(angle) * ROPE_RADIUS;
      positions.setXYZ(
        i * ROPE_SIDES + j,
        center.x + ropeNormal.x * c + ropeBinormal.x * s,
        center.y + ropeNormal.y * c + ropeBinormal.y * s,
        center.z + ropeNormal.z * c + ropeBinormal.z * s
      );
    }
  });
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
};

/** 決定的な乱数（観客の並びを毎回同じにする） */
const mulberry32 = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** パドックの電光掲示板（馬番・馬名・馬体重・増減・単勝） */
class PaddockBoard {
  readonly material: THREE.MeshBasicMaterial;
  private readonly canvas = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly texture: THREE.CanvasTexture;

  constructor(private readonly background: THREE.CanvasTexture) {
    this.canvas.width = 1920;
    this.canvas.height = 1080;
    this.ctx = this.canvas.getContext("2d");
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.material = new THREE.MeshBasicMaterial({ map: this.texture });
    // LED の画面はまわりより明るい
    this.material.color.setScalar(1.25);
    this.draw([], { odds: (odds) => odds.toFixed(1) });
  }

  draw(entries: PaddockEntry[], labels: PaddockBoardLabels) {
    const ctx = this.ctx;
    if (!ctx) return;
    const { width, height } = this.canvas;
    ctx.drawImage(this.background.image as CanvasImageSource, 0, 0, width, height);
    const top = height * 0.2;
    const rowHeight = Math.min(96, (height * 0.78) / Math.max(1, entries.length));
    const font = `"Hiragino Sans", "Noto Sans JP", system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    entries.forEach((entry, i) => {
      const y = top + (i + 0.5) * rowHeight;
      const size = Math.round(rowHeight * 0.62);
      // 馬番は枠の色の札
      ctx.fillStyle = entry.color;
      ctx.fillRect(width * 0.04, y - rowHeight * 0.4, rowHeight * 0.8, rowHeight * 0.8);
      const badge = new THREE.Color(entry.color);
      const isLight = 0.2126 * badge.r + 0.7152 * badge.g + 0.0722 * badge.b > 0.35;
      ctx.fillStyle = isLight ? "#111111" : "#ffffff";
      ctx.textAlign = "center";
      ctx.font = `bold ${size}px ${font}`;
      ctx.fillText(String(entry.number), width * 0.04 + rowHeight * 0.4, y + 2);
      ctx.textAlign = "left";
      ctx.fillStyle = "#ffffff";
      ctx.fillText(entry.name, width * 0.14, y + 2, width * 0.44);
      // 馬体重と増減は LED らしい橙、単勝は黄色。背景の列見出し（馬体重 58%・増減 74.5%・単勝 86.5%）にそろえる
      ctx.fillStyle = "#ffb74d";
      ctx.fillText(String(entry.weight), width * 0.58, y + 2);
      ctx.fillText(formatWeightChange(entry.change), width * 0.745, y + 2);
      ctx.fillStyle = "#fff176";
      ctx.fillText(labels.odds(entry.odds), width * 0.865, y + 2, width * 0.12);
    });
    this.texture.needsUpdate = true;
  }

  dispose() {
    this.texture.dispose();
    this.material.dispose();
  }
}
