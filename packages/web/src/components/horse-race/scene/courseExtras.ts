import * as THREE from "three";
import { PATROL_TOWER_X } from "./courseProps";
import { COURSE_END, COURSE_START, FINISH_X, POND, STANDS, TRACK_HALF_WIDTH, VISION_BASE } from "./environment";
import { createExtrasTextures } from "./extrasTextures";
import type { ClothFlags } from "./clothFlag";
import { createFlagDepthMaterial, createFlagMaterial, createFlagUniforms, type FlagUniforms } from "./flag";
import { loadModel, takeNode, type ModelNode, type ModelPart } from "./models";
import { createConcreteMaterial } from "./props";
import { createRustyMetalMaterial } from "./rust";
import { BUMP_GLSL, COURSE_UNIFORMS_GLSL, type CourseUniforms } from "./surfaceCommon";

// コース全般の備品・車両・植栽・係員（JRA の競馬場で見かけるもの）。
// Blender で作った public/models/course-extras.glb のノードを、シーン側のマテリアルに差し替えて置く。
// 同じノードを何か所にも置くので、マテリアルごとに InstancedMesh にまとめる（置く数が増えても描画の呼び出しは増えない）。
// glb のノードは +X が前（車両の進行方向・人の向き）、原点は接地面の中心。
//
// 置き場所（走路は x 方向。+Z が内馬場、-Z がスタンド側）
// - 発走地点で変わるもの: ゲート車・係員・カンパイ係員・救急車
//   救急車はコースの内側で待機する（東京競馬場では 4 台。落馬の起きやすい所に寄せ、発走地点によって配置を変える）
// - 変わらないもの: 馬運車・ハロー車・散水車・写真判定カメラの塔・障害コースの生垣と竹柵・外周の生垣・植え込み・花壇・地下馬道

const NODE_NAMES = [
  "GateTractor",
  "Ambulance",
  "AmbulanceBeacon",
  "HorseAmbulance",
  "HarrowTractor",
  "WaterTruck",
  "StaffPerson",
  "FlagPerson",
  "FlagPersonCloth",
  "SteepleHedge",
  "SteepleFence",
  "HedgeSegment",
  "ShrubCluster",
  "FlowerBed",
  "TunnelEntrance",
  "PhotoFinishTower",
] as const;
type ExtraNode = (typeof NODE_NAMES)[number];

/** 影を落とさないもの（地面に張りつく花壇と、地面より下に掘り込んだ地下馬道） */
const NO_SHADOW = new Set<ExtraNode>(["FlowerBed", "TunnelEntrance"]);

/** ノードの +X（前）をどちらへ向けるか（Y 軸まわりの回転） */
const FACE = {
  /** ゴールの方（+X） */
  finish: 0,
  /** スタートの方（-X） */
  start: Math.PI,
  /** 内馬場の方（+Z） */
  infield: -Math.PI / 2,
  /** スタンドの方（-Z） */
  stands: Math.PI / 2,
};

/** 内馬場の帯。走路の内側から順に、救急車などが待機する通路・障害コース・外周の生垣 */
const INFIELD = {
  serviceZ: TRACK_HALF_WIDTH + 9,
  steepleZ: TRACK_HALF_WIDTH + 16,
  hedgeZ: TRACK_HALF_WIDTH + 23,
};

export interface CourseExtraModels {
  nodes: Map<ExtraNode, ModelNode>;
  /** 救急車のローカル座標で、回転灯を載せる位置 */
  beaconAttachment: THREE.Vector3;
  /** カンパイ係員のローカル座標で、白旗の布を付ける位置 */
  clothAttachment: THREE.Vector3;
}

const toVector = (value: unknown, fallback: THREE.Vector3) =>
  Array.isArray(value) && value.length === 3
    ? new THREE.Vector3(Number(value[0]), Number(value[1]), Number(value[2]))
    : fallback;

