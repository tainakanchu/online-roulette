import * as THREE from "three";
import type { TrackSurface } from "../../../utils/raceCourse";
import { createDirtMaterial } from "./dirt";
import { createTurfMaterial, GrassField } from "./grass";
import { createDirtDetail, createTurfDetail } from "./groundTextures";
import { createFarGroundMaterial, createHillMaterial } from "./landscape";
import { loadModel } from "./models";
import { createMountainDetail } from "./mountainTextures";
import { createConcreteMaterial } from "./props";
import { createModelRails } from "./rails";
import { createRustyMetalMaterial } from "./rust";
import { createCrowdMaterial, createFacadeMaterial, createRoofMaterial, createSeatMaterial } from "./stands";
import {
  createBroadleafCrown,
  createConiferCrown,
  createLeafCards,
  createLeafCardTexture,
  createLeafMaterial,
  createModelTrees,
  createTrunkGeometry,
  createTrunkMaterial,
  type TreePlacement,
} from "./trees";
import { TurfVision } from "./turfVision";
import { createVisionStructure } from "./visionStructure";
import { createWaterMaterial } from "./water";
import { NOISE3D_GLSL, noise3DUniform } from "./noise3d";
import {
  CLEAR_SKY,
  COURSE_UNIFORMS_GLSL,
  createCourseUniforms,
  type CourseUniforms,
  OVERCAST_SKY,
  overcastAmount,
  SKY_GLSL,
} from "./surfaceCommon";
import { createGroundTexture, createSignTexture, createTurfTexture } from "./textures";

// 競馬場の静的な背景（空・芝/ダートのコース・ラチ・スタンド・観客・木々・ターフビジョン）

/** ゴール線の x 座標（スタートは距離に応じて手前に伸びる） */
export const FINISH_X = 260;
export const TRACK_HALF_WIDTH = 13.5;
/** 1m あたりのワールド単位 */
export const WORLD_PER_METER = 0.16;
/** 最長距離（3600m）でもスタート地点まで芝とラチが続くようにする */
export const COURSE_START = FINISH_X - 3600 * WORLD_PER_METER - 70;
export const COURSE_END = FINISH_X + 140;
/** スタンドが建つ x の範囲（スタンド側 = -Z） */
export const STANDS = { start: FINISH_X - 130, end: FINISH_X + 60 };
/** 内馬場の池（楕円。中心と x・z の半径） */
export const POND = { x: FINISH_X * 0.45, z: TRACK_HALF_WIDTH + 34, radiusX: 55, radiusZ: 16 };
/** ターフビジョンの構造物の原点（画面の中心の真下の地面） */
export const VISION_BASE = { x: FINISH_X - 50, z: TRACK_HALF_WIDTH + 26 };
/** 芝の刈り込みの縞 1 周期（明暗 1 組）の長さ */
const TURF_STRIPE_PERIOD = 16;

export interface Environment {
  group: THREE.Group;
  /**
   * @param excitement 観客の盛り上がり 0..1（揺れは頂点シェーダーで計算するので CPU 負荷はほぼない）
   * @param grassCenterX 芝の葉を生やす範囲の中心
   */
  update: (time: number, excitement: number, grassCenterX: number) => void;
  /**
   * レースをするコースを切り替える。もう一方は外側の帯として残す
   * @param wetness 馬場の水分 0（良）..1（不良）
   */
  setCourse: (surface: TrackSurface, wetness: number) => void;
  vision: TurfVision;
  /** 空・地面・植栽で共有する時刻・風・馬場の水分（コースの備品のマテリアルも使う） */
  uniforms: CourseUniforms;
  dispose: () => void;
}

