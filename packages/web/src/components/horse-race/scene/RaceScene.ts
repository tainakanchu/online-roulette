import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { positionAt, winnerTime, type RaceSimulation } from "@tainakanchu/roulette-core";
import {
  createEnvironment,
  FINISH_X,
  TRACK_HALF_WIDTH,
  WORLD_PER_METER,
  type Environment,
} from "./environment";
import { HorseModel, type HorseSpec } from "./horseModel";
import { createSignTexture, createSoftDotTexture } from "./textures";

export interface RaceTick {
  /** 現在の位置順（馬 index） */
  order: number[];
  /** 先頭の進捗 0..1 */
  leaderFraction: number;
  /** 先頭からゴールまでの残り距離（m） */
  remainingMeters: number;
  /** 1 番手と 2 番手の差（歩数） */
  gapTop2: number;
  slowMotion: boolean;
}

export interface RaceCallbacks {
  onTick?: (tick: RaceTick) => void;
  onWinnerCross?: () => void;
  onComplete?: () => void;
}

export interface VisionInfo {
  title: string;
  subtitle: string;
  rows: Array<{ number: number; name: string; color: string }>;
}

type Shot = "idle" | "gate" | "chase" | "side" | "aerial" | "headon" | "stretch" | "finish" | "winner";

const POST_FINISH_SECONDS = 4.2;
const FINISH_HOLD_SECONDS = 1.3;
const OVERRUN = 32;

/** ゴール後は徐々に減速して止まるように見せる */
const compressAfterFinish = (x: number) =>
  x <= FINISH_X ? x : FINISH_X + OVERRUN * (1 - Math.exp(-(x - FINISH_X) / OVERRUN));

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** スローモーション時の再生速度 */
const SLOW_MOTION_SCALE = 0.35;
/** 道中で内ラチ側へ寄っていく度合い（1 = 全馬ラチ沿い） */
const LANE_SQUEEZE = 0.3;

// ----- 土煙パーティクル -----
const DUST_VERTEX = /* glsl */ `
  attribute float alpha;
  attribute float size;
  varying float vAlpha;
  void main() {
    vAlpha = alpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (300.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const DUST_FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 color;
  varying float vAlpha;
  void main() {
    vec4 tex = texture2D(map, gl_PointCoord);
    gl_FragColor = vec4(color, tex.a * vAlpha);
    #include <colorspace_fragment>
  }
`;

class Dust {
  readonly points: THREE.Points;
  private readonly positions: Float32Array;
  private readonly velocities: Float32Array;
  private readonly life: Float32Array;
  private readonly alphas: Float32Array;
  private readonly sizes: Float32Array;
  private cursor = 0;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly texture = createSoftDotTexture();

