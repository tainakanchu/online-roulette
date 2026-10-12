import * as THREE from "three";
import { FLAG_SIZE } from "./flag";
import type { SoftBody, SoftBodyWorld } from "./softBodyPhysics";
import type { CourseWind } from "./wind";

// 旗の布を物理エンジン（softBodyPhysics.ts の Jolt Physics）で動かす。
// 布は格子の点を三角形の面でつなぎ、伸び・せん断・曲げ（二面角）の拘束で布らしい硬さにする。竿の側の列は竿に固定する。
// 風は会場の風（wind.ts）から受ける。面ごとに、風との相対速度の面に垂直な成分で押す力（揚力・抗力）と、面に沿ってこする弱い力をかける。
// 風に沿って伸びきった布は、面に垂直な力が釣り合ってしまって平らなまま止まる。本物の旗がはためき続けるのは、布の風下にできる渦が
// 布を左右に揺さぶるからなので、竿の側から先端へ進む波として面に垂直な揺さぶりを足す（先端ほど大きく、風が強いほど速く大きい）。

const COLUMNS = 10;
const ROWS = 6;
/** 1 点あたりの質量の逆数。布は軽いので、風の力がよく効く */
const INV_MASS = 30;
/** 面に垂直な風の力の係数と、面に沿った力の係数 */
const PRESSURE = 12;
const FRICTION = 1.5;

const vertexIndex = (column: number, row: number) => row * COLUMNS + column;

export interface ClothFlagHandle {
  dispose: () => void;
}

class ClothFlag {
  readonly mesh: THREE.Mesh;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly body: SoftBody;
  private readonly anchorPosition = new THREE.Vector3();
  private readonly positions = new Float32Array(COLUMNS * ROWS * 3);
  private readonly velocities = new Float32Array(COLUMNS * ROWS * 3);
  private readonly faces: number[] = [];
  /** 面ごとの、竿からの距離（0 = 竿の側、1 = 先端）。はためきの波の位相に使う */
  private readonly faceAlong: number[] = [];
  /** 旗ごとにはためきの位相をずらす */
  private readonly seed = Math.random() * 10;

  constructor(
    world: SoftBodyWorld,
    private readonly anchor: THREE.Object3D,
    material: THREE.Material,
    downwind: THREE.Vector3
  ) {
    anchor.updateWorldMatrix(true, false);
    anchor.getWorldPosition(this.anchorPosition);
    const vertices = this.restPositions(downwind).map((position, i) => ({
      position,
      // 竿の側の列は竿に固定する
      invMass: i % COLUMNS === 0 ? 0 : INV_MASS,
    }));
    for (let row = 0; row < ROWS - 1; row += 1) {
      for (let column = 0; column < COLUMNS - 1; column += 1) {
        const a = vertexIndex(column, row);
        const b = vertexIndex(column + 1, row);
        const c = vertexIndex(column, row + 1);
        const d = vertexIndex(column + 1, row + 1);
        this.faces.push(a, c, b, b, c, d);
        const along = (column + 0.5) / (COLUMNS - 1);
        this.faceAlong.push(along, along);
      }
    }
    this.body = world.createSoftBody(
      vertices,
      // 弱い風では垂れ下がるよう、せん断と曲げは柔らかめにする（伸びだけは硬く）
      { vertexRadius: 0.01, iterations: 10, cloth: { compliance: 1e-5, shearCompliance: 2e-3, bendCompliance: 2e-2 } },
      (builder) => {
        for (let i = 0; i < this.faces.length; i += 3) builder.face(this.faces[i], this.faces[i + 1], this.faces[i + 2]);
      }
    );

    const uvs = new Float32Array(COLUMNS * ROWS * 2);
    for (let row = 0; row < ROWS; row += 1) {
      for (let column = 0; column < COLUMNS; column += 1) {
        const i = vertexIndex(column, row);
        // 竿の側 u = 0 → 先端 1、上端 v = 1 → 下端 0（旗の絵の向き）
        uvs[i * 2] = column / (COLUMNS - 1);
        uvs[i * 2 + 1] = 1 - row / (ROWS - 1);
      }
    }
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute("aFlagUv", new THREE.BufferAttribute(uvs, 2));
    this.geometry.setIndex(this.faces);
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.sync();
  }

