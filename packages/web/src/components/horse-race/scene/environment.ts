import * as THREE from "three";
import { createGroundTexture, createSignTexture, createTurfTexture } from "./textures";

// 競馬場の静的な背景（空・芝・ラチ・スタンド・観客・木々・ターフビジョン）

/** ゴール線の x 座標（スタートは距離に応じて手前に伸びる） */
export const FINISH_X = 260;
export const TRACK_HALF_WIDTH = 13.5;
/** 1m あたりのワールド単位 */
export const WORLD_PER_METER = 0.16;
/** 最長距離（3600m）でもスタート地点まで芝とラチが続くようにする */
const COURSE_START = FINISH_X - 3600 * WORLD_PER_METER - 70;
const COURSE_END = FINISH_X + 140;

export interface Environment {
  group: THREE.Group;
  /** 観客の盛り上がり 0..1（揺れは頂点シェーダーで計算するので CPU 負荷はほぼない） */
  update: (time: number, excitement: number) => void;
  visionTexture: THREE.CanvasTexture;
  visionCanvas: HTMLCanvasElement;
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
  uniform vec3 topColor;
  uniform vec3 horizonColor;
  uniform vec3 sunColor;
  uniform vec3 sunDir;
  varying vec3 vWorld;
  void main() {
    vec3 dir = normalize(vWorld - cameraPosition);
    float h = clamp(dir.y, 0.0, 1.0);
    vec3 col = mix(horizonColor, topColor, pow(h, 0.55));
    float sun = max(dot(dir, normalize(sunDir)), 0.0);
    col += sunColor * (pow(sun, 600.0) * 4.0 + pow(sun, 12.0) * 0.25);
    // 薄い雲の帯
    float band = smoothstep(0.02, 0.12, h) * (1.0 - smoothstep(0.12, 0.35, h));
    float clouds = 0.5 + 0.5 * sin(dir.x * 9.0 + dir.z * 4.0) * sin(dir.z * 7.0 - dir.x * 3.0);
    col = mix(col, vec3(1.0), band * clouds * 0.35);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export const createEnvironment = (sunDirection: THREE.Vector3): Environment => {
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

  // ----- 空 -----
  const skyMat = track(
    new THREE.ShaderMaterial({
      vertexShader: SKY_VERTEX,
      fragmentShader: SKY_FRAGMENT,
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: {
        topColor: { value: new THREE.Color("#2f6fd6") },
        horizonColor: { value: new THREE.Color("#cfe4f7") },
        sunColor: { value: new THREE.Color("#fff3d6") },
        sunDir: { value: sunDirection.clone() },
      },
    })
  );
  const sky = add(new THREE.SphereGeometry(1400, 32, 16), skyMat);
  sky.position.set(FINISH_X / 2, 0, 0);

  // ----- 地面と芝コース -----
  const groundTex = track(createGroundTexture([75, 40]));
  const ground = add(
    new THREE.PlaneGeometry(3000, 1600),
    track(new THREE.MeshStandardMaterial({ map: groundTex, roughness: 0.95 })),
    { receive: true }
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(FINISH_X / 2 - 150, -0.02, 0);

  const courseLength = COURSE_END - COURSE_START;
  const turfTex = track(createTurfTexture("#3f8f2f", "#4ca238", [courseLength / 16, 1], 1));
  turfTex.rotation = 0;
  const turf = add(
    new THREE.PlaneGeometry(courseLength, TRACK_HALF_WIDTH * 2 + 1),
    track(new THREE.MeshStandardMaterial({ map: turfTex, roughness: 0.85 })),
    { receive: true }
  );
  turf.rotation.x = -Math.PI / 2;
  turf.position.set((COURSE_START + COURSE_END) / 2, 0, 0);

  // 外側のダート帯（色のアクセント）
  const dirtMat = track(new THREE.MeshStandardMaterial({ color: "#a9895c", roughness: 1 }));
  for (const side of [-1, 1]) {
    const dirt = add(new THREE.PlaneGeometry(courseLength, 5), dirtMat, { receive: true });
    dirt.rotation.x = -Math.PI / 2;
    dirt.position.set((COURSE_START + COURSE_END) / 2, 0.005, side * (TRACK_HALF_WIDTH + 3.5));
  }

  // ----- ラチ（白い柵） -----
  const railMat = track(new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.35 }));
  const postGeo = track(new THREE.CylinderGeometry(0.06, 0.06, 1.0, 6));
  const postsPerSide = Math.floor(courseLength / 3);
  const posts = new THREE.InstancedMesh(postGeo, railMat, postsPerSide * 2);
  posts.castShadow = true;
  const m4 = new THREE.Matrix4();
  let pi = 0;
  for (const side of [-1, 1]) {
    const z = side * (TRACK_HALF_WIDTH + 0.6);
    const rail = add(new THREE.BoxGeometry(courseLength, 0.12, 0.12), railMat, {
      cast: true,
    });
    rail.position.set((COURSE_START + COURSE_END) / 2, 1.0, z);
    for (let i = 0; i < postsPerSide; i += 1) {
      m4.makeTranslation(COURSE_START + i * 3, 0.5, z);
      posts.setMatrixAt(pi, m4);
      pi += 1;
    }
  }
  group.add(posts);
  disposables.push({ dispose: () => posts.dispose() });

  // ----- スタンド -----
  const standStart = FINISH_X - 130;
  const standEnd = FINISH_X + 60;
  const standLength = standEnd - standStart;
  const standCenter = (standStart + standEnd) / 2;
  const concrete = track(new THREE.MeshStandardMaterial({ color: "#c9c4bb", roughness: 0.9 }));
  const seatMat = track(new THREE.MeshStandardMaterial({ color: "#8a1c2b", roughness: 0.7 }));
  const rows = 14;
  const rowDepth = 1.1;
  const rowRise = 0.62;
  const standFront = -(TRACK_HALF_WIDTH + 9);
  for (let r = 0; r < rows; r += 1) {
    const step = add(
      new THREE.BoxGeometry(standLength, rowRise * (r + 1), rowDepth),
      r % 2 === 0 ? concrete : seatMat,
      { receive: true, cast: r === rows - 1 }
    );
    step.position.set(standCenter, (rowRise * (r + 1)) / 2, standFront - r * rowDepth);
  }
  const standBack = standFront - rows * rowDepth;
  // エプロン（スタンド前の広場）
  const apron = add(
    new THREE.PlaneGeometry(standLength + 40, 8),
    track(new THREE.MeshStandardMaterial({ color: "#b8b1a4", roughness: 1 })),
    { receive: true }
  );
  apron.rotation.x = -Math.PI / 2;
  apron.position.set(standCenter, 0.01, standFront + 4.4);
  // 背後の建物（ガラス張り）
  const glass = track(
    new THREE.MeshStandardMaterial({
      color: "#2c4a6b",
      roughness: 0.15,
      metalness: 0.6,
      emissive: "#0d2238",
      emissiveIntensity: 0.4,
    })
  );
  const building = add(new THREE.BoxGeometry(standLength, 26, 14), glass, { cast: true });
  building.position.set(standCenter, 13, standBack - 7);
  // 屋根と柱
  const roof = add(
    new THREE.BoxGeometry(standLength + 4, 0.6, rows * rowDepth + 8),
    track(new THREE.MeshStandardMaterial({ color: "#eeeeee", roughness: 0.5 })),
    { cast: true }
  );
  roof.position.set(standCenter, rows * rowRise + 7, standFront - (rows * rowDepth) / 2 + 2);
  roof.rotation.x = -0.06;
  for (let x = standStart + 6; x < standEnd; x += 24) {
    const column = add(new THREE.CylinderGeometry(0.35, 0.35, rows * rowRise + 7, 8), concrete, {
      cast: true,
    });
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
  const crowdMat = track(new THREE.MeshStandardMaterial({ roughness: 0.8 }));
  const crowdUniforms = { uTime: { value: 0 }, uAmp: { value: 0.04 } };
  crowdMat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = crowdUniforms.uTime;
    shader.uniforms.uAmp = crowdUniforms.uAmp;
    shader.vertexShader =
      "attribute float aPhase;\nattribute float aEnergy;\nuniform float uTime;\nuniform float uAmp;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\n  transformed.y += max(0.0, sin(uTime * (3.0 + aEnergy * 3.0) + aPhase)) * uAmp * aEnergy;"
      );
  };
  const spacing = 0.62;
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
      const filled = Math.random() < 0.82;
      const x = standStart + i * spacing + (Math.random() - 0.5) * 0.25;
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

