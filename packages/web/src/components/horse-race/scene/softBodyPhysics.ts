import type * as THREE from "three";
import type Jolt from "jolt-physics/wasm";

// 物理エンジン Jolt Physics（WebAssembly 版）で、尻尾の毛束と旗の布をソフトボディとして動かす土台。
// Jolt は JS と wasm で 3MB ほどあるので、競馬モードで使うときに初めて読み込む（動的 import で別のチャンクに分かれる）。
// wasm を JS に埋め込んだ版（wasm-compat）は 1 ファイルが 3.5MB になり、PWA のオフライン用キャッシュの上限（2MiB）を超えるので、
// wasm を別ファイルにした版を使う。オフラインで wasm を読めなければ、尻尾と旗は頂点シェーダーで揺らすまま。
//
// ソフトボディの頂点は毎フレーム数百〜千個を読み書きするので、ラッパーオブジェクト経由ではなく
// WebAssembly のメモリ（HEAPF32）を直接読む。頂点の配列の先頭アドレス・1 頂点の大きさ・位置と速度の位置（オフセット）は、
// 作った直後に最初の 2 頂点のアドレスから求める。

type JoltApi = typeof Jolt;

let joltPromise: Promise<JoltApi> | null = null;

/** Jolt を読み込んで初期化する（2 回目以降は同じものを返す） */
const loadJolt = () => {
  joltPromise ??= Promise.all([import("jolt-physics/wasm"), import("jolt-physics/jolt-physics.wasm.wasm?url")]).then(
    ([module, wasm]) => module.default({ locateFile: () => wasm.default })
  );
  // 読み込みに失敗したら、次に呼ばれたときにまた読み直す
  joltPromise.catch(() => {
    joltPromise = null;
  });
  return joltPromise;
};

/** 動くもの（ソフトボディと馬の体の当たり判定）だけのレイヤー。止まっている物体は使わない */
const LAYER_MOVING = 0;

export interface SoftBodyVertexSpec {
  position: THREE.Vector3;
  /** 1 / 質量。0 にした頂点は物理では動かず、コードで位置を決める（尻尾の付け根・旗の竿の側） */
  invMass: number;
}

export interface SoftBodyBuilder {
  /** 2 つの頂点の距離を保つ拘束（伸び）。compliance が大きいほど柔らかい */
  edge: (a: number, b: number, compliance: number) => void;
  /** 頂点 b が頂点 a から元の距離より離れないようにする拘束（Long Range Attachment。伸びすぎを防ぐ） */
  longRange: (a: number, b: number) => void;
  /** 三角形の面（布）。面を作ってから clothConstraints で伸び・せん断・曲げの拘束をまとめて作る */
  face: (a: number, b: number, c: number) => void;
}

export interface SoftBodyOptions {
  /** 頂点の当たり判定の半径 */
  vertexRadius: number;
  /** 1 ステップの反復回数（多いほど硬く、正確） */
  iterations: number;
  /** 布のとき: 面から伸び・せん断・曲げ（二面角）の拘束を作る。compliance は順に伸び・せん断・曲げ */
  cloth?: { compliance: number; shearCompliance: number; bendCompliance: number };
}

/**
 * ソフトボディ 1 つ。頂点の位置と速度は WebAssembly のメモリを直接読み書きする。
 * ボディは原点に置いたまま動かさない（mUpdatePosition = false）ので、頂点の座標はそのままワールド座標
 */
/** 物理エンジンを 1 回に進める時間の上限（描画が重くて 1 コマが長いときも、これより長くは進めない） */
export const MAX_PHYSICS_STEP = 1 / 30;

export class SoftBody {
  readonly count: number;
  private readonly base: number;
  private readonly stride: number;
  private readonly positionOffset: number;
  private readonly velocityOffset: number;

  constructor(
    private readonly world: SoftBodyWorld,
    private readonly body: Jolt.Body,
    count: number
  ) {
    const J = world.J;
    const properties = J.castObject(body.GetMotionProperties(), J.SoftBodyMotionProperties);
    const first = properties.GetVertex(0);
    const second = properties.GetVertex(Math.min(1, count - 1));
    this.count = count;
    this.base = J.getPointer(first);
    this.stride = count > 1 ? J.getPointer(second) - this.base : 0;
    this.positionOffset = J.getPointer(first.mPosition) - this.base;
    this.velocityOffset = J.getPointer(first.mVelocity) - this.base;
  }

  /** i 番目の頂点の位置が入っている HEAPF32 の添字 */
  private positionIndex(i: number) {
    return (this.base + i * this.stride + this.positionOffset) >> 2;
  }

  private velocityIndex(i: number) {
    return (this.base + i * this.stride + this.velocityOffset) >> 2;
  }

  getPosition(i: number, target: THREE.Vector3) {
    // メモリが伸びると配列が作り直されるので、毎回モジュールから取り直す
    const heap = this.world.J.HEAPF32;
    const p = this.positionIndex(i);
    return target.set(heap[p], heap[p + 1], heap[p + 2]);
  }