/** course-extras.glb を読み込む。ノードが欠けていたら失敗にする（備品なしのまま走らせる） */
export const loadCourseExtraModels = async (): Promise<CourseExtraModels> => {
  const gltf = await loadModel("course-extras.glb");
  const nodes = new Map<ExtraNode, ModelNode>();
  for (const name of NODE_NAMES) {
    const node = takeNode(gltf, name);
    if (!node || node.parts.length === 0) throw new Error(`course-extras.glb: ${name} not found`);
    // 側面の塗装の面は、glTF の UV（画像の上が v = 0）を Canvas のテクスチャ（下が v = 0）に合わせて縦に反転しておく
    for (const part of node.parts) {
      const uv = part.geometry.getAttribute("uv") as THREE.BufferAttribute | undefined;
      const isLivery = part.materialName.startsWith("Livery");
      if (!isLivery || !uv) continue;
      for (let i = 0; i < uv.count; i += 1) uv.setY(i, 1 - uv.getY(i));
    }
    nodes.set(name, node);
  }
  const extras = (name: string): Record<string, unknown> => gltf.scene.getObjectByName(name)?.userData ?? {};
  return {
    nodes,
    beaconAttachment: toVector(extras("Ambulance").beacon_attachment, new THREE.Vector3(1.5, 3.26, 0)),
    clothAttachment: toVector(extras("FlagPerson").cloth_attachment, new THREE.Vector3(0.15, 3.65, 0.7)),
  };
};

/** 種から決まる乱数（mulberry32）。植え込みの散らし方を毎回同じにする */
const seededRandom = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

interface Placement {
  node: ExtraNode;
  x: number;
  z: number;
  /** 地面からの高さ（回転灯を屋根に載せるときなど） */
  y?: number;
  angle?: number;
  scale?: number;
}

// ----- 3D テクスチャで細部を描くマテリアル（extrasTextures.ts） -----

const DETAIL_VERTEX = /* glsl */ `
  #include <begin_vertex>
  #ifdef USE_INSTANCING
    mat4 extraModel = modelMatrix * instanceMatrix;
  #else
    mat4 extraModel = modelMatrix;
  #endif
  vExtraWorld = (extraModel * vec4(transformed, 1.0)).xyz;
  vExtraNormal = normalize(mat3(extraModel) * objectNormal);
`;

/**
 * 生垣・低木の葉（foliage: R 葉の塊の明暗 G 新芽 B 茂みの奥行き A 枯れ葉）。
 * 大小 2 つの大きさで引いて、遠目の茂みの塊と近くの葉の粒を重ねる
 */
const FOLIAGE = {
  color: /* glsl */ `
    vec4 leafBroad = texture(uDetail, vExtraWorld / 2.0);
    vec4 leafFine = texture(uDetail, vExtraWorld / 0.6 + 0.37);
    float leafClump = mix(leafBroad.r, leafFine.r, 0.55);
    float leafDepth = mix(leafBroad.b, leafFine.b, 0.5);
    vec3 leafColor = diffuseColor.rgb * (0.8 + 0.5 * leafClump);
    leafColor = mix(leafColor, leafColor * vec3(1.25, 1.3, 0.7), leafBroad.g * 0.5);
    // 茂みの奥の隙間は光が届かず暗い
    leafColor *= mix(0.6, 1.08, smoothstep(0.15, 0.75, leafDepth));
    leafColor = mix(leafColor, vec3(0.42, 0.3, 0.14), leafFine.a * 0.6);
    // 濡れた葉は暗く、艶が出る
    leafColor *= 1.0 - 0.2 * uWetness;
    diffuseColor.rgb = leafColor;
    float detailHeight = leafDepth * 0.08;
    float detailPeriod = 0.6;
  `,
  roughness: /* glsl */ `
    roughnessFactor = mix(0.9, 0.55, uWetness);
  `,
};