  constructor(private readonly count = 1400) {
    this.positions = new Float32Array(count * 3).fill(-999);
    this.velocities = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.alphas = new Float32Array(count);
    this.sizes = new Float32Array(count);
    this.geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute("alpha", new THREE.BufferAttribute(this.alphas, 1));
    this.geometry.setAttribute("size", new THREE.BufferAttribute(this.sizes, 1));
    this.material = new THREE.ShaderMaterial({
      vertexShader: DUST_VERTEX,
      fragmentShader: DUST_FRAGMENT,
      transparent: true,
      depthWrite: false,
      uniforms: { map: { value: this.texture }, color: { value: new THREE.Color("#8c7a52") } },
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
  }

  emit(x: number, z: number, speed: number) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    this.positions[i * 3] = x + (Math.random() - 0.5) * 0.4;
    this.positions[i * 3 + 1] = 0.1;
    this.positions[i * 3 + 2] = z + (Math.random() - 0.5) * 0.5;
    this.velocities[i * 3] = -speed * (0.05 + Math.random() * 0.1);
    this.velocities[i * 3 + 1] = 1 + Math.random() * 2.2;
    this.velocities[i * 3 + 2] = (Math.random() - 0.5) * 1.5;
    this.life[i] = 1;
    this.sizes[i] = 0.6 + Math.random() * 0.9;
  }

  update(dt: number) {
    for (let i = 0; i < this.count; i += 1) {
      if (this.life[i] <= 0) {
        this.alphas[i] = 0;
        continue;
      }
      this.life[i] -= dt * 1.1;
      this.velocities[i * 3 + 1] -= 6 * dt;
      this.positions[i * 3] += this.velocities[i * 3] * dt;
      this.positions[i * 3 + 1] = Math.max(0.05, this.positions[i * 3 + 1] + this.velocities[i * 3 + 1] * dt);
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt;
      this.sizes[i] += dt * 1.6;
      this.alphas[i] = Math.max(0, this.life[i]) * 0.55;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.alpha.needsUpdate = true;
    this.geometry.attributes.size.needsUpdate = true;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}

// ----- ゲート -----
class StartingGate {
  readonly group = new THREE.Group();
  private readonly doors: Array<{ pivot: THREE.Group; dir: number }> = [];
  private openAmount = 0;
  private opening = false;
  private readonly disposables: Array<{ dispose: () => void }> = [];

  constructor(lanes: number[], laneWidth: number) {
    const frameMat = this.track(new THREE.MeshStandardMaterial({ color: "#2e7d32", roughness: 0.5, metalness: 0.3 }));
    const whiteMat = this.track(new THREE.MeshStandardMaterial({ color: "#f5f5f5", roughness: 0.4 }));
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D = this.group) => {
      this.track(geo);
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };
    const half = (lanes.length * laneWidth) / 2 + 0.4;
    const centerZ = lanes.length ? (lanes[0] + lanes[lanes.length - 1]) / 2 : 0;
    const beam = add(new THREE.BoxGeometry(0.5, 0.4, half * 2 + 0.6), frameMat);
    beam.position.set(1.2, 3.2, centerZ);
    const beamBack = add(new THREE.BoxGeometry(0.4, 0.3, half * 2 + 0.6), frameMat);
    beamBack.position.set(-1.4, 3.2, centerZ);
    const roofPanel = add(new THREE.BoxGeometry(2.8, 0.08, half * 2 + 0.6), whiteMat);
    roofPanel.position.set(-0.1, 3.42, centerZ);
    // 仕切り
    for (let i = 0; i <= lanes.length; i += 1) {
      const z = centerZ - half + 0.4 + i * laneWidth - 0.0;
      // 仕切りは柵状にして、中の馬が見えるようにする
      for (const y of [1.05, 2.2, 3.0]) {
        const bar = add(new THREE.BoxGeometry(2.6, 0.12, 0.08), y === 2.2 ? whiteMat : frameMat);
        bar.position.set(-0.1, y, z);
      }
      for (const x of [-1.35, 1.2]) {
        const leg = add(new THREE.BoxGeometry(0.14, 3.2, 0.14), frameMat);
        leg.position.set(x, 1.6, z);
      }
    }
    // 前扉（中央から両開き）
    lanes.forEach((laneZ) => {
      for (const dir of [-1, 1]) {
        const pivot = new THREE.Group();
        pivot.position.set(1.25, 1.35, laneZ + dir * (laneWidth / 2 - 0.05));
        const door = add(new THREE.BoxGeometry(0.06, 1.1, laneWidth / 2 - 0.08), whiteMat, pivot);
        door.position.z = -dir * (laneWidth / 4 - 0.02);
        this.group.add(pivot);
        this.doors.push({ pivot, dir });
      }
    });
  }

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  open() {
    this.opening = true;
  }

  close() {
    this.opening = false;
    this.openAmount = 0;
    this.apply();
  }

  update(dt: number) {
    if (!this.opening || this.openAmount >= 1) return;
    this.openAmount = Math.min(1, this.openAmount + dt * 4.5);
    this.apply();
  }

  private apply() {
    const eased = 1 - Math.pow(1 - this.openAmount, 3);
    for (const { pivot, dir } of this.doors) {
      pivot.rotation.y = dir * eased * 1.75;
    }
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }
}

// ----- メインのシーン -----
export class RaceScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 3000);
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly sun: THREE.DirectionalLight;
  private readonly environment: Environment;
  private readonly dust = new Dust();
  private readonly clock = new THREE.Clock();
  private readonly resizeObserver: ResizeObserver;
  private readonly lookAt = new THREE.Vector3(0, 1.5, 0);
  private readonly desiredPos = new THREE.Vector3();
  private readonly desiredLook = new THREE.Vector3();
  private rafId = 0;
  private time = 0;