  setPosition(i: number, x: number, y: number, z: number) {
    const heap = this.world.J.HEAPF32;
    const p = this.positionIndex(i);
    heap[p] = x;
    heap[p + 1] = y;
    heap[p + 2] = z;
  }

  getVelocity(i: number, target: THREE.Vector3) {
    const heap = this.world.J.HEAPF32;
    const v = this.velocityIndex(i);
    return target.set(heap[v], heap[v + 1], heap[v + 2]);
  }

  setVelocity(i: number, x: number, y: number, z: number) {
    const heap = this.world.J.HEAPF32;
    const v = this.velocityIndex(i);
    heap[v] = x;
    heap[v + 1] = y;
    heap[v + 2] = z;
  }

  addVelocity(i: number, x: number, y: number, z: number) {
    const heap = this.world.J.HEAPF32;
    const v = this.velocityIndex(i);
    heap[v] += x;
    heap[v + 1] += y;
    heap[v + 2] += z;
  }

  dispose() {
    this.world.removeBody(this.body);
  }
}

/** 位置と向きをコードで決める当たり判定（馬の尻と後ろ脚）。ソフトボディの頂点がぶつかって押し出される */
export class KinematicCollider {
  constructor(
    private readonly world: SoftBodyWorld,
    private readonly body: Jolt.Body
  ) {}

  /** 次のステップまでにこの位置・向きへ動かす（動いた速さが当たったときの押し出しに効く） */
  moveTo(position: THREE.Vector3, quaternion: THREE.Quaternion, dt: number) {
    this.world.moveKinematic(this.body, position, quaternion, dt);
  }

  /** 瞬間移動（ゲートに戻したときなど） */
  teleport(position: THREE.Vector3, quaternion: THREE.Quaternion) {
    this.world.teleport(this.body, position, quaternion);
  }

  dispose() {
    this.world.removeBody(this.body);
  }
}

export class SoftBodyWorld {
  private readonly bodyInterface: Jolt.BodyInterface;
  // MoveKinematic などに渡す値は使い回す（呼ぶたびに WebAssembly 側のメモリを確保しない）
  private readonly tempPosition: Jolt.RVec3;
  private readonly tempRotation: Jolt.Quat;
  private disposed = false;

  private constructor(
    readonly J: JoltApi,
    private readonly jolt: Jolt.JoltInterface
  ) {
    this.bodyInterface = jolt.GetPhysicsSystem().GetBodyInterface();
    this.tempPosition = new J.RVec3(0, 0, 0);
    this.tempRotation = new J.Quat(0, 0, 0, 1);
  }

  /**
   * @param gravity 重力加速度（ワールド単位/秒²。1m ≒ 1.5 単位なので 9.8 × 1.5）
   */
  static async create(gravity: number) {
    const J = await loadJolt();
    const settings = new J.JoltSettings();
    const objectFilter = new J.ObjectLayerPairFilterTable(1);
    objectFilter.EnableCollision(LAYER_MOVING, LAYER_MOVING);
    const broadPhaseLayer = new J.BroadPhaseLayer(0);
    const broadPhase = new J.BroadPhaseLayerInterfaceTable(1, 1);
    broadPhase.MapObjectToBroadPhaseLayer(LAYER_MOVING, broadPhaseLayer);
    settings.mObjectLayerPairFilter = objectFilter;
    settings.mBroadPhaseLayerInterface = broadPhase;
    settings.mObjectVsBroadPhaseLayerFilter = new J.ObjectVsBroadPhaseLayerFilterTable(broadPhase, 1, objectFilter, 1);
    const jolt = new J.JoltInterface(settings);
    J.destroy(settings);
    J.destroy(broadPhaseLayer);
    const gravityVector = new J.Vec3(0, -gravity, 0);
    jolt.GetPhysicsSystem().SetGravity(gravityVector);
    J.destroy(gravityVector);
    return new SoftBodyWorld(J, jolt);
  }

  private setTemp(position: THREE.Vector3, quaternion: THREE.Quaternion) {
    this.tempPosition.Set(position.x, position.y, position.z);
    this.tempRotation.Set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
  }

  createSphere(radius: number) {
    return this.createKinematic(new this.J.SphereShape(radius));
  }

  /** Y 軸に沿ったカプセル（中心が原点。halfHeight は円柱部分の半分の長さ） */
  createCapsule(halfHeight: number, radius: number) {
    return this.createKinematic(new this.J.CapsuleShape(halfHeight, radius));
  }

