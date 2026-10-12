import * as THREE from "three";
import { TAIL_DOCK_LENGTH, type HorseModel } from "./horseModel";
import { createSimulatedTailMaterial } from "./horseTail";
import { MAX_PHYSICS_STEP, type KinematicCollider, type SoftBody, type SoftBodyWorld } from "./softBodyPhysics";
import type { CourseWind } from "./wind";

// 馬の尻尾を物理エンジン（softBodyPhysics.ts の Jolt Physics）で動かす。
//
// 尻尾の芯（尾骨のある付け根の部分）は馬の体と一緒に動かし、そこから生えた毛の束をソフトボディにする。
// 毛は「ガイド」の毛束 8 本だけを物理で解き、描く細い毛 40 本はガイドの間を補って作る（髪の毛のシミュレーションでよく使う方法）。
// - 毛束: 点を辺の拘束（伸びない）と 1 つ飛ばしの拘束（曲げの硬さ）でつなぎ、付け根から離れすぎない拘束（LRA）を足す。
//   隣の毛束どうしも弱くつないで、尻尾がばらばらにほどけないようにする
// - 当たり判定: 馬の尻（球）と後ろ脚の上下（カプセル）。走ると毛が飛節にあたって跳ね、止まると尻に沿って垂れる
// - 空気: 風との相対速度に比例する抵抗（走ると後ろへなびく）と、速さに応じた乱れ（毛先がばたつく）

/** ガイドの毛束の本数と、1 本の点の数 */
const GUIDES = 8;
const POINTS = 11;
/** 毛の長さ（ワールド単位。1m ≒ 1.5 単位） */
const HAIR_LENGTH = 1.05;
const SEGMENT = HAIR_LENGTH / (POINTS - 1);
/** 描く細い毛の本数 */
const RENDER_STRANDS = 40;
/** 尻尾の芯の長さ（毛はこの範囲から生える。芯は馬のモデルが描く） */
const DOCK_LENGTH = TAIL_DOCK_LENGTH;
/** 空気抵抗（1/秒）。走る速さでの流れと重力の釣り合いで、毛が斜め後ろへなびく角度が決まる */
const DRAG = 1.8;

interface HorseTail {
  horse: HorseModel;
  body: SoftBody;
  colliders: Array<{ collider: KinematicCollider; part: THREE.Object3D; offset: THREE.Vector3 }>;
  /** 前のフレームの付け根の位置（大きく飛んだら、ゲートに戻したとみなして毛を置き直す） */
  lastRoot: THREE.Vector3;
  /** 物理で解いたガイドの点（描画用に毎フレーム写す） */
  guides: Float32Array;
}

/** 物理の頂点の番号（ガイド s の k 番目の点） */
const vertexIndex = (s: number, k: number) => s * POINTS + k;

/** ガイドの付け根: 芯に沿った位置（0..1）と、芯のまわりの角度 */
const guideRoot = (s: number) => ({
  along: 0.3 + 0.7 * ((s % 4) / 3),
  angle: (s / GUIDES) * Math.PI * 2,
});

/** 種から決まる乱数（mulberry32）。描く毛の散らばりを毎回同じにする */
const seededRandom = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/** 描く毛 1 本が、どのガイドの間をどの割合でたどるか（全馬共通） */
interface RenderStrand {
  a: number;
  b: number;
  weight: number;
  /** 毛先へ行くほど広がる、ガイドからのずれ */
  spread: THREE.Vector3;
  /** 毛の長さ（ガイドの何割までたどるか） */
  length: number;
  width: number;
}

const createRenderStrands = () => {
  const random = seededRandom(9157);
  const strands: RenderStrand[] = [];
  for (let i = 0; i < RENDER_STRANDS; i += 1) {
    const a = Math.floor(random() * GUIDES);
    strands.push({
      a,
      b: (a + 1 + Math.floor(random() * 2)) % GUIDES,
      weight: random(),
      spread: new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5).multiplyScalar(0.12),
      length: 0.75 + random() * 0.25,
      width: 0.03 + random() * 0.012,
    });
  }
  return strands;
};