  /** 竿から風下へ水平に広げた形 */
  private restPositions(downwind: THREE.Vector3) {
    const flat = new THREE.Vector3(downwind.x, 0, downwind.z);
    if (flat.lengthSq() < 1e-6) flat.set(1, 0, 0);
    flat.normalize();
    const result: THREE.Vector3[] = [];
    for (let row = 0; row < ROWS; row += 1) {
      for (let column = 0; column < COLUMNS; column += 1) {
        result.push(
          this.anchorPosition
            .clone()
            .addScaledVector(flat, (column / (COLUMNS - 1)) * FLAG_SIZE.width)
            .add(new THREE.Vector3(0, -(row / (ROWS - 1)) * FLAG_SIZE.height, 0))
        );
      }
    }
    return result;
  }

  beforeStep(dt: number, time: number, wind: CourseWind) {
    this.anchor.updateWorldMatrix(true, false);
    const target = this.anchor.getWorldPosition(new THREE.Vector3());
    const windVelocity = wind.sample(target, time, new THREE.Vector3());
    // 置き直し（発走地点が変わってカンパイ係員が移ったなど）は、布ごと新しい場所へ移す
    if (target.distanceTo(this.anchorPosition) > 1) {
      this.anchorPosition.copy(target);
      this.restPositions(windVelocity).forEach((position, i) => {
        this.body.setPosition(i, position.x, position.y, position.z);
        this.body.setVelocity(i, 0, 0, 0);
      });
      return;
    }
    this.anchorPosition.copy(target);

    const p = this.positions;
    const v = this.velocities;
    const point = new THREE.Vector3();
    for (let i = 0; i < this.body.count; i += 1) {
      this.body.getPosition(i, point);
      p[i * 3] = point.x;
      p[i * 3 + 1] = point.y;
      p[i * 3 + 2] = point.z;
      this.body.getVelocity(i, point);
      v[i * 3] = point.x;
      v[i * 3 + 1] = point.y;
      v[i * 3 + 2] = point.z;
    }
    // 竿の側の列は、このステップの間に竿の位置へ着く速さを与える
    for (let row = 0; row < ROWS; row += 1) {
      const i = vertexIndex(0, row);
      const y = target.y - (row / (ROWS - 1)) * FLAG_SIZE.height;
      this.body.setVelocity(i, (target.x - p[i * 3]) / dt, (y - p[i * 3 + 1]) / dt, (target.z - p[i * 3 + 2]) / dt);
    }

    // 面ごとの風の力
    const dv = new Float32Array(this.body.count * 3);
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    const normal = new THREE.Vector3();
    const relative = new THREE.Vector3();
    const tangential = new THREE.Vector3();
    for (let f = 0; f < this.faces.length; f += 3) {
      const a = this.faces[f];
      const b = this.faces[f + 1];
      const c = this.faces[f + 2];
      e1.set(p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]);
      e2.set(p[c * 3] - p[a * 3], p[c * 3 + 1] - p[a * 3 + 1], p[c * 3 + 2] - p[a * 3 + 2]);
      normal.crossVectors(e1, e2);
      const doubleArea = normal.length();
      if (doubleArea < 1e-8) continue;
      normal.divideScalar(doubleArea);
      // 面の速さとの差（布が風と同じ速さで動けば力はかからない）。乱れは布の上の場所ごとに位相をずらす
      const flutter = Math.sin(time * 9 + a * 0.7) * 0.35 + Math.sin(time * 5.3 + a * 1.9) * 0.2;
      relative.set(
        windVelocity.x * (1 + flutter * 0.3) - (v[a * 3] + v[b * 3] + v[c * 3]) / 3,
        windVelocity.y + flutter * 1.2 - (v[a * 3 + 1] + v[b * 3 + 1] + v[c * 3 + 1]) / 3,
        windVelocity.z * (1 + flutter * 0.3) - (v[a * 3 + 2] + v[b * 3 + 2] + v[c * 3 + 2]) / 3
      );
      const speed = relative.length();
      // 風下の渦による揺さぶり: 竿の側から先端へ進む波。先端ほど大きく揺れる
      const along = this.faceAlong[f / 3];
      // 波長は布の長さより少し長い（隣の面どうしで向きが細かく入れ替わると、力が打ち消し合って揺れない）
      const flap = Math.sin(time * (3 + speed * 0.3) - along * 4.5 + this.seed) * (0.3 + 0.7 * along);
      const normalWind = normal.dot(relative);
      const facing = normalWind + speed * 1.0 * flap;
      tangential.copy(relative).addScaledVector(normal, -normalWind);
      const area = doubleArea / 2;
      // 力（速さの 2 乗に比例）を面の 3 点に等分し、速さの変化に直す
      const k = (area * speed * dt * INV_MASS) / 3;
      const fx = normal.x * facing * PRESSURE + tangential.x * FRICTION;
      const fy = normal.y * facing * PRESSURE + tangential.y * FRICTION;
      const fz = normal.z * facing * PRESSURE + tangential.z * FRICTION;
      for (const i of [a, b, c]) {
        dv[i * 3] += fx * k;
        dv[i * 3 + 1] += fy * k;
        dv[i * 3 + 2] += fz * k;
      }
    }
    for (let i = 0; i < this.body.count; i += 1) {
      if (i % COLUMNS === 0) continue;
      this.body.addVelocity(i, dv[i * 3], dv[i * 3 + 1], dv[i * 3 + 2]);
    }
  }

  /** 物理で動いた点を描画用の頂点へ写し、法線を作り直す */
  sync() {
    const point = new THREE.Vector3();
    for (let i = 0; i < this.body.count; i += 1) {
      this.body.getPosition(i, point);
      this.positions[i * 3] = point.x;
      this.positions[i * 3 + 1] = point.y;
      this.positions[i * 3 + 2] = point.z;
    }
    this.geometry.getAttribute("position").needsUpdate = true;
    this.geometry.computeVertexNormals();
  }

  dispose() {
    this.body.dispose();
    this.geometry.dispose();
    this.mesh.removeFromParent();
  }
}