/** スロープの路面（pavement: R 骨材の粒 G 汚れ B ひび割れ A 高さ） */
const PAVEMENT = {
  color: /* glsl */ `
    vec4 paveBroad = texture(uDetail, vExtraWorld / 4.0);
    vec4 paveFine = texture(uDetail, vExtraWorld / 1.1 + 0.21);
    vec3 paveColor = diffuseColor.rgb * (0.8 + 0.4 * paveFine.r);
    paveColor *= 1.0 - 0.3 * smoothstep(0.45, 0.85, paveBroad.g);
    paveColor = mix(paveColor, paveColor * 0.4, smoothstep(0.3, 0.7, paveBroad.b));
    paveColor *= 1.0 - 0.35 * uWetness;
    diffuseColor.rgb = paveColor;
    float detailHeight = mix(paveBroad.a, paveFine.a, 0.6) * 0.012;
    float detailPeriod = 1.1;
  `,
  roughness: /* glsl */ `
    roughnessFactor = mix(roughnessFactor, 0.3, uWetness * 0.8);
  `,
};

/** 竹（テクスチャは使わず、0.3 ごとの節と、竹 1 本ごとの日焼けのむらを座標から作る） */
const BAMBOO = {
  color: /* glsl */ `
    float bambooSeed = fract(sin(dot(floor(vExtraWorld.xz * 8.0), vec2(12.9898, 78.233))) * 43758.5453);
    float bambooNode = smoothstep(0.9, 0.97, fract(vExtraWorld.y / 0.3 + bambooSeed));
    diffuseColor.rgb *= (0.8 + 0.35 * bambooSeed) * (1.0 - 0.35 * bambooNode);
    float detailHeight = -bambooNode * 0.01;
    float detailPeriod = 0.3;
  `,
  roughness: "",
};

const NORMAL_FROM_DETAIL = /* glsl */ `
  {
    // 凹凸の模様が 1 画素より細かくなる遠くでは平らに寄せて、ちらつかせない
    float detailFine = 1.0 - clamp(length(fwidth(vExtraWorld / detailPeriod)) * 3.0, 0.0, 1.0);
    vec3 detailNormal = bumpNormal(vExtraWorld, normalize(vExtraNormal) * faceDirection, detailHeight * detailFine);
    normal = normalize((viewMatrix * vec4(detailNormal, 0.0)).xyz);
  }
`;

const createDetailMaterial = (
  uniforms: CourseUniforms,
  detail: THREE.Data3DTexture | null,
  chunks: { color: string; roughness: string },
  parameters: THREE.MeshStandardMaterialParameters
) => {
  const material = new THREE.MeshStandardMaterial(parameters);
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, { uDetail: { value: detail } });
    shader.vertexShader =
      "varying vec3 vExtraWorld;\nvarying vec3 vExtraNormal;\n" +
      shader.vertexShader.replace("#include <begin_vertex>", DETAIL_VERTEX);
    shader.fragmentShader =
      "varying vec3 vExtraWorld;\nvarying vec3 vExtraNormal;\nuniform sampler3D uDetail;\n" +
      COURSE_UNIFORMS_GLSL +
      BUMP_GLSL +
      shader.fragmentShader
        .replace("#include <color_fragment>", "#include <color_fragment>\n" + chunks.color)
        .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n" + chunks.roughness)
        .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\n" + NORMAL_FROM_DETAIL);
  };
  return material;
};

/**
 * コース全般の備品を組み立てる。ジオメトリとマテリアルは使い回し、発走地点が変わったら距離で動くものだけを置き直す
 */
export class CourseExtras {
  readonly group = new THREE.Group();
  private readonly layoutGroup = new THREE.Group();
  private readonly materials = new Map<string, THREE.Material>();
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private layoutDisposables: Array<{ dispose: () => void }> = [];
  private readonly textures = createExtrasTextures();
  private readonly flagUniforms: FlagUniforms;
  private readonly flagDepth: THREE.Material;
  private readonly matrix = new THREE.Matrix4();
  private readonly quaternion = new THREE.Quaternion();
  private readonly up = new THREE.Vector3(0, 1, 0);
  /** 物理エンジンで布を動かす旗。物理エンジンを読み込むまでは null で、旗は頂点シェーダーでなびかせる */
  private clothFlags: ClothFlags | null = null;