/** 馬の体の当たり判定の形（胴・脚の部品のローカル座標） */
const RUMP = { center: new THREE.Vector3(-0.6, 1.42, 0), radius: 0.4 };
const UPPER_LEG = { offset: new THREE.Vector3(0, -0.28, 0), halfHeight: 0.2, radius: 0.1 };
const LOWER_LEG = { offset: new THREE.Vector3(0, -0.28, 0), halfHeight: 0.22, radius: 0.065 };

export class TailPhysics {
  readonly mesh: THREE.Mesh;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material = createSimulatedTailMaterial();
  private readonly renderStrands = createRenderStrands();
  private tails: HorseTail[] = [];
  private readonly maxHorses: number;
  // 毎フレームの計算で使い回す
  private readonly v = new THREE.Vector3();
  private readonly w = new THREE.Vector3();
  private readonly root = new THREE.Vector3();
  private readonly dockDir = new THREE.Vector3();
  private readonly dockUp = new THREE.Vector3();
  private readonly dockSide = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();

  constructor(
    private readonly world: SoftBodyWorld,
    maxHorses: number
  ) {
    this.maxHorses = maxHorses;
    const perStrand = POINTS * 2;
    const vertexCount = maxHorses * RENDER_STRANDS * perStrand;
    this.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("aTangent", new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3));
    const strandInfo = new Float32Array(vertexCount * 3);
    const indices: number[] = [];
    for (let h = 0; h < maxHorses; h += 1) {
      for (let r = 0; r < RENDER_STRANDS; r += 1) {
        const base = (h * RENDER_STRANDS + r) * perStrand;
        for (let k = 0; k < POINTS; k += 1) {
          for (let side = 0; side < 2; side += 1) {
            const i = base + k * 2 + side;
            strandInfo[i * 3] = k / (POINTS - 1);
          }
          if (k < POINTS - 1) {
            const a = base + k * 2;
            indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
          }
        }
      }
    }
    this.geometry.setAttribute("aStrand", new THREE.BufferAttribute(strandInfo, 3));
    this.geometry.setIndex(indices);
    this.geometry.setDrawRange(0, 0);
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // 頂点はワールド座標で書き込み、馬は走路のあちこちにいるので、まとめた境界での視錐台カリングはしない
    this.mesh.frustumCulled = false;
  }

  /** 出走馬が変わったら、尻尾のソフトボディと当たり判定を作り直す */
  setHorses(horses: HorseModel[]) {
    this.clear();
    const colors = this.geometry.getAttribute("color") as THREE.BufferAttribute;
    horses.slice(0, this.maxHorses).forEach((horse, h) => {
      horse.root.updateMatrixWorld(true);
      this.tails.push(this.createTail(horse));
      horse.setTailSimulated(true);
      const perHorse = RENDER_STRANDS * POINTS * 2;
      for (let i = 0; i < perHorse; i += 1) {
        // 毛 1 本ごとに明るさを少し変えて、束の中の毛のばらつきを出す
        const shade = 0.85 + ((i / (POINTS * 2)) % 7) * 0.04;
        colors.setXYZ(h * perHorse + i, horse.tailColor.r * shade, horse.tailColor.g * shade, horse.tailColor.b * shade);
      }
    });
    colors.needsUpdate = true;
    this.geometry.setDrawRange(0, this.tails.length * RENDER_STRANDS * (POINTS - 1) * 6);
  }

  private clear() {
    for (const tail of this.tails) {
      tail.body.dispose();
      tail.colliders.forEach(({ collider }) => collider.dispose());
      tail.horse.setTailSimulated(false);
    }
    this.tails = [];
  }

  /** 尻尾の芯の向き（-X が伸びる向き）をワールド座標で求める。root に付け根、dockDir に伸びる向き */
  private readDock(horse: HorseModel) {
    const { tail } = horse.physicsParts;
    tail.matrixWorld.decompose(this.root, this.quaternion, this.scale);
    this.dockDir.set(-1, 0, 0).applyQuaternion(this.quaternion);
    this.dockUp.set(0, 1, 0).applyQuaternion(this.quaternion);
    this.dockSide.set(0, 0, 1).applyQuaternion(this.quaternion);
  }

  /** ガイド s の付け根（芯の上の点）と、毛が芯から離れる向きの 2 点目 */
  private guideAnchors(s: number, first: THREE.Vector3, second: THREE.Vector3) {
    const { along, angle } = guideRoot(s);
    const radius = 0.045;
    first
      .copy(this.root)
      .addScaledVector(this.dockDir, along * DOCK_LENGTH)
      .addScaledVector(this.dockUp, Math.cos(angle) * radius)
      .addScaledVector(this.dockSide, Math.sin(angle) * radius);
    // 毛は芯の向きに沿って生え、外側へ少し開く
    second
      .copy(first)
      .addScaledVector(this.dockDir, SEGMENT * 0.9)
      .addScaledVector(this.dockUp, Math.cos(angle) * SEGMENT * 0.3)
      .addScaledVector(this.dockSide, Math.sin(angle) * SEGMENT * 0.3);
  }

  private createTail(horse: HorseModel): HorseTail {
    this.readDock(horse);
    const vertices: Array<{ position: THREE.Vector3; invMass: number }> = [];
    const first = new THREE.Vector3();
    const second = new THREE.Vector3();
    for (let s = 0; s < GUIDES; s += 1) {
      this.guideAnchors(s, first, second);
      const hang = new THREE.Vector3().subVectors(second, first).normalize();
      for (let k = 0; k < POINTS; k += 1) {
        // 最初は付け根から真下へ垂らしておく（1 フレーム目から自然な形に落ち着く）
        const position =
          k === 0 ? first.clone() : k === 1 ? second.clone() : second.clone().add(new THREE.Vector3(0, -SEGMENT * (k - 1), 0));
        if (k === 1) hang.set(0, -1, 0);
        // 付け根の 2 点は馬の体と一緒に動かす（物理では動かさない）
        vertices.push({ position, invMass: k < 2 ? 0 : 1 });
      }
    }
    const body = this.world.createSoftBody(vertices, { vertexRadius: 0.035, iterations: 8 }, (builder) => {
      for (let s = 0; s < GUIDES; s += 1) {
        for (let k = 0; k < POINTS - 1; k += 1) {
          // 毛は伸びない
          builder.edge(vertexIndex(s, k), vertexIndex(s, k + 1), 1e-6);
          // 1 つ飛ばしでつなぐと曲げに硬さが出る（細い毛束のしなり）
          if (k < POINTS - 2) builder.edge(vertexIndex(s, k), vertexIndex(s, k + 2), 4e-3);
          if (k >= 2) builder.longRange(vertexIndex(s, 0), vertexIndex(s, k));
        }
        // 隣の毛束と弱くつないで、尻尾がほどけないようにする（毛先ほど緩く）
        const next = (s + 1) % GUIDES;
        for (let k = 2; k < POINTS; k += 2) builder.edge(vertexIndex(s, k), vertexIndex(next, k), 0.02 + k * 0.006);
      }
    });

    const { body: horseBody, hindLegs } = horse.physicsParts;
    const colliders: HorseTail["colliders"] = [
      { collider: this.world.createSphere(RUMP.radius), part: horseBody, offset: RUMP.center },
    ];
    for (const leg of hindLegs) {
      colliders.push({
        collider: this.world.createCapsule(UPPER_LEG.halfHeight, UPPER_LEG.radius),
        part: leg.upper,
        offset: UPPER_LEG.offset,
      });
      colliders.push({
        collider: this.world.createCapsule(LOWER_LEG.halfHeight, LOWER_LEG.radius),
        part: leg.lower,
        offset: LOWER_LEG.offset,
      });
    }
    const tail: HorseTail = { horse, body, colliders, lastRoot: this.root.clone(), guides: new Float32Array(GUIDES * POINTS * 3) };
    this.moveColliders(tail, 1 / 60, true);
    return tail;
  }

  private moveColliders(tail: HorseTail, dt: number, teleport: boolean) {
    for (const { collider, part, offset } of tail.colliders) {
      part.matrixWorld.decompose(this.v, this.quaternion, this.scale);
      this.target.copy(offset).applyMatrix4(part.matrixWorld);
      if (teleport) collider.teleport(this.target, this.quaternion);
      else collider.moveTo(this.target, this.quaternion, dt);
    }
  }

  /**
   * 物理のステップの前に呼ぶ。付け根の点を馬の体に合わせて動かし、当たり判定を動かし、空気の力をかける
   * @param courseWind 会場の風。馬ごとに、尻尾の付け根の位置の風を受ける
   */
  beforeStep(dt: number, time: number, courseWind: CourseWind) {
    if (dt <= 0) return;
    const wind = new THREE.Vector3();
    const first = this.v;
    const second = this.w;
    const position = new THREE.Vector3();
    const velocity = new THREE.Vector3();
    for (let h = 0; h < this.tails.length; h += 1) {
      const tail = this.tails[h];
      const horse = tail.horse;
      horse.root.updateMatrixWorld(true);
      this.readDock(horse);
      const jumped = this.root.distanceTo(tail.lastRoot) > 3;
      tail.lastRoot.copy(this.root);
      this.moveColliders(tail, dt, jumped);
      if (jumped) {
        this.resetTail(tail);
        continue;
      }
      courseWind.sample(this.root, time, wind);
      // 付け根の 2 点は、このステップの終わりにちょうど体の上に着くよう、速さを与えて動かす（物理エンジンは質量 0 の点を速さで動かす）。
      // 物理エンジンが 1 回に進める時間（MAX_PHYSICS_STEP）より 1 コマが長いときは、進めきれない分だけ先に位置を寄せておく。
      // Why not: 速さだけで動かすと、描画が重いときに付け根が体に追いつかず、走る速さの分だけ尻尾が体から離れて置いていかれる。
      // 位置だけで動かす（速さ 0）と、毎コマ付け根が飛ぶので毛先が暴れる
      const stepDt = Math.min(dt, MAX_PHYSICS_STEP);
      for (let s = 0; s < GUIDES; s += 1) {
        this.guideAnchors(s, first, second);
        for (const [k, anchor] of [
          [0, first],
          [1, second],
        ] as const) {
          const i = vertexIndex(s, k);
          tail.body.getPosition(i, position);
          const vx = (anchor.x - position.x) / dt;
          const vy = (anchor.y - position.y) / dt;
          const vz = (anchor.z - position.z) / dt;
          tail.body.setPosition(i, anchor.x - vx * stepDt, anchor.y - vy * stepDt, anchor.z - vz * stepDt);
          tail.body.setVelocity(i, vx, vy, vz);
        }
      }
      // 空気: 風との相対速度に比例する抵抗と、走る速さに応じた乱れ（毛先ほど大きく揺れる）
      const keep = Math.exp(-DRAG * dt);
      const gust = 0.6 + 7 * horse.gallop;
      for (let s = 0; s < GUIDES; s += 1) {
        for (let k = 2; k < POINTS; k += 1) {
          const i = vertexIndex(s, k);
          tail.body.getVelocity(i, velocity);
          const t = k / (POINTS - 1);
          const phase = time * (3 + 9 * horse.gallop) + s * 1.7 + k * 0.6 + h * 3.1;
          const ty = Math.sin(phase) * gust * t * dt;
          const tz = Math.cos(phase * 1.3 + 0.7) * gust * t * dt;
          tail.body.setVelocity(
            i,
            wind.x + (velocity.x - wind.x) * keep,
            wind.y + (velocity.y - wind.y) * keep + ty,
            wind.z + (velocity.z - wind.z) * keep + tz
          );
        }
      }
    }
  }

  /** ゲートに戻したときなど、付け根が大きく飛んだら毛を付け根の下へ垂らし直す */
  private resetTail(tail: HorseTail) {
    const first = this.v;
    const second = this.w;
    for (let s = 0; s < GUIDES; s += 1) {
      this.guideAnchors(s, first, second);
      for (let k = 0; k < POINTS; k += 1) {
        const i = vertexIndex(s, k);
        if (k === 0) tail.body.setPosition(i, first.x, first.y, first.z);
        else if (k === 1) tail.body.setPosition(i, second.x, second.y, second.z);
        else tail.body.setPosition(i, second.x, second.y - SEGMENT * (k - 1), second.z);
        tail.body.setVelocity(i, 0, 0, 0);
      }
    }
  }

  /**
   * 物理のステップの後に呼ぶ。ガイドの点から描く毛を作る。毛は細い帯で、カメラの方へ向ける
   */
  afterStep(camera: THREE.Camera) {
    const positions = this.geometry.getAttribute("position") as THREE.BufferAttribute;
    const normals = this.geometry.getAttribute("normal") as THREE.BufferAttribute;
    const tangents = this.geometry.getAttribute("aTangent") as THREE.BufferAttribute;
    const p = positions.array as Float32Array;
    const n = normals.array as Float32Array;
    const tg = tangents.array as Float32Array;
    const point = new THREE.Vector3();
    const next = new THREE.Vector3();
    const tangent = new THREE.Vector3();
    const toCamera = new THREE.Vector3();
    const side = new THREE.Vector3();
    const axis = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
    const strandPoints = Array.from({ length: POINTS }, () => new THREE.Vector3());
    const axisPoints = Array.from({ length: POINTS }, () => new THREE.Vector3());

    for (let h = 0; h < this.tails.length; h += 1) {
      const tail = this.tails[h];
      const g = tail.guides;
      for (let s = 0; s < GUIDES; s += 1) {
        for (let k = 0; k < POINTS; k += 1) {
          tail.body.getPosition(vertexIndex(s, k), point);
          const o = (s * POINTS + k) * 3;
          g[o] = point.x;
          g[o + 1] = point.y;
          g[o + 2] = point.z;
        }
      }
      // 尻尾の束の中心（陰影の向きの基準）
      for (let k = 0; k < POINTS; k += 1) {
        axisPoints[k].set(0, 0, 0);
        for (let s = 0; s < GUIDES; s += 1) {
          const o = (s * POINTS + k) * 3;
          axisPoints[k].x += g[o] / GUIDES;
          axisPoints[k].y += g[o + 1] / GUIDES;
          axisPoints[k].z += g[o + 2] / GUIDES;
        }
      }

      for (let r = 0; r < RENDER_STRANDS; r += 1) {
        const strand = this.renderStrands[r];
        // ガイド 2 本の間を補い、毛の長さの分だけたどる
        for (let k = 0; k < POINTS; k += 1) {
          const u = (k / (POINTS - 1)) * strand.length * (POINTS - 1);
          const k0 = Math.min(POINTS - 2, Math.floor(u));
          const f = u - k0;
          const at = (s: number, kk: number, out: THREE.Vector3) => {
            const o = (s * POINTS + kk) * 3;
            return out.set(g[o], g[o + 1], g[o + 2]);
          };
          at(strand.a, k0, point).lerp(at(strand.a, k0 + 1, next), f);
          const pa = point.clone();
          at(strand.b, k0, point).lerp(at(strand.b, k0 + 1, next), f);
          strandPoints[k].copy(pa).lerp(point, strand.weight).addScaledVector(strand.spread, k / (POINTS - 1));
        }
        const base = (h * RENDER_STRANDS + r) * POINTS * 2;
        for (let k = 0; k < POINTS; k += 1) {
          const t = k / (POINTS - 1);
          const current = strandPoints[k];
          if (k < POINTS - 1) tangent.subVectors(strandPoints[k + 1], current);
          else tangent.subVectors(current, strandPoints[k - 1]);
          tangent.normalize();
          // 帯はカメラの方を向ける（細い毛がどの角度からも同じ太さに見える）
          toCamera.subVectors(cameraPosition, current).normalize();
          side.crossVectors(tangent, toCamera).normalize();
          const width = strand.width * (1 - t) + 0.008;
          // 陰影は束の中心から外向き（束全体が 1 本の太い毛の房として丸く照らされる）
          axis.copy(axisPoints[Math.round(t * strand.length * (POINTS - 1))]);
          normal.subVectors(current, axis);
          if (normal.lengthSq() < 1e-6) normal.copy(toCamera);
          normal.normalize();
          for (let sideSign = -1; sideSign <= 1; sideSign += 2) {
            const i = base + k * 2 + (sideSign > 0 ? 1 : 0);
            p[i * 3] = current.x + side.x * width * 0.5 * sideSign;
            p[i * 3 + 1] = current.y + side.y * width * 0.5 * sideSign;
            p[i * 3 + 2] = current.z + side.z * width * 0.5 * sideSign;
            n[i * 3] = normal.x;
            n[i * 3 + 1] = normal.y;
            n[i * 3 + 2] = normal.z;
            tg[i * 3] = tangent.x;
            tg[i * 3 + 1] = tangent.y;
            tg[i * 3 + 2] = tangent.z;
          }
        }
      }
    }
    positions.needsUpdate = true;
    normals.needsUpdate = true;
    tangents.needsUpdate = true;
  }

  dispose() {
    this.clear();
    this.geometry.dispose();
    this.material.dispose();
  }
}