  private createKinematic(shape: Jolt.Shape) {
    const J = this.J;
    // 最初は地面の下に置いておき、馬の位置へは最初の更新で瞬間移動させる
    this.tempPosition.Set(0, -1000, 0);
    this.tempRotation.Set(0, 0, 0, 1);
    const settings = new J.BodyCreationSettings(shape, this.tempPosition, this.tempRotation, J.EMotionType_Kinematic, LAYER_MOVING);
    const body = this.bodyInterface.CreateBody(settings);
    J.destroy(settings);
    this.bodyInterface.AddBody(body.GetID(), J.EActivation_Activate);
    return new KinematicCollider(this, body);
  }

  /**
   * ソフトボディを作る
   * @param build 頂点のあいだの拘束を足す
   */
  createSoftBody(vertices: SoftBodyVertexSpec[], options: SoftBodyOptions, build: (builder: SoftBodyBuilder) => void) {
    const J = this.J;
    const shared = new J.SoftBodySharedSettings();
    const vertex = new J.SoftBodySharedSettingsVertex();
    for (const v of vertices) {
      // 代入は値のコピーなので、作った Float3 はすぐ解放する
      const position = new J.Float3(v.position.x, v.position.y, v.position.z);
      vertex.mPosition = position;
      J.destroy(position);
      vertex.mInvMass = v.invMass;
      shared.mVertices.push_back(vertex);
    }
    J.destroy(vertex);
    let hasFaces = false;
    build({
      edge: (a, b, compliance) => {
        const edge = new J.SoftBodySharedSettingsEdge(a, b, compliance);
        shared.mEdgeConstraints.push_back(edge);
        J.destroy(edge);
      },
      longRange: (a, b) => {
        const lra = new J.SoftBodySharedSettingsLRA(a, b, 0);
        shared.mLRAConstraints.push_back(lra);
        J.destroy(lra);
      },
      face: (a, b, c) => {
        const face = new J.SoftBodySharedSettingsFace(a, b, c, 0);
        shared.AddFace(face);
        J.destroy(face);
        hasFaces = true;
      },
    });
    if (options.cloth && hasFaces) {
      const attributes = new J.SoftBodySharedSettingsVertexAttributes();
      attributes.mCompliance = options.cloth.compliance;
      attributes.mShearCompliance = options.cloth.shearCompliance;
      attributes.mBendCompliance = options.cloth.bendCompliance;
      // 竿の側から測った距離より離れないようにして、強い風でも布が伸びて見えないようにする
      attributes.mLRAType = J.SoftBodySharedSettings_ELRAType_EuclideanDistance;
      shared.CreateConstraints(attributes, 1, J.SoftBodySharedSettings_EBendType_Dihedral);
      J.destroy(attributes);
    } else {
      shared.CalculateEdgeLengths();
      shared.CalculateLRALengths();
    }
    shared.Optimize();

    this.tempPosition.Set(0, 0, 0);
    this.tempRotation.Set(0, 0, 0, 1);
    const settings = new J.SoftBodyCreationSettings(shared, this.tempPosition, this.tempRotation, LAYER_MOVING);
    // ボディは原点に置いたまま（頂点の座標をそのままワールド座標として扱う）
    settings.mUpdatePosition = false;
    settings.mVertexRadius = options.vertexRadius;
    settings.mNumIterations = options.iterations;
    // 空気抵抗はコードの側で、風との相対速度から頂点ごとに与える
    settings.mLinearDamping = 0;
    settings.mAllowSleeping = false;
    settings.mFriction = 0.3;
    settings.mFacesDoubleSided = true;
    const body = this.bodyInterface.CreateSoftBody(settings);
    J.destroy(settings);
    this.bodyInterface.AddBody(body.GetID(), J.EActivation_Activate);
    return new SoftBody(this, body, vertices.length);
  }

  moveKinematic(body: Jolt.Body, position: THREE.Vector3, quaternion: THREE.Quaternion, dt: number) {
    this.setTemp(position, quaternion);
    this.bodyInterface.MoveKinematic(body.GetID(), this.tempPosition, this.tempRotation, Math.max(dt, 1e-4));
  }

  teleport(body: Jolt.Body, position: THREE.Vector3, quaternion: THREE.Quaternion) {
    this.setTemp(position, quaternion);
    this.bodyInterface.SetPositionAndRotation(
      body.GetID(),
      this.tempPosition,
      this.tempRotation,
      this.J.EActivation_Activate
    );
  }

  removeBody(body: Jolt.Body) {
    if (this.disposed) return;
    const id = body.GetID();
    this.bodyInterface.RemoveBody(id);
    this.bodyInterface.DestroyBody(id);
  }

  /**
   * 時間を進める。速く動く馬の脚に毛がすり抜けないよう、当たり判定は 2 回に分けて解く
   */
  step(dt: number) {
    if (dt <= 0) return;
    this.jolt.Step(Math.min(dt, MAX_PHYSICS_STEP), 2);
  }

  dispose() {
    this.disposed = true;
    this.J.destroy(this.tempPosition);
    this.J.destroy(this.tempRotation);
    this.J.destroy(this.jolt);
  }
}