  constructor(
    private readonly models: CourseExtraModels,
    private readonly uniforms: CourseUniforms,
    sunDirection: THREE.Vector3
  ) {
    this.disposables.push(this.textures);
    this.flagUniforms = createFlagUniforms(sunDirection);
    this.flagDepth = this.track(createFlagDepthMaterial(this.flagUniforms));
    const fixedGroup = new THREE.Group();
    this.disposables.push(...this.addInstances(this.fixedPlacements(), fixedGroup));
    this.group.add(fixedGroup, this.layoutGroup);
  }

  /** 物理エンジンの旗に切り替える（次に置き直す旗から物理で動かす） */
  setClothFlags(flags: ClothFlags | null) {
    this.clothFlags = flags;
  }

  /** 白旗をなびかせる */
  update(time: number) {
    this.flagUniforms.uFlagTime.value = time;
  }

  /** 発走地点に合わせて、ゲート車・係員・カンパイ係員・救急車を置き直す */
  layout(startX: number) {
    this.layoutDisposables.forEach((d) => d.dispose());
    this.layoutDisposables = [];
    this.layoutGroup.clear();

    const placements: Placement[] = [];
    const outside = TRACK_HALF_WIDTH;
    // ゲート車は外ラチのすぐ外で、ゲートの方を向いて待つ。
    // 多頭数だとゲートが走路の幅いっぱいになり、つないだままでは外ラチにかかるので、切り離して待機させる
    placements.push({ node: "GateTractor", x: startX - 9, z: -(outside + 4), angle: FACE.infield });
    // ゲートの両脇の係員（発馬機の係員はゲートの後ろで馬を誘導し、発走の直前に離れる）
    placements.push(
      { node: "StaffPerson", x: startX + 1.6, z: -(outside + 1.9), angle: FACE.infield },
      { node: "StaffPerson", x: startX - 1.4, z: -(outside + 2.3), angle: FACE.infield + 0.35 },
      { node: "StaffPerson", x: startX - 6.6, z: -(outside + 5.2), angle: 0.5 },
      { node: "StaffPerson", x: startX - 2.6, z: outside + 2.1, angle: FACE.stands },
      { node: "StaffPerson", x: startX + 0.9, z: outside + 2.5, angle: FACE.stands - 0.3 }
    );
    // カンパイ係員はゲートの 200m 先で、走路の方を向いて白旗を持って立つ（やり直しのときに旗を振る）
    const flagPerson: Placement = { node: "FlagPerson", x: startX + 32, z: -(outside + 1.8), angle: FACE.infield };
    placements.push(flagPerson);

    for (const x of this.ambulanceXs(startX)) {
      const ambulance: Placement = { node: "Ambulance", x, z: INFIELD.serviceZ, angle: FACE.finish };
      placements.push(ambulance, this.attach(ambulance, "AmbulanceBeacon", this.models.beaconAttachment));
      // 救急隊員が走路の方を向いて見守る
      placements.push({ node: "StaffPerson", x: x - 4.6, z: INFIELD.serviceZ - 1.6, angle: FACE.stands });
    }

    this.layoutDisposables.push(...this.addInstances(placements, this.layoutGroup));
    this.addFlagCloth(flagPerson);
  }

  /**
   * 救急車の待機場所。スタート直後・道中・直線の入り口・ゴールの先の 4 か所を候補にし、
   * 短い距離で候補どうしが近すぎるときは減らす。ほかの備品と重なる所は少しずらす
   */
  private ambulanceXs(startX: number) {
    const stretchEntrance = FINISH_X - 85;
    const candidates = [startX + 18, (startX + stretchEntrance) / 2, stretchEntrance, FINISH_X + 25];
    const avoid = [...PATROL_TOWER_X, FINISH_X - 140, FINISH_X, FINISH_X + 50, FINISH_X + 68];
    const kept: number[] = [];
    for (const candidate of candidates) {
      let x = candidate;
      for (let i = 0; i < 4; i += 1) {
        const blocked = avoid.some((a) => Math.abs(a - x) < 9);
        if (!blocked) break;
        x += 10;
      }
      const tooClose = kept.some((k) => Math.abs(k - x) < 30);
      if (!tooClose) kept.push(x);
    }
    return kept;
  }