  private horses: HorseModel[] = [];
  private lanes: number[] = [];
  private gate: StartingGate | null = null;
  private courseMarks = new THREE.Group();
  private courseDisposables: Array<{ dispose: () => void }> = [];
  private distanceMeters = 1600;
  /** スタート地点の x 座標（距離が長いほど手前） */
  private startX = FINISH_X - 1600 * WORLD_PER_METER;

  // レース状態
  private race: RaceSimulation | null = null;
  /** レース内部の時刻（単位時間） */
  private raceT = 0;
  /** 実時間 1 秒あたりに進めるレース内部時刻 */
  private raceRate = 1;
  /** 再生速度（スローモーションへは徐々に切り替える） */
  private timeScale = 1;
  private running = false;
  private prevWorldX: number[] = [];
  private speeds: number[] = [];
  private winnerCrossed = false;
  private postFinishTime = 0;
  private completed = false;
  private callbacks: RaceCallbacks = {};
  private shot: Shot = "idle";
  private shotTime = 0;
  private lastTickAt = 0;
  private excitement = 0;
  private slowMotion = false;
  /** カメラが追う馬群の位置（なめらかに追従させる） */
  private focusX = 0;
  private vision: VisionInfo | null = null;
  private visionDirty = true;
  private lastVisionAt = 0;

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
    const smallScreen = Math.min(window.innerWidth, window.innerHeight) < 600;
    // ポストプロセスがあるので解像度は控えめにして、その分 MSAA で輪郭をきれいにする
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, smallScreen ? 1.25 : 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.className = "race-stage-canvas";
    container.appendChild(this.renderer.domElement);

    this.scene.fog = new THREE.Fog("#cfe4f7", 160, 900);