/**
 * 物理で動かす旗をまとめる。旗の布の頂点はワールド座標なので、group は原点に置いたままにする
 */
export class ClothFlags {
  readonly group = new THREE.Group();
  private readonly flags = new Set<ClothFlag>();

  constructor(
    private readonly world: SoftBodyWorld,
    private readonly wind: CourseWind
  ) {}

  /**
   * 旗を足す
   * @param anchor 竿の上端（布の竿の側の上の角）。竿は鉛直に立っているものとする
   * @param material 物理用の旗のマテリアル（createFlagMaterial の simulated）
   */
  create(anchor: THREE.Object3D, material: THREE.Material): ClothFlagHandle {
    anchor.updateWorldMatrix(true, false);
    const downwind = this.wind.sample(anchor.getWorldPosition(new THREE.Vector3()), 0, new THREE.Vector3());
    const flag = new ClothFlag(this.world, anchor, material, downwind);
    this.flags.add(flag);
    this.group.add(flag.mesh);
    return {
      dispose: () => {
        if (!this.flags.delete(flag)) return;
        flag.dispose();
      },
    };
  }

  beforeStep(dt: number, time: number) {
    if (dt <= 0) return;
    for (const flag of this.flags) flag.beforeStep(dt, time, this.wind);
  }

  afterStep() {
    for (const flag of this.flags) flag.sync();
  }

  dispose() {
    for (const flag of this.flags) flag.dispose();
    this.flags.clear();
  }
}