  /** 発走地点によらず同じ所に置くもの */
  private fixedPlacements() {
    const placements: Placement[] = [];
    const inside = TRACK_HALF_WIDTH;
    // 馬運車・ハロー車・散水車は内馬場の直線側で待機（ハロー車と散水車はレースの合間に馬場を整える）
    placements.push(
      { node: "HorseAmbulance", x: FINISH_X - 140, z: INFIELD.serviceZ + 0.5, angle: FACE.finish },
      { node: "HarrowTractor", x: FINISH_X + 50, z: INFIELD.serviceZ + 1.5, angle: FACE.finish },
      { node: "WaterTruck", x: FINISH_X + 68, z: INFIELD.serviceZ + 0.5, angle: FACE.finish }
    );
    // 写真判定のカメラはゴール線の延長上から、ゴール線に沿って走路を写す
    placements.push({ node: "PhotoFinishTower", x: FINISH_X, z: INFIELD.serviceZ + 0.5, angle: FACE.stands });
    // 地下馬道はスタンドの先。地下から坂を上がった馬が、ゴール側へ向かって走路に出る
    placements.push({ node: "TunnelEntrance", x: FINISH_X + 95, z: -(inside + 9), angle: FACE.start });

    // 障害コースの生垣と竹柵（障害レースの日以外もコースに置いてある）
    for (const x of [FINISH_X - 20, FINISH_X - 240, FINISH_X - 440]) {
      placements.push({ node: "SteepleHedge", x, z: INFIELD.steepleZ });
    }
    for (const x of [FINISH_X - 75, FINISH_X - 340, FINISH_X - 560]) {
      placements.push({ node: "SteepleFence", x, z: INFIELD.steepleZ });
    }

    // 外周の生垣。内馬場は障害コースの奥（池の前は空ける）、スタンド側は外の帯の外（スタンドの前と地下馬道は空ける）
    const pondHalf = POND.radiusX * Math.sqrt(1 - ((INFIELD.hedgeZ - 0.6 - POND.z) / POND.radiusZ) ** 2) + 4;
    const standSideZ = -(inside + 7.5);
    const runs = [
      { z: INFIELD.hedgeZ, from: COURSE_START + 20, to: POND.x - pondHalf },
      { z: INFIELD.hedgeZ, from: POND.x + pondHalf, to: COURSE_END - 10 },
      { z: standSideZ, from: COURSE_START + 20, to: STANDS.start - 25 },
      { z: standSideZ, from: FINISH_X + 110, to: COURSE_END - 10 },
    ];
    const segment = 6;
    for (const run of runs) {
      for (let x = run.from + segment / 2; x + segment / 2 <= run.to; x += segment) {
        placements.push({ node: "HedgeSegment", x, z: run.z });
      }
    }

    // 植え込み: 池のほとり、ターフビジョンの両脇、ゴールの先の内馬場、地下馬道の両脇
    const random = seededRandom(17);
    const shrub = (x: number, z: number) =>
      placements.push({ node: "ShrubCluster", x, z, angle: random() * Math.PI * 2, scale: 0.8 + random() * 0.5 });
    for (let i = 0; i < 10; i += 1) {
      const a = (i / 10) * Math.PI * 2 + 0.35 + (random() - 0.5) * 0.3;
      const r = 1.18 + random() * 0.1;
      shrub(POND.x + Math.cos(a) * POND.radiusX * r, POND.z + Math.sin(a) * POND.radiusZ * r);
    }
    shrub(VISION_BASE.x - 24, VISION_BASE.z - 1);
    shrub(VISION_BASE.x + 24, VISION_BASE.z - 1);
    shrub(FINISH_X + 10, inside + 14);
    shrub(FINISH_X + 22, inside + 15.5);
    shrub(FINISH_X + 86, -(inside + 14.5));
    shrub(FINISH_X + 104, -(inside + 14.5));
    // 花壇はターフビジョンの前、生垣の手前
    for (const dx of [-12, 12]) {
      placements.push({ node: "FlowerBed", x: VISION_BASE.x + dx, z: INFIELD.hedgeZ - 2.7 });
    }
    return placements;
  }