    const sunDir = new THREE.Vector3(-0.35, 0.75, -0.55).normalize();
    this.scene.add(new THREE.HemisphereLight("#cfe6ff", "#4c6b2c", 0.9));
    this.sun = new THREE.DirectionalLight("#fff2d9", 2.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -36;
    this.sun.shadow.camera.right = 36;
    this.sun.shadow.camera.top = 36;
    this.sun.shadow.camera.bottom = -36;
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 260;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.sun.userData.dir = sunDir;
    this.scene.add(this.sun, this.sun.target);

    this.environment = createEnvironment(sunDir);
    this.scene.add(this.environment.group);
    this.scene.add(this.courseMarks);
    this.scene.add(this.dust.points);

    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: 4,
    });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.22, 0.45, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.camera.position.set(14, 4, 9);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.loop();
  }

  // ----- 公開 API -----

  /** 出走馬とコース（距離）をセットする。ゲートに収まった状態に戻る */
  setField(specs: HorseSpec[], distanceMeters: number) {
    this.stopRace();
    for (const horse of this.horses) {
      this.scene.remove(horse.root);
      horse.dispose();
    }
    this.distanceMeters = distanceMeters;
    this.startX = FINISH_X - distanceMeters * WORLD_PER_METER;
    this.horses = specs.map((spec) => new HorseModel(spec));
    const n = specs.length;
    const laneWidth = n > 0 ? Math.min(1.7, (TRACK_HALF_WIDTH * 2 - 3) / n) : 1.7;
    // 1 番が内ラチ側（奥）
    this.lanes = specs.map((_, i) => ((n - 1) / 2) * laneWidth - i * laneWidth + 0.5);
    this.horses.forEach((horse) => this.scene.add(horse.root));
    this.placeAtGate();
    this.buildCourse(laneWidth);
    this.setShot("idle", true, true);
  }

  setVision(info: VisionInfo) {
    this.vision = info;
    this.visionDirty = true;
  }

  /** カウントダウン用のカメラへ */
  showGate() {
    this.setShot("gate");
  }

  openGate() {
    this.gate?.open();
  }

  /**
   * @param durationSeconds 勝ち馬がゴールするまでの実時間（スローモーション分は伸びる）
   */
  startRace(race: RaceSimulation, durationSeconds: number, callbacks: RaceCallbacks) {
    this.race = race;
    this.raceRate = Math.max(0.1, winnerTime(race)) / durationSeconds;
    this.raceT = 0;
    this.timeScale = 1;
    this.running = true;
    this.winnerCrossed = false;
    this.postFinishTime = 0;
    this.completed = false;
    this.callbacks = callbacks;
    this.focusX = this.startX;
    this.gate?.open();
    this.setShot("chase");
  }

  /** ゲートに戻す */
  resetToGate() {
    this.stopRace();
    this.placeAtGate();
    this.gate?.close();
    this.setShot("idle", true, true);
  }

  async capture(): Promise<Blob> {
    this.composer.render();
    return new Promise((resolve, reject) => {
      this.renderer.domElement.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Failed to capture race"));
      }, "image/png");
    });
  }

  dispose() {
    cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    for (const horse of this.horses) horse.dispose();
    this.gate?.dispose();
    this.courseDisposables.forEach((d) => d.dispose());
    this.environment.dispose();
    this.dust.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ----- 内部 -----

  private placeAtGate() {
    this.horses.forEach((horse, i) => {
      horse.root.position.set(this.startX, 0, this.lanes[i]);
      horse.root.rotation.y = 0;
    });
    this.prevWorldX = this.horses.map(() => this.startX);
    this.speeds = this.horses.map(() => 0);
    this.focusX = this.startX;
  }

  private stopRace() {
    this.running = false;
    this.race = null;
    this.winnerCrossed = false;
    this.completed = false;
    this.slowMotion = false;
    this.timeScale = 1;
    this.excitement = 0;
    this.callbacks = {};
  }

  private buildCourse(laneWidth: number) {
    const distanceMeters = this.distanceMeters;
    if (this.gate) {
      this.scene.remove(this.gate.group);
      this.gate.dispose();
    }
    this.gate = new StartingGate(this.lanes, laneWidth);
    this.gate.group.position.x = this.startX;
    this.scene.add(this.gate.group);

    this.courseDisposables.forEach((d) => d.dispose());
    this.courseDisposables = [];
    this.scene.remove(this.courseMarks);
    this.courseMarks = new THREE.Group();
    this.scene.add(this.courseMarks);
    const track = <T extends { dispose: () => void }>(item: T): T => {
      this.courseDisposables.push(item);
      return item;
    };
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, cast = true) => {
      track(geo);
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = cast;
      this.courseMarks.add(m);
      return m;
    };

    // ゴール線とゴール板
    const white = track(new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.5 }));
    const red = track(new THREE.MeshStandardMaterial({ color: "#d32f2f", roughness: 0.4 }));
    const line = add(new THREE.PlaneGeometry(0.5, TRACK_HALF_WIDTH * 2), white, false);
    line.rotation.x = -Math.PI / 2;
    line.position.set(FINISH_X, 0.02, 0);
    line.receiveShadow = true;
    for (const side of [-1, 1]) {
      const pole = add(new THREE.CylinderGeometry(0.1, 0.1, 5, 10), white);
      pole.position.set(FINISH_X, 2.5, side * (TRACK_HALF_WIDTH + 1.2));
      const disc = add(new THREE.CylinderGeometry(0.9, 0.9, 0.08, 32), red);
      disc.rotation.x = Math.PI / 2;
      disc.position.set(FINISH_X, 4.6, side * (TRACK_HALF_WIDTH + 1.2));
    }
    // ハロン棒（残り距離）。共有ジオメトリ・マテリアルで本数が増えても軽く
    const poleGeo = track(new THREE.CylinderGeometry(0.08, 0.08, 3, 8));
    const signGeo = track(new THREE.PlaneGeometry(2.2, 0.6));
    const step = 200;
    for (let remain = step; remain < distanceMeters; remain += step) {
      const x = FINISH_X - remain * WORLD_PER_METER;
      const pole = add(poleGeo, remain % 400 === 0 ? red : white);
      pole.position.set(x, 1.5, TRACK_HALF_WIDTH + 1.1);
      const signTex = track(createSignTexture(String(remain), "#ffffff", "#c62828"));
      const sign = add(
        signGeo,
        track(new THREE.MeshStandardMaterial({ map: signTex, side: THREE.DoubleSide })),
        false
      );
      sign.position.set(x, 3.2, TRACK_HALF_WIDTH + 1.1);
    }
  }

  private resize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    // ブルームは半分の解像度で十分
    this.bloom.resolution.set(width / 2, height / 2);
    this.camera.aspect = width / height;
    // 縦長画面では少し引く
    this.camera.fov = width / height < 1.2 ? 55 : 42;
    this.camera.updateProjectionMatrix();
  }

  private setShot(shot: Shot, cut = true, force = false) {
    if (this.shot === shot && !force) return;
    this.shot = shot;
    this.shotTime = 0;
    if (cut) {
      this.computeShot(0);
      this.camera.position.copy(this.desiredPos);
      this.lookAt.copy(this.desiredLook);
    }
  }

  private loop = () => {
    this.rafId = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    this.time += dt;
    this.update(dt);
    this.composer.render();
  };

  /** 馬のレース内部での位置（単位） */
  private horseProgress(i: number): number {
    return this.race ? positionAt(this.race, i, this.raceT) : 0;
  }

  private currentOrder(progresses: number[]) {
    return progresses.map((_, i) => i).sort((a, b) => progresses[b] - progresses[a]);
  }

  private update(realDt: number) {
    const race = this.race;
    let dt = realDt;

    if (race && this.running) {
      const target = race.target;
      const courseLength = FINISH_X - this.startX;
      // 位置順と接戦判定
      const progresses = this.horses.map((_, i) => this.horseProgress(i));
      const order = this.currentOrder(progresses);
      const leader = progresses[order[0]] ?? 0;
      const second = progresses[order[1]] ?? 0;
      const leaderFraction = Math.min(1, leader / target);
      const gapTop2 = leader - second;
      this.slowMotion = !this.winnerCrossed && leaderFraction > 0.93 && gapTop2 < 0.9;
      // 再生速度は急に変えず、なめらかに寄せる
      const targetScale = this.slowMotion ? SLOW_MOTION_SCALE : 1;
      this.timeScale += (targetScale - this.timeScale) * (1 - Math.exp(-realDt * 5));
      dt = realDt * this.timeScale;
      this.excitement = Math.min(1, Math.max(this.excitement * 0.98, leaderFraction * leaderFraction));

      this.raceT += dt * this.raceRate;
      const innermost = this.lanes[0] ?? 0;

      // 馬を動かす
      this.horses.forEach((horse, i) => {
        const fraction = progresses[i] / target;
        const raw = this.startX + fraction * courseLength;
        const x = compressAfterFinish(raw);
        const speed = dt > 0 ? (x - this.prevWorldX[i]) / dt : 0;
        // フレーム時間の揺らぎだけ吸収する軽い平滑化
        this.speeds[i] += (speed - this.speeds[i]) * (1 - Math.exp(-realDt * 12));
        this.prevWorldX[i] = x;

        // スタート後は少しずつ内ラチ側へ寄っていく（1 番人気でもラチ沿いを走る）
        const squeeze = LANE_SQUEEZE * smoothstep(0.02, 0.3, fraction);
        const sway = Math.sin(this.time * 0.7 + i * 1.7) * 0.06 * smoothstep(0.02, 0.1, fraction);
        const z = innermost - (innermost - this.lanes[i]) * (1 - squeeze) + sway;
        const dz = z - horse.root.position.z;
        horse.root.position.set(x, 0, z);
        // 横移動の向きに少しだけ首を振る
        const yaw = dt > 0 && this.speeds[i] > 1 ? -Math.atan2(dz / dt, this.speeds[i]) : 0;
        horse.root.rotation.y += (Math.max(-0.12, Math.min(0.12, yaw)) - horse.root.rotation.y) * 0.1;

        const rank = order.indexOf(i);
        const effort = leaderFraction > 0.7 ? Math.max(0, 1 - rank / 4) : 0.2;
        horse.update(dt, this.speeds[i], effort);
        if (this.speeds[i] > 4 && Math.random() < dt * 22) {
          this.dust.emit(x - 0.7, z, this.speeds[i]);
        }
      });

      // ゴール判定（勝ち馬はシミュレーション上のゴール時刻ちょうどにゴール線を越える）
      if (!this.winnerCrossed && this.raceT >= winnerTime(race)) {
        this.winnerCrossed = true;
        this.excitement = 1;
        this.callbacks.onWinnerCross?.();
        this.setShot("finish");
      }
      if (this.winnerCrossed) {
        this.postFinishTime += realDt;
        if (this.postFinishTime > FINISH_HOLD_SECONDS && this.shot === "finish") {
          this.setShot("winner");
        }
        if (!this.completed && this.postFinishTime > POST_FINISH_SECONDS) {
          this.completed = true;
          this.callbacks.onComplete?.();
        }
      } else {
        this.chooseRaceShot(leaderFraction);
      }

      if (!this.winnerCrossed && this.time - this.lastTickAt > 0.2) {
        this.lastTickAt = this.time;
        this.callbacks.onTick?.({
          order,
          leaderFraction,
          remainingMeters: Math.max(0, Math.round(this.distanceMeters * (1 - leaderFraction))),
          gapTop2,
          slowMotion: this.slowMotion,
        });
      }
    } else {
      this.horses.forEach((horse) => horse.update(dt, 0));
      this.excitement *= 0.98;
    }

    this.updateFocus(realDt);
    this.gate?.update(dt);
    this.dust.update(dt);
    this.environment.update(this.time, this.excitement);
    this.updateVision();
    this.updateCamera(realDt);
  }

  private chooseRaceShot(fraction: number) {
    if (fraction < 0.14) this.setShot("chase", false);
    else if (fraction < 0.42) this.setShot("side");
    else if (fraction < 0.58) this.setShot("aerial");
    else if (fraction < 0.8) this.setShot("headon");
    else this.setShot("stretch");
  }

  /**
   * カメラの注視点。先頭に近い馬ほど重く平均するので、順位が入れ替わっても飛ばない。
   * さらに時間方向にも追従を遅らせてなめらかにする。
   */
  private updateFocus(dt: number) {
    if (this.horses.length === 0) return;
    let lead = -Infinity;
    for (const h of this.horses) lead = Math.max(lead, h.root.position.x);
    let sum = 0;
    let weight = 0;
    for (const h of this.horses) {
      const w = Math.exp((h.root.position.x - lead) / 5);
      sum += h.root.position.x * w;
      weight += w;
    }
    const target = sum / weight;
    this.focusX += (target - this.focusX) * (1 - Math.exp(-dt * 6));
  }

  private leaderX(): number {
    let best = -Infinity;
    for (const h of this.horses) best = Math.max(best, h.root.position.x);
    return Number.isFinite(best) ? best : this.focusX;
  }

  private computeShot(t: number) {
    const px = this.focusX;
    const sx = this.startX;
    const winnerIdx = this.race?.winner ?? -1;
    switch (this.shot) {
      case "idle": {
        const a = t * 0.12 + 0.6;
        this.desiredPos.set(sx + Math.cos(a) * 16 + 2, 5 + Math.sin(t * 0.3) * 1.2, Math.sin(a) * 16 - 4);
        this.desiredLook.set(sx, 1.4, 0);
        break;
      }
      case "gate":
        this.desiredPos.set(sx + 11 - t * 0.6, 3.2, -6 + t * 0.4);
        this.desiredLook.set(sx, 1.6, 0);
        break;
      case "chase":
        // ゲートから飛び出してくる馬群を正面斜めから
        this.desiredPos.set(Math.max(px, sx + 4) + 22 - Math.min(t, 3) * 2, 4, -7);
        this.desiredLook.set(px, 1.3, 0);
        break;
      case "side":
        this.desiredPos.set(px - 2, 8, -(TRACK_HALF_WIDTH + 20));
        this.desiredLook.set(px + 4, 1, 0);
        break;
      case "aerial":
        // 内馬場側の上空から、スタンドを背景に
        this.desiredPos.set(px - 10, 15, TRACK_HALF_WIDTH + 10);
        this.desiredLook.set(px + 6, 0.5, -3);
        break;
      case "headon": {
        const lx = this.leaderX();
        this.desiredPos.set(lx + 24 - Math.min(t, 4) * 1.5, 3.2, -4);
        this.desiredLook.set(px, 1.5, 0);
        break;
      }
      case "stretch":
        this.desiredPos.set(px + 3, 4, -(TRACK_HALF_WIDTH + 9));
        this.desiredLook.set(px - 1, 1.3, 0);
        break;
      case "finish":
        // 写真判定カメラ（ゴール板の円盤の下からゴール線を真横に）
        this.desiredPos.set(FINISH_X + 0.15, 2.3, -(TRACK_HALF_WIDTH + 11));
        this.desiredLook.set(FINISH_X, 1.2, 0);
        break;
      case "winner": {
        const w = this.horses[winnerIdx];
        const wx = w ? w.root.position.x : px;
        const wz = w ? w.root.position.z : 0;
        const a = -1.2 + t * 0.35;
        this.desiredPos.set(wx + Math.cos(a) * 7, 2.6, wz + Math.sin(a) * 7);
        // 結果パネル（右側）に被らないよう、勝ち馬を画面の左寄りに置く
        this.desiredLook.set(wx + Math.sin(a) * 2.2, 1.7, wz - Math.cos(a) * 2.2);
        break;
      }
    }
  }

  private updateCamera(dt: number) {
    this.shotTime += dt;
    this.computeShot(this.shotTime);
    const k = this.shot === "finish" ? 20 : this.shot === "idle" ? 2 : 4;
    const s = 1 - Math.exp(-dt * k);
    this.camera.position.lerp(this.desiredPos, s);
    this.lookAt.lerp(this.desiredLook, s);
    this.camera.lookAt(this.lookAt);

    // 影はカメラの注視点付近だけ高解像度で落とす
    const dir = this.sun.userData.dir as THREE.Vector3;
    this.sun.target.position.set(this.lookAt.x, 0, this.lookAt.z * 0.3);
    this.sun.position.copy(this.sun.target.position).addScaledVector(dir, 120);
  }

  private updateVision() {
    if (!this.vision) return;
    const interval = this.running ? 0.25 : 1;
    if (!this.visionDirty && this.time - this.lastVisionAt < interval) return;
    this.visionDirty = false;
    this.lastVisionAt = this.time;
    const { visionCanvas: canvas, visionTexture } = this.environment;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { title, subtitle } = this.vision;
    let rows = this.vision.rows;
    if (this.running && this.race) {
      // レース中は現在の位置順を表示
      const order = this.currentOrder(this.horses.map((_, i) => this.horseProgress(i)));
      rows = order.map((i) => this.vision!.rows[i]).filter(Boolean);
    }
    const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
    g.addColorStop(0, "#0b1a33");
    g.addColorStop(1, "#06101f");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#ffd23f";
    ctx.font = "bold 46px sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.fillText(title, 32, 50, 640);
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 34px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(subtitle, canvas.width - 32, 50, 340);
    ctx.textAlign = "left";
    rows.slice(0, 5).forEach((row, i) => {
      const y = 120 + i * 56;
      ctx.fillStyle = "rgba(255,255,255,0.08)";
      ctx.fillRect(24, y - 24, canvas.width - 48, 48);
      ctx.fillStyle = "#ffd23f";
      ctx.font = "bold 34px sans-serif";
      ctx.fillText(String(i + 1), 40, y + 2);
      ctx.fillStyle = row.color;
      ctx.fillRect(90, y - 20, 56, 40);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.fillText(String(row.number), 118, y + 2);
      ctx.textAlign = "left";
      ctx.fillText(row.name, 170, y + 2, canvas.width - 220);
    });
    visionTexture.needsUpdate = true;
  }
}