const SKY_VERTEX = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  ${COURSE_UNIFORMS_GLSL}
  ${NOISE3D_GLSL}
  ${SKY_GLSL}
  varying vec3 vWorld;
  void main() {
    vec3 dir = normalize(vWorld - cameraPosition);
    vec3 col = skyColor(dir);
    // 雲: 視線を上空の水平な面に投影した座標で 3D ノイズを引き、風下へゆっくり流す。
    // 地平線に近いほど遠くの雲が詰まって見えるので、投影の分母に少し足して詰まりすぎないようにする
    if (dir.y > 0.0) {
      vec2 plane = dir.xz / (dir.y + 0.12);
      vec2 drift = uWindDir * uTime * 0.01;
      float n = noise3(vec3((plane + drift) * 0.18, uTime * 0.002)).r * 0.65
        + noise3(vec3((plane + drift) * 0.6, 0.37 + uTime * 0.003)).g * 0.35;
      // 雲の量が多いほど、しきい値を下げて空を覆う面積を広げる
      float threshold = mix(0.66, 0.26, uCloudCover);
      float cover = smoothstep(threshold, threshold + 0.14, n) * smoothstep(0.0, 0.1, dir.y);
      // 雲の明るさ: 厚いところの底は灰色、太陽側の縁は明るく光る。曇天ほど全体に暗い灰色
      vec3 cloud = mix(vec3(0.58, 0.61, 0.66), vec3(1.0), smoothstep(threshold, threshold + 0.35, n));
      cloud *= 1.0 - 0.38 * uCloudCover;
      float sunSide = pow(max(dot(dir, normalize(uSunDir)), 0.0), 6.0);
      cloud += uSkySun * sunSide * 0.5 * (1.0 - uCloudCover);
      col = mix(col, cloud, cover * 0.95);
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;

export interface EnvironmentOptions {
  /** カメラの近くに生やす芝の葉の本数 */
  grassBlades: number;
  /** 内馬場の手前の木に、葉が 1 枚ずつ見える細かいモデルを使う（小さい画面では負荷を抑えて使わない） */
  detailedTrees: boolean;
}

export const createEnvironment = (sunDirection: THREE.Vector3, options: EnvironmentOptions): Environment => {
  const group = new THREE.Group();
  const disposables: Array<{ dispose: () => void }> = [];
  const track = <T extends { dispose: () => void }>(item: T): T => {
    disposables.push(item);
    return item;
  };
  const add = (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    opts: { cast?: boolean; receive?: boolean } = {}
  ) => {
    track(geometry);
    const m = new THREE.Mesh(geometry, material);
    m.castShadow = opts.cast ?? false;
    m.receiveShadow = opts.receive ?? false;
    group.add(m);
    return m;
  };

  // 空・芝・ダートで共有する（濡れた馬場には空と同じ色が映る）
  const courseUniforms = createCourseUniforms(sunDirection);

  // ----- 空 -----
  const skyMat = track(
    new THREE.ShaderMaterial({
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: { ...courseUniforms, ...noise3DUniform() },
    })
  );
  const sky = add(new THREE.SphereGeometry(1400, 32, 16), skyMat);
  sky.position.set(FINISH_X / 2, 0, 0);

  // ----- 地面と芝コース -----
  const groundTex = track(createGroundTexture([75, 40]));
  const ground = add(new THREE.PlaneGeometry(3000, 1600), track(createFarGroundMaterial(groundTex)), {
    receive: true,
  });
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(FINISH_X / 2 - 150, -0.02, 0);

  const courseLength = COURSE_END - COURSE_START;
  const turfTex = track(
    createTurfTexture("#3f8f2f", "#4ca238", [courseLength / TURF_STRIPE_PERIOD, 1], 1)
  );
  turfTex.rotation = 0;
  const turfDetail = track(createTurfDetail());
  const dirtDetail = track(createDirtDetail());
  const turfMat = track(createTurfMaterial(turfTex, turfDetail, courseUniforms));
  const dirtMat = track(
    createDirtMaterial(courseUniforms, { detail: dirtDetail, trackHalfWidth: TRACK_HALF_WIDTH })
  );
  // レースをする走路。芝コースなら芝、ダートコースなら砂になる
  const racingSurface = add(new THREE.PlaneGeometry(courseLength, TRACK_HALF_WIDTH * 2 + 1), turfMat, {
    receive: true,
  });
  racingSurface.rotation.x = -Math.PI / 2;
  racingSurface.position.set((COURSE_START + COURSE_END) / 2, 0, 0);
  // ラチの外側の帯。走路と逆の素材にして、芝とダートの 2 コースがある競馬場に見せる。
  // 長さと位置が走路と同じなので、芝の縞（テクスチャの u）も走路とそろう
  const bandInner = TRACK_HALF_WIDTH + 1;
  const bandWidth = 5;
  const bands = [-1, 1].map((side) => {
    const band = add(new THREE.PlaneGeometry(courseLength, bandWidth), dirtMat, { receive: true });
    band.rotation.x = -Math.PI / 2;
    band.position.set((COURSE_START + COURSE_END) / 2, 0.005, side * (bandInner + bandWidth / 2));
    return band;
  });
  const grass = track(
    new GrassField(courseUniforms, {
      count: options.grassBlades,
      // 注視点の前後 56 まで葉を生やす（望遠のカットでも遠くの芝まで葉が立って見える）
      period: 112,
      stripeOrigin: COURSE_START,
      stripePeriod: TURF_STRIPE_PERIOD,
      finishX: FINISH_X,
      trackHalfWidth: TRACK_HALF_WIDTH,
      bladeHeight: 0.22,
      bladeWidth: 0.05,
      color: "#4a9b33",
    })
  );
  group.add(grass.mesh);

  const setCourse = (surface: TrackSurface, wetness: number) => {
    const isDirt = surface === "dirt";
    racingSurface.material = isDirt ? dirtMat : turfMat;
    for (const band of bands) band.material = isDirt ? turfMat : dirtMat;
    // 芝の葉は芝の部分だけに生やす
    if (isDirt) grass.setZone(bandInner + 0.1, bandInner + bandWidth - 0.1);
    else grass.setZone(0, TRACK_HALF_WIDTH);
    courseUniforms.uWetness.value = wetness;
    // 天気は馬場状態に合わせる（良は青空にちぎれ雲、渋るほど雲が増え、不良は一面の曇り空）
    const overcast = overcastAmount(wetness);
    courseUniforms.uSkyTop.value.set(CLEAR_SKY.top).lerp(new THREE.Color(OVERCAST_SKY.top), overcast);
    courseUniforms.uSkyHorizon.value.set(CLEAR_SKY.horizon).lerp(new THREE.Color(OVERCAST_SKY.horizon), overcast);
    courseUniforms.uCloudCover.value = THREE.MathUtils.lerp(CLEAR_SKY.cloudCover, OVERCAST_SKY.cloudCover, overcast);
  };
  setCourse("turf", 0);

  // ----- ラチ（白い柵） -----
  // 白い塗装がうっすら錆びた鉄柵
  const railMat = track(
    createRustyMetalMaterial({ paint: "#ffffff", rust: 0.22, scale: 1, roughness: 0.35, metalness: 0.08 })
  );
  // Blender で作った柵（rails.glb）を読み込めるまでの仮の柵
  const proceduralRails = new THREE.Group();
  const postGeo = track(new THREE.CylinderGeometry(0.06, 0.06, 1.0, 6));
  const postsPerSide = Math.floor(courseLength / 3);
  const posts = new THREE.InstancedMesh(postGeo, railMat, postsPerSide * 2);
  posts.castShadow = true;
  const m4 = new THREE.Matrix4();
  let pi = 0;
  const railZ = TRACK_HALF_WIDTH + 0.6;
  for (const side of [-1, 1]) {
    const z = side * railZ;
    const rail = new THREE.Mesh(track(new THREE.BoxGeometry(courseLength, 0.12, 0.12)), railMat);
    rail.castShadow = true;
    rail.position.set((COURSE_START + COURSE_END) / 2, 1.0, z);
    proceduralRails.add(rail);
    for (let i = 0; i < postsPerSide; i += 1) {
      m4.makeTranslation(COURSE_START + i * 3, 0.5, z);
      posts.setMatrixAt(pi, m4);
      pi += 1;
    }
  }
  proceduralRails.add(posts);
  group.add(proceduralRails);
  disposables.push({ dispose: () => posts.dispose() });

  // ----- スタンド -----
  const standStart = STANDS.start;
  const standEnd = STANDS.end;
  const standLength = standEnd - standStart;
  const standCenter = (standStart + standEnd) / 2;
  const concrete = track(createConcreteMaterial(courseUniforms, { color: "#c9c4bb" }));
  const rows = 14;
  const rowDepth = 1.1;
  const rowRise = 0.62;
  const standFront = -(TRACK_HALF_WIDTH + 9);
  // 座席は観客と同じ間隔で並べ、24 単位ごとのブロックの間に通路をとる
  const seatSpacing = 0.62;
  const blockLength = 24;
  const aisleWidth = 1.2;
  const seatMat = track(
    createSeatMaterial({
      start: standStart,
      front: standFront,
      rowDepth,
      rowRise,
      seatSpacing,
      blockLength,
      aisleWidth,
    })
  );
  // スタンドは影を落とさない。夕方の低い太陽だと長い影がゴール前の走路を覆い、
  // しかも影を落とす範囲（カメラの注視点付近）の出入りで影が現れたり消えたりするため
  for (let r = 0; r < rows; r += 1) {
    const step = add(
      new THREE.BoxGeometry(standLength, rowRise * (r + 1), rowDepth),
      seatMat,
      { receive: true }
    );
    step.position.set(standCenter, (rowRise * (r + 1)) / 2, standFront - r * rowDepth);
  }
  const standBack = standFront - rows * rowDepth;
  // エプロン（スタンド前の広場）
  const apron = add(
    new THREE.PlaneGeometry(standLength + 40, 8),
    track(createConcreteMaterial(courseUniforms, { color: "#b8b1a4", joints: true, jointSpacing: 2 })),
    { receive: true }
  );
  apron.rotation.x = -Math.PI / 2;
  apron.position.set(standCenter, 0.01, standFront + 4.4);
  // 背後の建物（ガラス張り。窓・空の映り込み・窓明かりはシェーダーで描く）
  const building = add(new THREE.BoxGeometry(standLength, 26, 14), track(createFacadeMaterial(courseUniforms)));
  building.position.set(standCenter, 13, standBack - 7);
  // 屋根と柱
  const roof = add(new THREE.BoxGeometry(standLength + 4, 0.6, rows * rowDepth + 8), track(createRoofMaterial()));
  roof.position.set(standCenter, rows * rowRise + 7, standFront - (rows * rowDepth) / 2 + 2);
  roof.rotation.x = -0.06;
  for (let x = standStart + 6; x < standEnd; x += 24) {
    const column = add(new THREE.CylinderGeometry(0.35, 0.35, rows * rowRise + 7, 8), concrete);
    column.position.set(x, (rows * rowRise + 7) / 2, standFront - rows * rowDepth + 1);
  }
  // スタンドの看板
  const signTex = track(createSignTexture("LUCKY ROULETTE RACECOURSE", "#14213d", "#ffd23f"));
  const sign = add(
    new THREE.PlaneGeometry(60, 5),
    track(new THREE.MeshStandardMaterial({ map: signTex, emissive: "#ffffff", emissiveMap: signTex, emissiveIntensity: 0.35 }))
  );
  sign.position.set(standCenter, rows * rowRise + 10.2, standFront + 2.2);

  // ----- 観客（InstancedMesh、揺れは頂点シェーダー） -----
  const personGeo = track(new THREE.CapsuleGeometry(0.17, 0.42, 3, 6));
  // 顔・髪・帽子・服の塗り分けと揺れはシェーダー（stands.ts）で描く
  const crowdUniforms = { uTime: { value: 0 }, uAmp: { value: 0.04 } };
  const crowdMat = track(createCrowdMaterial(crowdUniforms));
  const spacing = seatSpacing;
  const perRow = Math.floor(standLength / spacing);
  const crowdCount = perRow * rows;
  const crowd = new THREE.InstancedMesh(personGeo, crowdMat, crowdCount);
  const phases = new Float32Array(crowdCount);
  const energies = new Float32Array(crowdCount);
  const palette = ["#e53935", "#1e88e5", "#fdd835", "#43a047", "#fb8c00", "#8e24aa", "#ffffff", "#212121", "#f06292", "#26c6da"];
  const color = new THREE.Color();
  let ci = 0;
  for (let r = 0; r < rows; r += 1) {
    for (let i = 0; i < perRow; i += 1) {
      // 座席の真ん中に座らせ、通路には人を置かない
      const along = (i + 0.5) * spacing;
      const inAisle = along % blockLength < aisleWidth;
      const filled = !inAisle && Math.random() < 0.82;
      const x = standStart + along + (Math.random() - 0.5) * 0.12;
      const y = filled ? rowRise * (r + 1) + 0.38 : -10;
      const z = standFront - r * rowDepth - 0.1;
      phases[ci] = Math.random() * Math.PI * 2;
      energies[ci] = 0.5 + Math.random();
      m4.makeTranslation(x, y, z);
      crowd.setMatrixAt(ci, m4);
      crowd.setColorAt(ci, color.set(palette[Math.floor(Math.random() * palette.length)]));
      ci += 1;
    }
  }
  personGeo.setAttribute("aPhase", new THREE.InstancedBufferAttribute(phases, 1));
  personGeo.setAttribute("aEnergy", new THREE.InstancedBufferAttribute(energies, 1));
  group.add(crowd);
  disposables.push({ dispose: () => crowd.dispose() });

  // ----- 木々（広葉樹 2 種と針葉樹）と遠くの丘 -----
  // 樹冠は風で揺れ、逆光で透ける。幹には樹皮の溝（trees.ts のシェーダー）。
  // 走路から遠く影を落とす範囲（カメラの注視点付近）に入らないので、影は落とさない（影の描画を省く）
  const crownRadius = 2.2;
  const trunkHeight = 3.4;
  const trunkMat = track(createTrunkMaterial(courseUniforms, "#5b3a23"));
  const leafCardTex = track(createLeafCardTexture());
  const coniferRadius = crownRadius * 0.85;
  const species = [
    {
      crown: createBroadleafCrown(crownRadius, 11),
      cards: createLeafCards(crownRadius, 12, 90),
      halfHeight: crownRadius,
      crownY: trunkHeight + crownRadius * 0.35,
      color: "#2f6b2a",
      weight: 0.4,
    },
    {
      crown: createBroadleafCrown(crownRadius, 23),
      cards: createLeafCards(crownRadius, 24, 90),
      halfHeight: crownRadius,
      crownY: trunkHeight + crownRadius * 0.35,
      color: "#3f7a2e",
      weight: 0.35,
    },
    {
      crown: createConiferCrown(coniferRadius, 31),
      cards: null,
      halfHeight: coniferRadius * 1.3,
      crownY: coniferRadius * 1.3 + 1.2,
      color: "#24502c",
      weight: 0.25,
    },
  ];
  const treeCount = 560;
  const treeSpecies = Array.from({ length: treeCount }, () => {
    const roll = Math.random();
    let acc = 0;
    return Math.max(0, species.findIndex((sp) => (acc += sp.weight) > roll));
  });
  const trunkGeo = track(createTrunkGeometry(trunkHeight, 7));
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
  const crowns = species.map((sp, si) => {
    const count = treeSpecies.filter((s) => s === si).length;
    const crownRange = { min: -sp.halfHeight, max: sp.halfHeight };
    const crownMat = track(createLeafMaterial(courseUniforms, crownRange));
    const crown = new THREE.InstancedMesh(track(sp.crown), crownMat, count);
    const cards = sp.cards
      ? new THREE.InstancedMesh(
          track(sp.cards),
          track(createLeafMaterial(courseUniforms, crownRange, { map: leafCardTex })),
          count
        )
      : null;
    return { crown, cards, next: 0 };
  });
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const scaleV = new THREE.Vector3();
  const pos = new THREE.Vector3();
  // Blender で作った木（trees.glb）を読み込めたら、同じ置き場所で差し替える
  const treePlacements: TreePlacement[] = [];
  const proceduralTrees = new THREE.Group();
  for (let i = 0; i < treeCount; i += 1) {
    // 内馬場の奥、スタンド側の奥（スタンドの後ろの建物より外）、コースの両端
    const roll = i / treeCount;
    const infield = roll < 0.5;
    const standSide = !infield && roll < 0.82;
    const x =
      infield || standSide
        ? COURSE_START - 90 + Math.random() * (COURSE_END - COURSE_START + 200)
        : (Math.random() < 0.5 ? COURSE_START - 50 : FINISH_X + 170) + (Math.random() - 0.5) * 60;
    const z = infield
      ? TRACK_HALF_WIDTH + 55 + Math.random() * 90
      : standSide
        ? -(TRACK_HALF_WIDTH + 48 + Math.random() * 100)
        : (Math.random() - 0.5) * 160;
    const s = 0.8 + Math.random() * 1.1;
    const sp = species[treeSpecies[i]];
    const target = crowns[treeSpecies[i]];
    // 向きを木ごとに回して、同じ形の繰り返しに見せない
    const angle = Math.random() * Math.PI * 2;
    q.setFromAxisAngle(up, angle);
    scaleV.set(s, s, s);
    pos.set(x, 0, z);
    trunks.setMatrixAt(i, m4.compose(pos, q, scaleV));
    pos.set(x, sp.crownY * s, z);
    scaleV.set(s, s * (0.9 + Math.random() * 0.3), s);
    m4.compose(pos, q, scaleV);
    color.set(sp.color).offsetHSL((Math.random() - 0.5) * 0.05, 0, (Math.random() - 0.5) * 0.1);
    target.crown.setMatrixAt(target.next, m4);
    target.crown.setColorAt(target.next, color);
    target.cards?.setMatrixAt(target.next, m4);
    target.cards?.setColorAt(target.next, color);
    target.next += 1;
    treePlacements.push({
      x,
      z,
      scale: s,
      angle,
      species: treeSpecies[i],
      // 内馬場の手前の列だけ細かいモデルにする（奥や走路の両端の木は遠くからしか映らない）
      detailed: options.detailedTrees && z > 0 && z < TRACK_HALF_WIDTH + 85,
      tint: new THREE.Color(0.9 + Math.random() * 0.15, 0.9 + Math.random() * 0.15, 0.85 + Math.random() * 0.1),
    });
  }
  proceduralTrees.add(trunks);
  disposables.push({ dispose: () => trunks.dispose() });
  for (const { crown, cards } of crowns) {
    proceduralTrees.add(crown);
    disposables.push({ dispose: () => crown.dispose() });
    if (cards) {
      proceduralTrees.add(cards);
      disposables.push({ dispose: () => cards.dispose() });
    }
  }
  group.add(proceduralTrees);
  let disposed = false;
  // 内ラチは内馬場側（+Z。1 番の馬が走る側）、外ラチはスタンド側（-Z）
  loadModel("rails.glb")
    .then((gltf) => {
      if (disposed) return;
      const modelRails = createModelRails(gltf, courseUniforms, {
        start: COURSE_START,
        end: COURSE_END,
        innerZ: railZ,
        outerZ: -railZ,
      });
      group.remove(proceduralRails);
      group.add(modelRails.group);
      disposables.push(modelRails);
    })
    .catch((error) => console.warn("Failed to load rail models", error));
  loadModel("turf-vision.glb")
    .then((gltf) => {
      if (disposed) return;
      const structure = createVisionStructure(gltf, courseUniforms);
      structure.group.position.copy(visionBase);
      structure.group.rotation.y = Math.PI;
      group.remove(simpleVisionStructure);
      group.add(structure.group);
      disposables.push(structure);
    })
    .catch((error) => console.warn("Failed to load turf vision model", error));
  loadModel("trees.glb")
    .then((gltf) => {
      if (disposed) return;
      const modelTrees = createModelTrees(gltf, treePlacements, courseUniforms);
      group.remove(proceduralTrees);
      group.add(modelTrees.group);
      disposables.push(modelTrees);
    })
    .catch((error) => console.warn("Failed to load tree models", error));

  // 丘はなめらかな球をつぶした形にして、森と草地の塊をシェーダー（landscape.ts）で描く
  const mountainDetail = track(createMountainDetail());
  const hillMat = track(createHillMaterial(mountainDetail.texture));
  // 内馬場の奥と、スタンド側の奥（スタンドの方を向くカメラの背景にも山並みが入るように）の両方に連ねる
  const hillGeo = track(new THREE.SphereGeometry(1, 40, 20));
  for (const side of [1, -1]) {
    for (let i = 0; i < 9; i += 1) {
      const hill = new THREE.Mesh(hillGeo, hillMat);
      hill.scale.set(140 + Math.random() * 120, 30 + Math.random() * 40, 90);
      hill.position.set(-300 + i * 120 + Math.random() * 40, -8, side * (420 + Math.random() * 120));
      group.add(hill);
    }
  }

  // 内馬場の池（波・空の映り込み・太陽のきらめき・岸の泡は水面シェーダーで描く）
  const pond = add(
    new THREE.CircleGeometry(1, 64),
    track(createWaterMaterial(courseUniforms, { deep: "#0f3b52", shallow: "#2e6b5c", shore: "#4a3b2a" }))
  );
  pond.rotation.x = -Math.PI / 2;
  pond.scale.set(POND.radiusX, POND.radiusZ, 1);
  pond.position.set(POND.x, 0.02, POND.z);

  // ----- ターフビジョン（表示の中身は turfVision.ts。走路側の -Z を向ける） -----
  // 構造物の原点は画面の中心の真下の地面。画面の中心は高さ 12
  const visionBase = new THREE.Vector3(VISION_BASE.x, 0, VISION_BASE.z);
  const vision = track(new TurfVision());
  vision.group.position.set(visionBase.x, 12, visionBase.z);
  vision.group.rotation.y = Math.PI;
  group.add(vision.group);
  // Blender で作った構造物（turf-vision.glb）を読み込めるまでの簡易な枠と脚
  const simpleVisionStructure = new THREE.Group();
  const frameMat = track(
    createRustyMetalMaterial({ paint: "#1b1b1f", rust: 0.12, scale: 1.2, roughness: 0.4, metalness: 0.5 })
  );
  const frame = new THREE.Mesh(track(new THREE.BoxGeometry(38, 16, 1)), frameMat);
  frame.position.set(visionBase.x, 12, visionBase.z + 0.6);
  simpleVisionStructure.add(frame);
  for (const dx of [-12, 12]) {
    const leg = new THREE.Mesh(track(new THREE.BoxGeometry(1.2, 6, 1.2)), concrete);
    leg.position.set(visionBase.x + dx, 3, visionBase.z + 0.6);
    simpleVisionStructure.add(leg);
  }
  simpleVisionStructure.traverse((object) => {
    object.castShadow = true;
  });
  group.add(simpleVisionStructure);

  const update = (time: number, excitement: number, grassCenterX: number) => {
    crowdUniforms.uTime.value = time;
    crowdUniforms.uAmp.value = 0.04 + excitement * 0.32;
    courseUniforms.uTime.value = time;
    grass.setCenter(grassCenterX);
  };

  return {
    group,
    update,
    setCourse,
    vision,
    uniforms: courseUniforms,
    dispose: () => {
      disposed = true;
      disposables.forEach((d) => d.dispose());
    },
  };
};