  /** 親のノードのローカル座標 offset に、子のノードを載せる（救急車の屋根の回転灯など） */
  private attach(parent: Placement, node: ExtraNode, offset: THREE.Vector3): Placement {
    const angle = parent.angle ?? 0;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return {
      node,
      x: parent.x + offset.x * cos + offset.z * sin,
      y: (parent.y ?? 0) + offset.y,
      z: parent.z - offset.x * sin + offset.z * cos,
      angle,
    };
  }

  private placementMatrix(placement: Placement) {
    const scale = placement.scale ?? 1;
    this.quaternion.setFromAxisAngle(this.up, placement.angle ?? 0);
    return this.matrix
      .compose(
        new THREE.Vector3(placement.x, placement.y ?? 0, placement.z),
        this.quaternion,
        new THREE.Vector3(scale, scale, scale)
      )
      .clone();
  }

  /** ノードごとにまとめて、マテリアルごとの InstancedMesh にする（旗の布は個別に作るので除く） */
  private addInstances(placements: Placement[], target: THREE.Group) {
    const byNode = new Map<ExtraNode, THREE.Matrix4[]>();
    for (const placement of placements) {
      const list = byNode.get(placement.node) ?? [];
      list.push(this.placementMatrix(placement));
      byNode.set(placement.node, list);
    }
    const created: THREE.InstancedMesh[] = [];
    for (const [name, matrices] of byNode) {
      const node = this.models.nodes.get(name);
      if (!node) continue;
      for (const part of node.parts) {
        const mesh = new THREE.InstancedMesh(part.geometry, this.material(name, part), matrices.length);
        matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
        mesh.computeBoundingSphere();
        mesh.castShadow = !NO_SHADOW.has(name);
        mesh.receiveShadow = true;
        target.add(mesh);
        created.push(mesh);
      }
    }
    return created;
  }

  /** カンパイ係員の白旗。布は旗のシェーダー（flag.ts）でなびかせる */
  private addFlagCloth(person: Placement) {
    const node = this.models.nodes.get("FlagPersonCloth");
    if (!node) return;
    const at = this.attach(person, "FlagPersonCloth", this.models.clothAttachment);
    if (this.clothFlags) {
      // 布は物理で動かす。竿の上端の位置だけを置いておく
      const anchor = new THREE.Object3D();
      anchor.position.set(at.x, at.y ?? 0, at.z);
      this.layoutGroup.add(anchor);
      this.layoutDisposables.push(this.clothFlags.create(anchor, this.simulatedFlagMaterial()));
      return;
    }
    for (const part of node.parts) {
      const cloth = new THREE.Mesh(part.geometry, this.material("FlagPersonCloth", part));
      cloth.customDepthMaterial = this.flagDepth;
      cloth.position.set(at.x, at.y ?? 0, at.z);
      cloth.rotation.y = at.angle ?? 0;
      this.layoutGroup.add(cloth);
    }
  }