  // ----- 木々と遠くの丘 -----
  const trunkGeo = track(new THREE.CylinderGeometry(0.25, 0.35, 2.4, 6));
  const leafGeo = track(new THREE.IcosahedronGeometry(2.2, 1));
  const trunkMat = track(new THREE.MeshStandardMaterial({ color: "#5b3a23", roughness: 1 }));
  // 色はインスタンスごとに setColorAt で与える（マテリアル色と乗算されるので白にしておく）
  const leafMat = track(new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.9, flatShading: true }));
  const treeCount = 380;
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount);
  const leaves = new THREE.InstancedMesh(leafGeo, leafMat, treeCount);
  leaves.castShadow = true;
  const q = new THREE.Quaternion();
  const scaleV = new THREE.Vector3();
  const pos = new THREE.Vector3();
  for (let i = 0; i < treeCount; i += 1) {
    // 内馬場の奥と、コースの両端
    const far = i < treeCount * 0.75;
    const x = far
      ? COURSE_START - 90 + Math.random() * (COURSE_END - COURSE_START + 200)
      : (Math.random() < 0.5 ? COURSE_START - 50 : FINISH_X + 170) + (Math.random() - 0.5) * 60;
    const z = far ? TRACK_HALF_WIDTH + 55 + Math.random() * 90 : (Math.random() - 0.5) * 160;
    const s = 0.8 + Math.random() * 1.1;
    scaleV.set(s, s, s);
    pos.set(x, 1.2 * s, z);
    trunks.setMatrixAt(i, m4.compose(pos, q, scaleV));
    pos.set(x, 3.6 * s, z);
    scaleV.set(s, s * (0.9 + Math.random() * 0.5), s);
    leaves.setMatrixAt(i, m4.compose(pos, q, scaleV));
    leaves.setColorAt(i, color.set("#2f6b2a").offsetHSL((Math.random() - 0.5) * 0.06, 0, (Math.random() - 0.5) * 0.12));
  }
  group.add(trunks, leaves);
  disposables.push({ dispose: () => trunks.dispose() }, { dispose: () => leaves.dispose() });

  const hillMat = track(new THREE.MeshStandardMaterial({ color: "#5d7f5a", roughness: 1, flatShading: true }));
  for (let i = 0; i < 9; i += 1) {
    const hill = add(new THREE.SphereGeometry(1, 12, 8), hillMat);
    hill.scale.set(140 + Math.random() * 120, 30 + Math.random() * 40, 90);
    hill.position.set(-300 + i * 120 + Math.random() * 40, -8, 420 + Math.random() * 120);
  }

  // 内馬場の池
  const pond = add(
    new THREE.CircleGeometry(1, 40),
    track(new THREE.MeshStandardMaterial({ color: "#3c7fb0", roughness: 0.08, metalness: 0.3 }))
  );
  pond.rotation.x = -Math.PI / 2;
  pond.scale.set(55, 16, 1);
  pond.position.set(FINISH_X * 0.45, 0.02, TRACK_HALF_WIDTH + 34);

  // ----- ターフビジョン -----
  const visionCanvas = document.createElement("canvas");
  visionCanvas.width = 1024;
  visionCanvas.height = 400;
  const visionTexture = track(new THREE.CanvasTexture(visionCanvas));
  visionTexture.colorSpace = THREE.SRGBColorSpace;
  const visionMat = track(
    new THREE.MeshBasicMaterial({ map: visionTexture, toneMapped: false })
  );
  const vision = add(new THREE.PlaneGeometry(36, 14), visionMat);
  vision.position.set(FINISH_X - 50, 12, TRACK_HALF_WIDTH + 26);
  vision.rotation.y = Math.PI;
  const frame = add(
    new THREE.BoxGeometry(38, 16, 1),
    track(new THREE.MeshStandardMaterial({ color: "#1b1b1f", roughness: 0.4 })),
    { cast: true }
  );
  frame.position.set(FINISH_X - 50, 12, TRACK_HALF_WIDTH + 26.6);
  for (const dx of [-12, 12]) {
    const leg = add(new THREE.BoxGeometry(1.2, 6, 1.2), concrete, { cast: true });
    leg.position.set(FINISH_X - 50 + dx, 3, TRACK_HALF_WIDTH + 26.6);
  }

  const update = (time: number, excitement: number) => {
    crowdUniforms.uTime.value = time;
    crowdUniforms.uAmp.value = 0.04 + excitement * 0.32;
  };

  return {
    group,
    update,
    visionTexture,
    visionCanvas,
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
};