  private simulatedFlagMaterial() {
    const cached = this.materials.get("FlagClothSimulated");
    if (cached) return cached;
    const material = this.track(createFlagMaterial(this.flagUniforms, { color: "#f4f4f0", simulated: true }));
    this.materials.set("FlagClothSimulated", material);
    return material;
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  /** Blender 側のマテリアル名 → シーンのマテリアル。車両の塗装はほとんど錆びていない */
  private material(node: ExtraNode, part: ModelPart): THREE.Material {
    const name = part.materialName;
    // 側面の塗装は車両ごとに絵が違う
    const key = name.startsWith("Livery") ? `${node}:${name}` : name;
    const cached = this.materials.get(key);
    if (cached) return cached;
    const isHorseAmbulance = node === "HorseAmbulance";
    let material: THREE.Material;
    switch (name) {
      case "PaintWhite":
        material = createRustyMetalMaterial({ paint: "#f1f2ef", rust: 0.04, scale: 1.6, roughness: 0.32, metalness: 0.12 });
        break;
      case "PaintRed":
        material = createRustyMetalMaterial({ paint: "#c62828", rust: 0.04, scale: 1.6, roughness: 0.32, metalness: 0.12 });
        break;
      case "PaintGreen":
        material = createRustyMetalMaterial({ paint: "#1f6b2e", rust: 0.06, scale: 1.6, roughness: 0.35, metalness: 0.12 });
        break;
      case "PaintYellow":
        material = createRustyMetalMaterial({ paint: "#e2a019", rust: 0.08, scale: 1.6, roughness: 0.38, metalness: 0.12 });
        break;
      case "SteelGrey":
        material = createRustyMetalMaterial({ paint: "#9ea3a8", rust: 0.2, scale: 1.2, roughness: 0.5, metalness: 0.4 });
        break;
      case "Glass":
        // 環境マップを使わないので、金属寄りにすると何も映らず真っ黒になる。空の色を薄く映した暗い青灰色にする
        material = new THREE.MeshStandardMaterial({ color: "#3e5266", roughness: 0.12, metalness: 0.1 });
        break;
      case "Tire":
        material = new THREE.MeshStandardMaterial({ color: "#1c1c1e", roughness: 0.92 });
        break;
      case "Dark":
        material = new THREE.MeshStandardMaterial({ color: "#26282c", roughness: 0.55, metalness: 0.3 });
        break;
      case "Concrete":
        material = createConcreteMaterial(this.uniforms, { color: "#b9b4ab" });
        break;
      case "Asphalt":
        material = createDetailMaterial(this.uniforms, this.textures.pavement, PAVEMENT, {
          color: "#45464a",
          roughness: 0.85,
        });
        break;
      case "Foliage":
        material = createDetailMaterial(this.uniforms, this.textures.foliage, FOLIAGE, {
          color: "#447f36",
          roughness: 0.9,
        });
        break;
      case "Bamboo":
        material = createDetailMaterial(this.uniforms, null, BAMBOO, { color: "#b7a160", roughness: 0.6 });
        break;
      case "Wood":
        material = new THREE.MeshStandardMaterial({ color: "#6e4c2e", roughness: 0.85 });
        break;
      case "Flower":
        // 花ごとの色は頂点カラー（Blender 側で付けた COLOR_0）
        material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });
        break;
      case "Soil":
        material = new THREE.MeshStandardMaterial({ color: "#4a3424", roughness: 1 });
        break;
      case "Lamp":
        // 待機中の救急車は回転灯を消している。赤いレンズがほんのり見える程度
        material = new THREE.MeshStandardMaterial({ color: "#ff3b2f", emissive: "#ff2014", emissiveIntensity: 0.35 });
        break;
      case "FlagCloth":
        material = createFlagMaterial(this.flagUniforms, { color: "#f4f4f0" });
        break;
      case "Livery":
      case "LiveryFrontU0":
        // -Z 側の側面（前が u = 0）
        material = new THREE.MeshStandardMaterial({
          map: isHorseAmbulance ? this.textures.horseAmbulanceLivery : this.textures.ambulanceLivery,
          roughness: 0.32,
          metalness: 0.1,
        });
        break;
      case "LiveryFrontU1":
        // +Z 側の側面（前が u = 1）。マークと文字の並びを左右反転させた絵（文字は読める向き）
        material = new THREE.MeshStandardMaterial({
          map: isHorseAmbulance ? this.textures.horseAmbulanceLiveryFrontRight : this.textures.ambulanceLiveryFrontRight,
          roughness: 0.32,
          metalness: 0.1,
        });
        break;
      default:
        // 人の肌・上着・ズボン・帽子は Blender 側の色をそのまま使う
        material = new THREE.MeshStandardMaterial({ color: part.color, roughness: 0.75 });
    }
    this.materials.set(key, this.track(material));
    return material;
  }

  dispose() {
    this.layoutDisposables.forEach((d) => d.dispose());
    this.disposables.forEach((d) => d.dispose());
    for (const node of this.models.nodes.values()) {
      node.parts.forEach((part) => part.geometry.dispose());
    }
  }
}
