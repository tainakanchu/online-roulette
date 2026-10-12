import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { runningPositionAt, winnerTime, type RaceSimulation } from "@tainakanchu/roulette-core";
import type { TrackGoing, TrackSurface } from "../../../utils/raceCourse";
import {
  createEnvironment,
  FINISH_X,
  TRACK_HALF_WIDTH,
  WORLD_PER_METER,
  type Environment,
} from "./environment";
import { HorseModel, type HorseSpec } from "./horseModel";
import { CourseExtras, loadCourseExtraModels } from "./courseExtras";
import { loadPigeonModel, Pigeons } from "./pigeons";
import { ClothFlags } from "./clothFlag";
import { SoftBodyWorld } from "./softBodyPhysics";
import { TailPhysics } from "./tailPhysics";
import { CourseWind } from "./wind";
import { PHOTO_WIDTH, PhotoFinish } from "./photoFinish";
import type { RaceWind } from "../../../utils/raceWind";
import { MAX_HORSES } from "@tainakanchu/roulette-core";
import { CourseProps, loadCoursePropModels, PATROL_TOWER_X } from "./courseProps";
import { acquireNoise3D, releaseNoise3D } from "./noise3d";
import { CinemaGradePass, CinematicBlurPass, DepthFogPass, LayerOverlayPass, LensFlarePass } from "./postprocess";
import { createRustyMetalMaterial } from "./rust";
import { CLEAR_SKY, OVERCAST_SKY, overcastAmount } from "./surfaceCommon";
import { loadGateModel, releaseGateDetail, StartingGate, type GateModel } from "./startingGate";
import { createSignTexture, createSoftDotTexture } from "./textures";
import type { VisionInfo } from "./turfVision";
import type { NewsSegment } from "../../../utils/raceNews";
import type { NewsStudio } from "./newsStudio";
import type { NewsWallInfo } from "./newsScreens";
import {
  formatRaceClock,
  formatRaceTime,
  marginLabel,
  winningTimeSeconds,
} from "../../../utils/raceResult";

export type { VisionInfo } from "./turfVision";

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

export interface NewsCallbacks {
  /** カット（segments の index）が切り替わった */
  onSegment?: (index: number) => void;
  /** ニュースが終わった（読み込めなかったときもすぐ呼ぶ） */
  onEnd?: () => void;
}

/** レース後のニュースに使う、確定した結果 */
export interface RaceSummary {
  /** 着順（馬 index） */
  order: number[];
  /** 1・2 着の着差（馬身） */
  marginLengths: number;
  /** 着差の表示（order[i] と order[i + 1] の間） */
  margins: string[];
  /** 写真判定になったか */
  photo: boolean;
  /** 勝ち時計の表示 */
  finalTime: string;
}

export type { NewsWallInfo } from "./newsScreens";

type Shot =
  | "idle"
  | "gate"
  | "chase"
  | "side"
  | "jockey"
  | "aerial"
  | "rail"
  | "headon"
  | "stretch"
  | "finish"
  | "winner"
  | "board";

interface ShotStyle {
  /** 画角（度）。望遠ほど小さく、遠近が詰まって迫力が出る */
  fov: number;
  /** カメラの傾き（ラジアン。ダッチアングル） */
  roll: number;
  /** 手持ちカメラの揺れの大きさ（ワールド単位） */
  shake: number;
  /** カメラが狙いを追う速さ（バネの固有角振動数。大きいほどきびきび追う） */
  follow: number;
}

/**
 * カットごとの撮り方（映画風）。レース前はクレーンでゆっくり降り、スタートは地面すれすれの正面から望遠で受け、
 * 道中は望遠の横移動・ドローン・内ラチ沿いの低いカメラ、直線は超望遠の正面と真横のドリーでつなぐ
 */
const SHOT_STYLES: Record<Shot, ShotStyle> = {
  idle: { fov: 34, roll: 0, shake: 0, follow: 1.4 },
  gate: { fov: 30, roll: 0.02, shake: 0.015, follow: 2 },
  chase: { fov: 24, roll: 0, shake: 0.03, follow: 3.2 },
  side: { fov: 22, roll: 0, shake: 0.05, follow: 2.6 },
  jockey: { fov: 64, roll: 0, shake: 0, follow: 0 },
  aerial: { fov: 36, roll: 0.06, shake: 0.02, follow: 1.8 },
  rail: { fov: 30, roll: -0.07, shake: 0.02, follow: 4 },
  headon: { fov: 17, roll: 0, shake: 0.04, follow: 2.4 },
  stretch: { fov: 28, roll: 0.02, shake: 0.05, follow: 3.4 },
  finish: { fov: 30, roll: 0, shake: 0, follow: 14 },
  winner: { fov: 28, roll: 0, shake: 0.02, follow: 1.6 },
  board: { fov: 42, roll: 0, shake: 0, follow: 1.4 },
};

/** ジョッキー視点の画角。目で見ている広さに近づけ、周りの馬が視界の端に入るように広めにとる */
const JOCKEY_FOV = SHOT_STYLES.jockey.fov;

/** 勝ち馬のゴールから確定までの最短の時間（実時間） */
const POST_FINISH_SECONDS = 4.2;
/** 最後の馬がゴールしてから確定するまでの間 */
const CONFIRM_AFTER_LAST_SECONDS = 1.2;
/** 上位 5 頭がゴールしてから着順掲示板に切り替えるまでの間 */
const RESULT_BOARD_DELAY_SECONDS = 1.5;
/** これだけ待っても全馬がゴールしなければ確定させる（念のため） */
const MAX_POST_FINISH_SECONDS = 15;
/** 写真判定にする 1・2 着の差（馬身） */
const PHOTO_MARGIN_LENGTHS = 0.25;
/**
 * 1 馬身のワールド単位（馬のモデルの鼻先から尾まで）。コースは 1m = 0.16 単位に縮めてあり馬の大きさと縮尺が違うので、
 * 着差はメートルではなく画面で見える馬の体の長さで数える（メートル換算だと見た目より何倍も大きな着差になる）
 */
const HORSE_LENGTH_UNITS = 2.4;
const FINISH_HOLD_SECONDS = 1.3;
/** 確定してから、電光掲示板を映し続ける時間 */
const BOARD_HOLD_AFTER_CONFIRM_SECONDS = 3;
/** 写真判定: 決勝写真をターフビジョンに映しておく秒数（この間は確定しない） */
const PHOTO_HOLD_SECONDS = 4.5;
/** 決勝写真で、馬 1 頭の長さを何ピクセルにするか（写真の幅 1024 で 9 馬身ほど写る） */
const PHOTO_PIXELS_PER_LENGTH = 110;
/** 決勝写真の左端から、勝ち馬の鼻先までのピクセル */
const PHOTO_WINNER_PIXEL = 300;
/** ターフビジョンの画面の中心（environment.ts の配置と合わせる） */
const BOARD_CENTER = new THREE.Vector3(FINISH_X - 50, 12, TRACK_HALF_WIDTH + 26);
/** スローモーションにする1・2着の見た目の差（単位。約13m） */
const CLOSE_FINISH_GAP = 0.3;
const OVERRUN = 32;
/** ニュースの VTR: ゴールの前後をスローで見せる再生速度と、スローにする範囲（実時間の秒。ゴールの前と後） */
const REPLAY_SLOW_SCALE = 0.3;
const REPLAY_SLOW_BEFORE = 0.9;
const REPLAY_SLOW_AFTER = 0.7;

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

/**
 * 太陽の方向（高度約 11°、走路の奥 -x からスタンド側へ 20° 振った方位）。
 * 夕方の低い太陽にして、正面から馬群を撮るカメラ（-x 向き）で逆光とレンズフレアが入り、
 * スタンド側（-z）から見る馬体にも斜めから日が当たるようにする。
 * これ以上スタンド側へ振ると、ゴール前で太陽がスタンドの陰に隠れてフレアが出なくなる
 */
const SUN_DIRECTION = new THREE.Vector3(-0.922, 0.191, -0.336).normalize();

/**
 * 馬名のラベルを置くレイヤー。シーン本体（レイヤー 0）とは別に、ポストプロセスの後から重ねて描く。
 * ターフビジョンの中継映像のカメラもレイヤー 0 しか映さないので、映像にラベルは出ない
 */
const LABEL_LAYER = 1;

/** 馬場状態ごとの水分（シェーダーの濡れ具合） */
const GOING_WETNESS: Record<TrackGoing, number> = { firm: 0, good: 0.35, yielding: 0.7, soft: 1 };

// ----- 土煙パーティクル -----
const DUST_VERTEX = /* glsl */ `
  attribute float alpha;
  attribute float size;
  uniform vec3 sunDir;
  uniform float scatter;
  varying float vAlpha;
  varying float vLight;
  void main() {
    vAlpha = alpha;
    // 太陽の方を向いて見るほど、粒が光を散らして明るく光る（逆光の土煙）
    vec3 viewDir = normalize(position - cameraPosition);
    vLight = 0.85 + scatter * pow(max(dot(viewDir, sunDir), 0.0), 4.0);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (300.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;
const DUST_FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 color;
  varying float vAlpha;
  varying float vLight;
  void main() {
    vec4 tex = texture2D(map, gl_PointCoord);
    gl_FragColor = vec4(color * vLight, tex.a * vAlpha);
    #include <colorspace_fragment>
  }
`;

/** 蹄が跳ね上げるもの。乾いた馬場は舞い上がる土煙、渋った馬場は落ちてくる泥や芝の塊 */
interface DustStyle {
  color: string;
  /** 1 頭・1 秒あたりの粒数 */
  rate: number;
  size: number;
  /** 1 秒あたりの広がり */
  growth: number;
  gravity: number;
  lift: number;
  /** 1 秒あたりの寿命の減り */
  decay: number;
  opacity: number;
  /** 逆光で明るく光る強さ */
  scatter: number;
}

const DUST_STYLES: Record<TrackSurface, { dry: DustStyle; wet: DustStyle }> = {
  turf: {
    dry: { color: "#8c7a52", rate: 22, size: 1, growth: 1.6, gravity: 6, lift: 2.2, decay: 1.1, opacity: 0.55, scatter: 1.2 },
    wet: { color: "#3f4a2a", rate: 12, size: 0.28, growth: 0.1, gravity: 14, lift: 3.5, decay: 1.5, opacity: 0.9, scatter: 0.2 },
  },
  dirt: {
    dry: { color: "#c4a57a", rate: 40, size: 1.05, growth: 1.9, gravity: 6, lift: 2.4, decay: 1, opacity: 0.6, scatter: 1.6 },
    wet: { color: "#4a3826", rate: 30, size: 0.3, growth: 0.1, gravity: 14, lift: 4, decay: 1.4, opacity: 0.9, scatter: 0.2 },
  },
};

const mixDustStyle = (a: DustStyle, b: DustStyle, t: number) => {
  const lerp = (x: number, y: number) => x + (y - x) * t;
  return {
    color: new THREE.Color(a.color).lerp(new THREE.Color(b.color), t),
    rate: lerp(a.rate, b.rate),
    size: lerp(a.size, b.size),
    growth: lerp(a.growth, b.growth),
    gravity: lerp(a.gravity, b.gravity),
    lift: lerp(a.lift, b.lift),
    decay: lerp(a.decay, b.decay),
    opacity: lerp(a.opacity, b.opacity),
    scatter: lerp(a.scatter, b.scatter),
  };
};

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
  private style = mixDustStyle(DUST_STYLES.turf.dry, DUST_STYLES.turf.wet, 0);

  constructor(sunDir: THREE.Vector3, private readonly count = 1400) {
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
      uniforms: {
        map: { value: this.texture },
        color: { value: this.style.color.clone() },
        sunDir: { value: sunDir.clone() },
        scatter: { value: this.style.scatter },
      },
    });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
  }

  /** 1 頭・1 秒あたりの粒数 */
  get rate() {
    return this.style.rate;
  }

  setStyle(surface: TrackSurface, wetness: number) {
    const styles = DUST_STYLES[surface];
    this.style = mixDustStyle(styles.dry, styles.wet, wetness);
    this.material.uniforms.color.value.copy(this.style.color);
    this.material.uniforms.scatter.value = this.style.scatter;
  }

  emit(x: number, z: number, speed: number) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    this.positions[i * 3] = x + (Math.random() - 0.5) * 0.4;
    this.positions[i * 3 + 1] = 0.1;
    this.positions[i * 3 + 2] = z + (Math.random() - 0.5) * 0.5;
    this.velocities[i * 3] = -speed * (0.05 + Math.random() * 0.1);
    this.velocities[i * 3 + 1] = (0.45 + Math.random()) * this.style.lift;
    this.velocities[i * 3 + 2] = (Math.random() - 0.5) * 1.5;
    this.life[i] = 1;
    this.sizes[i] = (0.6 + Math.random() * 0.9) * this.style.size;
  }

  update(dt: number) {
    for (let i = 0; i < this.count; i += 1) {
      if (this.life[i] <= 0) {
        this.alphas[i] = 0;
        continue;
      }
      this.life[i] -= dt * this.style.decay;
      this.velocities[i * 3 + 1] -= this.style.gravity * dt;
      this.positions[i * 3] += this.velocities[i * 3] * dt;
      this.positions[i * 3 + 1] = Math.max(0.05, this.positions[i * 3 + 1] + this.velocities[i * 3 + 1] * dt);
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * dt;
      this.sizes[i] += dt * this.style.growth;
      this.alphas[i] = Math.max(0, this.life[i]) * this.style.opacity;
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

// ----- メインのシーン -----
export class RaceScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 3000);
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly fog: DepthFogPass;
  private readonly blur: CinematicBlurPass;
  /** 馬群の位置（モーションブラーで、馬群が 1 フレームに進んだ分を求める） */
  private prevFieldX = 0;
  private readonly fieldMin = new THREE.Vector3();
  private readonly fieldMax = new THREE.Vector3();
  private readonly fieldDelta = new THREE.Vector3();
  private readonly flare: LensFlarePass;
  private readonly sun: THREE.DirectionalLight;
  private readonly hemisphere = new THREE.HemisphereLight("#cfe6ff", "#4c6b2c", 0.9);
  private readonly environment: Environment;
  private readonly dust = new Dust(SUN_DIRECTION);
  private readonly clock = new THREE.Clock();
  private readonly resizeObserver: ResizeObserver;
  private readonly lookAt = new THREE.Vector3(0, 1.5, 0);
  private readonly desiredPos = new THREE.Vector3();
  private readonly desiredLook = new THREE.Vector3();
  /** カメラの位置と注視点をバネで追うときの速さ（動き出しと止まりをなめらかにする） */
  private readonly cameraVelocity = new THREE.Vector3();
  private readonly lookVelocity = new THREE.Vector3();
  /** 今の画角と傾き（カットの撮り方へなめらかに寄せる） */
  private cameraRoll = 0;
  /** 内ラチ沿いの低いカメラを置いた x（カットの頭で、先頭の馬の少し先に置いて動かさない） */
  private railCameraX = 0;
  /** 映画風の画づくりの強さ（レース中は強く、レース前は弱く） */
  private cinemaAmount = 0;
  private readonly shakeOffset = new THREE.Vector3();
  /** バネで動かすカメラの位置（手持ちの揺れを足す前）。揺れをバネの計算に持ち込まないよう、カメラの位置とは別に持つ */
  private readonly cameraBase = new THREE.Vector3(14, 4, 9);
  /** 前のフレームの狙い（狙いが動く速さを求め、バネが動く被写体に遅れずに付いていけるようにする） */
  private readonly prevDesiredPos = new THREE.Vector3();
  private readonly prevDesiredLook = new THREE.Vector3();
  private readonly desiredPosVelocity = new THREE.Vector3();
  private readonly desiredLookVelocity = new THREE.Vector3();
  private readonly cinema: CinemaGradePass;
  private rafId = 0;
  private time = 0;

  private horses: HorseModel[] = [];
  private lanes: number[] = [];
  private gate: StartingGate | null = null;
  /** Blender で作ったゲートのモジュール（読み込めるまでは簡易なゲート） */
  private gateModel: GateModel | null = null;
  private laneWidth = 1.7;
  private disposed = false;
  /** Blender で作ったコースの標識・備品（読み込めるまでは手続き生成の簡易な標識） */
  private courseProps: CourseProps | null = null;
  /** コース全般の備品・車両・植栽・係員（course-extras.glb） */
  private courseExtras: CourseExtras | null = null;
  /** 走路に降りている鳩の群れ（馬群が近づくと飛び立つ） */
  private pigeons: Pigeons | null = null;
  /** 決勝写真（写真判定のカメラ） */
  private readonly photoFinish = new PhotoFinish();
  /** 写真判定の画面に切り替えた時刻と、確定してよくなる時刻（接戦でなければ Infinity と 0） */
  private photoShownAt = Infinity;
  private photoUntil = 0;
  /** 会場の風（旗・尻尾・芝と木の揺れ） */
  private readonly wind: CourseWind;
  /** 物理エンジン（尻尾の毛と旗の布）。WebAssembly を読み込み終わるまでは null で、尻尾と旗は頂点シェーダーで揺らす */
  private softWorld: SoftBodyWorld | null = null;
  private tailPhysics: TailPhysics | null = null;
  private clothFlags: ClothFlags | null = null;
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
  /** 勝ち馬がゴール線を越えた瞬間のフレーム（結果画像用） */
  private finishPhoto: HTMLCanvasElement | null = null;
  private finishPhotoPending = false;
  private callbacks: RaceCallbacks = {};
  private frameListener: ((canvas: HTMLCanvasElement) => void) | null = null;
  private shot: Shot = "idle";
  /** ジョッキー視点で乗る馬（カットが変わるたびに、2 番手以下からランダムに選ぶ） */
  private jockeyHorse = 0;
  /** 画面の縦横比で決まる通常の画角（ジョッキー視点のときだけ広げる） */
  private baseFov = 42;
  private shotTime = 0;
  private lastTickAt = 0;
  private excitement = 0;
  private slowMotion = false;
  /** カメラが追う馬群の位置（なめらかに追従させる） */
  private focusX = 0;
  // 着順（ゴールした順）と、ターフビジョンに出す時計
  private surface: TrackSurface = "turf";
  private going: TrackGoing = "firm";
  private visionInfo: VisionInfo | null = null;
  /** レース内部時刻 1 単位あたりの実際らしい秒数（走破時計の換算） */
  private secondsPerUnit = 1;
  private winnerSeconds = 0;
  private finishOrder: number[] = [];
  /** 馬ごとのゴールの時刻（レース内部時刻。ゴール前は NaN） */
  private crossTimes: number[] = [];
  private prevProgress: number[] = [];
  private prevRaceT = 0;
  private lastCrossAt = 0;
  private resultBoardAt = Infinity;
  /** 電光掲示板のカメラから勝ち馬のカメラに戻す時刻 */
  private boardShotUntil = Infinity;
  private leaderFraction = 0;
  // 中継映像のカメラ
  private videoShot = "";
  /** レース後のニュース（スタジオは最初に要ったときに読み込む） */
  private studio: NewsStudio | null = null;
  private studioLoading: Promise<NewsStudio | null> | null = null;
  private news: { segments: NewsSegment[]; index: number; time: number; callbacks: NewsCallbacks } | null = null;
  /** ニュースの VTR（ゴール前のリプレイ）。savedT はリプレイ前のレース内部時刻（終わったら戻す） */
  private replay: { slowFrom: number; savedT: number; time: number } | null = null;
  private readonly videoLook = new THREE.Vector3();
  private readonly videoPos = new THREE.Vector3();
  private readonly videoDesiredPos = new THREE.Vector3();
  private readonly videoDesiredLook = new THREE.Vector3();
  private readonly frustum = new THREE.Frustum();
  private readonly frustumMatrix = new THREE.Matrix4();
  private frameCount = 0;

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

    const sunDir = SUN_DIRECTION;
    this.scene.add(this.hemisphere);
    // 太陽が低いぶん地面への入射が浅くなるので少し強め、色は夕方寄り
    this.sun = new THREE.DirectionalLight("#ffe6c4", 3);
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

    // 地面・スタンド・木・馬などのシェーダーが共有する 3D ノイズテクスチャ。マテリアルを作る前に用意する
    acquireNoise3D();
    // 芝の葉は本数が多いので、小さい画面（≒スマホ）では減らす
    this.environment = createEnvironment(sunDir, {
      // 葉を生やす範囲を広げた分だけ増やし、近くの密度は保つ
      grassBlades: smallScreen ? 80000 : 210000,
      detailedTrees: !smallScreen,
    });
    this.scene.add(this.environment.group);
    this.wind = new CourseWind(this.environment.uniforms);
    this.scene.add(this.courseMarks);
    this.scene.add(this.dust.points);

    const target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: 4,
      // 深度フォグとレンズフレアの遮蔽判定で使う（MSAA の深度も解決される）
      depthTexture: new THREE.DepthTexture(1, 1),
    });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // 霧はブルームより前にかけて、霞んだ遠景が光りすぎないようにする
    this.fog = new DepthFogPass(this.camera, {
      color: CLEAR_SKY.horizon,
      sunColor: "#ffd9a6",
      sunDirection: sunDir,
      density: 0.0013,
      heightFalloff: 0.03,
      start: 30,
      skyHaze: 0.2,
    });
    this.composer.addPass(this.fog);
    const fog = this.fog;
    // ぶれとぼけは霧をかけた後、ブルームの前（ぼけた明るい所がブルームで自然ににじむように）
    this.blur = new CinematicBlurPass(this.camera, () => fog.sceneDepth, smallScreen ? 10 : 16);
    this.composer.addPass(this.blur);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.22, 0.45, 0.92);
    this.composer.addPass(this.bloom);
    // フレアはレンズで起きる現象なので、霧やブルームの後から足す
    this.flare = new LensFlarePass(this.camera, {
      sunDirection: sunDir,
      tint: "#ffe2b8",
      intensity: 1,
      depth: () => fog.sceneDepth,
    });
    this.composer.addPass(this.flare);
    // 映画風の画づくり（色収差・色調・周辺減光・粒子）。ラベルにはかけない
    this.cinema = new CinemaGradePass();
    this.composer.addPass(this.cinema);
    // 馬名のラベル（レイヤー 1）は霧・ぶれ・ぼけ・ブルームの後から重ねて、くっきり読めるようにする
    this.composer.addPass(new LayerOverlayPass(this.scene, this.camera, LABEL_LAYER));
    this.composer.addPass(new OutputPass());

    loadGateModel()
      .then((model) => {
        if (this.disposed) return;
        this.gateModel = model;
        this.rebuildGate(true);
      })
      .catch((error) => console.warn("Failed to load starting gate model", error));
    loadCoursePropModels()
      .then((models) => {
        if (this.disposed) return;
        this.courseProps = new CourseProps(models, SUN_DIRECTION);
        this.courseProps.setClothFlags(this.clothFlags);
        this.buildCourseMarks();
      })
      .catch((error) => console.warn("Failed to load course props", error));
    loadCourseExtraModels()
      .then((models) => {
        if (this.disposed) return;
        this.courseExtras = new CourseExtras(models, this.environment.uniforms, SUN_DIRECTION);
        this.courseExtras.setClothFlags(this.clothFlags);
        this.courseExtras.layout(this.startX);
        this.scene.add(this.courseExtras.group);
      })
      .catch((error) => console.warn("Failed to load course extras", error));
    loadPigeonModel()
      .then((model) => {
        if (this.disposed) return;
        this.pigeons = new Pigeons(model);
        this.pigeons.reset(this.startX);
        this.scene.add(this.pigeons.group);
      })
      .catch((error) => console.warn("Failed to load pigeons", error));
    // 重力は 9.8m/s² を 1m ≒ 1.5 単位に直した値
    SoftBodyWorld.create(9.8 * 1.5)
      .then((world) => {
        if (this.disposed) {
          world.dispose();
          return;
        }
        this.softWorld = world;
        this.tailPhysics = new TailPhysics(world, MAX_HORSES);
        this.tailPhysics.setHorses(this.horses);
        this.scene.add(this.tailPhysics.mesh);
        this.clothFlags = new ClothFlags(world, this.wind);
        this.scene.add(this.clothFlags.group);
        this.courseProps?.setClothFlags(this.clothFlags);
        this.courseExtras?.setClothFlags(this.clothFlags);
        // 旗を物理の布で組み直す
        this.buildCourseMarks();
      })
      .catch((error) => console.warn("Failed to load physics engine", error));

    this.camera.position.copy(this.cameraBase);
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
    this.tailPhysics?.setHorses(this.horses);
    this.placeAtGate();
    this.buildCourse(laneWidth);
    this.setShot("idle", true, true);
  }

  /** 芝・ダートと馬場状態。見た目（路面・土煙・霞）だけを変える */
  setCourse(surface: TrackSurface, going: TrackGoing) {
    this.surface = surface;
    this.going = going;
    const wetness = GOING_WETNESS[going];
    this.environment.setCourse(surface, wetness);
    this.dust.setStyle(surface, wetness);
    // 天気は馬場状態に合わせる。渋るほど雲が厚く、日差しが弱く、空からの光が増え、湿った空気で霞む
    const lerp = THREE.MathUtils.lerp;
    const overcast = overcastAmount(wetness);
    this.sun.intensity = lerp(3, 0.85, overcast);
    this.hemisphere.intensity = lerp(0.9, 1.35, overcast);
    this.fog.setDensityScale(1 + wetness * 0.6);
    this.fog.setColors(
      new THREE.Color(CLEAR_SKY.horizon).lerp(new THREE.Color(OVERCAST_SKY.horizon), overcast),
      new THREE.Color("#ffd9a6").lerp(new THREE.Color("#c4c7cb"), overcast)
    );
    this.flare.setIntensityScale(lerp(1, 0.08, overcast));
  }

  /** 会場の風（向きと強さ）。旗のなびき方・尻尾の流れ・芝と木の揺れが変わる */
  setWind(wind: RaceWind) {
    this.wind.set(wind);
  }

  /** ターフビジョンに出すレースの情報（着順や時計はシーンがレースの進み具合から決める） */
  setVision(info: VisionInfo) {
    this.visionInfo = info;
    this.environment.vision.setInfo(info);
  }

  /** カウントダウン用のカメラへ。全馬の枠入りが終わったので、ゲートの前面の枠入り確認ランプを点ける */
  showGate() {
    this.setShot("gate");
    this.gate?.setLamp(true);
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
    this.finishPhoto = null;
    this.callbacks = callbacks;
    this.focusX = this.startX;
    // 勝ち馬はレース内部時刻 winnerTime でゴールするので、それが勝ち時計になるよう換算する
    this.winnerSeconds = winningTimeSeconds(this.distanceMeters, this.surface, this.going, Math.random() * 2 - 1);
    this.secondsPerUnit = this.winnerSeconds / Math.max(0.1, winnerTime(race));
    this.resetFinishState();
    // 決勝写真: 勝ち馬はレース内部時刻 winnerTime でゴールするので、その少し前から撮る
    const unitsPerTime = (FINISH_X - this.startX) / Math.max(0.1, winnerTime(race));
    const timePerPixel = HORSE_LENGTH_UNITS / unitsPerTime / PHOTO_PIXELS_PER_LENGTH;
    this.photoFinish.start(this.renderer, {
      finishX: FINISH_X,
      // 平行投影なので、カメラと走路の距離は写り方に関係しない。スタンドの中に入らないよう、外ラチのすぐ外に置く
      cameraZ: -(TRACK_HALF_WIDTH + 1.7),
      timePerPixel,
      startTime: winnerTime(race) - PHOTO_WINNER_PIXEL * timePerPixel,
      speed: unitsPerTime,
    });
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

  /** ゴールの瞬間のフレーム。レース前なら現在のフレームを返す */
  getFinishPhoto(): HTMLCanvasElement {
    if (this.finishPhoto) return this.finishPhoto;
    this.composer.render();
    return this.snapshot();
  }

  /** 描画直後のキャンバスを毎フレーム受け取る（録画用） */
  setFrameListener(listener: ((canvas: HTMLCanvasElement) => void) | null) {
    this.frameListener = listener;
  }

  /** 確定した結果（ニュースの原稿と結果の表に使う）。確定前は null */
  getRaceSummary(): RaceSummary | null {
    const race = this.race;
    const [first, second] = this.finishOrder;
    if (!race || !this.completed || first === undefined) return null;
    const unitsPerTime = (FINISH_X - this.startX) / Math.max(0.1, winnerTime(race));
    const lengthsBetween = (ahead: number, behind: number) =>
      ((this.crossTimes[behind] - this.crossTimes[ahead]) * unitsPerTime) / HORSE_LENGTH_UNITS;
    const labels = this.visionInfo?.labels;
    const marginLengths = second === undefined ? 0 : lengthsBetween(first, second);
    return {
      order: [...this.finishOrder],
      marginLengths,
      margins: this.finishOrder
        .slice(1)
        .map((horse, k) => (labels ? marginLabel(lengthsBetween(this.finishOrder[k], horse), labels) : "")),
      photo: this.photoShownAt < Infinity || marginLengths < PHOTO_MARGIN_LENGTHS,
      finalTime: formatRaceTime(this.winnerSeconds),
    };
  }

  /** ニュースのスタジオを先に読み込んでおく（レースが始まったら呼ぶ。2 回目以降は同じものを返す） */
  prepareNews(): Promise<NewsStudio | null> {
    if (!this.studioLoading) {
      this.studioLoading = import("./newsStudio")
        .then(async ({ NewsStudio, loadNewsModels }) => {
          const models = await loadNewsModels();
          if (this.disposed) return null;
          const studio = new NewsStudio(this.renderer, models);
          studio.setSize(Math.max(1, this.container.clientWidth), Math.max(1, this.container.clientHeight));
          this.studio = studio;
          return studio;
        })
        .catch((error) => {
          console.warn("Failed to load news studio", error);
          // 次のレースでもう一度読み込めるようにする
          this.studioLoading = null;
          return null;
        });
    }
    return this.studioLoading;
  }

  /**
   * レース後のニュースを始める。スタジオに切り替え、segments の順にカットを進め、VTR のカットではゴール前をリプレイする
   */
  startNews(segments: NewsSegment[], info: NewsWallInfo, callbacks: NewsCallbacks) {
    this.stopNews();
    const news = { segments, index: -1, time: 0, callbacks };
    this.news = news;
    void this.prepareNews().then((studio) => {
      // 読み込んでいる間に止められた / 別のニュースが始まった
      if (this.news !== news) return;
      if (!studio || segments.length === 0) {
        this.news = null;
        callbacks.onEnd?.();
        return;
      }
      studio.setInfo(info);
      this.enterNewsSegment(0);
    });
  }

  /** ニュースを途中でやめて競馬場に戻る（onEnd は呼ばない） */
  stopNews() {
    if (!this.news) return;
    this.news = null;
    this.stopReplay();
    if (this.race) this.setShot("winner", true, true);
  }

  /** preserveDrawingBuffer なしでも読めるよう、描画直後に 2D キャンバスへ写す */
  private snapshot(): HTMLCanvasElement {
    const source = this.renderer.domElement;
    const canvas = document.createElement("canvas");
    canvas.width = source.width;
    canvas.height = source.height;
    canvas.getContext("2d")?.drawImage(source, 0, 0);
    return canvas;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    for (const horse of this.horses) horse.dispose();
    this.gate?.dispose();
    releaseGateDetail();
    this.courseDisposables.forEach((d) => d.dispose());
    this.environment.dispose();
    this.dust.dispose();
    this.fog.dispose();
    this.blur.dispose();
    this.flare.dispose();
    this.cinema.dispose();
    this.courseProps?.dispose();
    this.courseExtras?.dispose();
    this.pigeons?.dispose();
    // 物理のボディを消してから物理エンジンを片付ける
    this.tailPhysics?.dispose();
    this.clothFlags?.dispose();
    this.softWorld?.dispose();
    this.photoFinish.dispose();
    this.studio?.dispose();
    this.composer.dispose();
    releaseNoise3D();
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
    // ゲートに戻るたびに、鳩の群れを走路に降ろし直す
    this.pigeons?.reset(this.startX);
  }

  private resetFinishState() {
    this.finishOrder = [];
    this.crossTimes = this.horses.map(() => Number.NaN);
    this.prevProgress = this.horses.map(() => 0);
    this.prevRaceT = 0;
    this.lastCrossAt = 0;
    this.resultBoardAt = Infinity;
    this.boardShotUntil = Infinity;
    this.photoShownAt = Infinity;
    this.photoUntil = 0;
    this.leaderFraction = 0;
    this.environment.vision.reset();
  }

  private stopRace() {
    this.news = null;
    this.replay = null;
    this.resetFinishState();
    this.running = false;
    this.race = null;
    this.winnerCrossed = false;
    this.completed = false;
    this.finishPhoto = null;
    this.finishPhotoPending = false;
    this.slowMotion = false;
    this.timeScale = 1;
    this.excitement = 0;
    this.callbacks = {};
  }

  private buildCourse(laneWidth: number) {
    this.laneWidth = laneWidth;
    this.rebuildGate();
    this.buildCourseMarks();
  }

  /** ゴール線と標識・備品。距離が変わるとハロン棒の本数と発走委員の台の位置が変わる */
  private buildCourseMarks() {
    const distanceMeters = this.distanceMeters;
    this.courseProps?.releaseInstances();
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

    const white = track(new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.5 }));
    const line = add(new THREE.PlaneGeometry(0.5, TRACK_HALF_WIDTH * 2), white, false);
    line.rotation.x = -Math.PI / 2;
    line.position.set(FINISH_X, 0.02, 0);
    line.receiveShadow = true;
    // ゲート車・係員・救急車は発走地点に合わせて置き直す
    this.courseExtras?.layout(this.startX);
    if (this.courseProps) {
      this.placeCourseProps(this.courseProps, distanceMeters);
      return;
    }

    // glb を読み込むまでの簡易な標識。柱と標識の板は屋外で風雨にさらされた塗装（うっすら錆）
    const paintedWhite = track(
      createRustyMetalMaterial({ paint: "#ffffff", rust: 0.12, scale: 2, roughness: 0.45, metalness: 0.1 })
    );
    const red = track(createRustyMetalMaterial({ paint: "#d32f2f", rust: 0.12, scale: 2, roughness: 0.4, metalness: 0.1 }));
    // ゴール板は内ラチ側だけ（スタンド側のカメラから馬越しに見える）
    const pole = add(new THREE.CylinderGeometry(0.1, 0.1, 5, 10), paintedWhite);
    pole.position.set(FINISH_X, 2.5, TRACK_HALF_WIDTH + 1.2);
    const disc = add(new THREE.CylinderGeometry(0.9, 0.9, 0.08, 32), red);
    disc.rotation.x = Math.PI / 2;
    disc.position.set(FINISH_X, 4.6, TRACK_HALF_WIDTH + 1.2);
    // ハロン棒（残り距離）。共有ジオメトリ・マテリアルで本数が増えても軽く
    const poleGeo = track(new THREE.CylinderGeometry(0.08, 0.08, 3, 8));
    const signGeo = track(new THREE.PlaneGeometry(2.2, 0.6));
    const step = 200;
    for (let remain = step; remain < distanceMeters; remain += step) {
      const x = FINISH_X - remain * WORLD_PER_METER;
      const pole = add(poleGeo, remain % 400 === 0 ? red : paintedWhite);
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

  /**
   * Blender で作った標識・備品を置く。glb は +Z が走路側なので、内馬場側（走路の +Z 側）に置くものは半回転させる
   */
  private placeCourseProps(props: CourseProps, distanceMeters: number) {
    const place = (object: THREE.Object3D, x: number, z: number, infield: boolean) => {
      object.position.set(x, 0, z);
      if (infield) object.rotation.y = Math.PI;
      this.courseMarks.add(object);
    };
    // ゴール板は内ラチのすぐ内側、ゴール線の真横（スタンド側のカメラから馬越しに見える）
    place(props.finishPost(), FINISH_X, TRACK_HALF_WIDTH + 1.5, true);
    // ハロン棒はゴールから 200m ごと。数字は残り距離を 100m 単位で表す
    for (let remain = 200; remain < distanceMeters; remain += 200) {
      place(props.furlongPole(remain), FINISH_X - remain * WORLD_PER_METER, TRACK_HALF_WIDTH + 1.1, true);
    }
    // 発走委員の台はゲートの少し後ろ、外ラチの外（スタンド側）
    place(props.starterStand(), this.startX - 4, -(TRACK_HALF_WIDTH + 2.8), false);
    // パトロールタワーと中継カメラ台は内馬場側
    for (const x of PATROL_TOWER_X) {
      place(props.patrolTower(), x, TRACK_HALF_WIDTH + 12, true);
    }
    for (const x of [FINISH_X - 70, FINISH_X - 160]) {
      place(props.cameraPlatform(), x, TRACK_HALF_WIDTH + 5, true);
    }
  }

  /**
   * 頭数・距離が変わったときと、ゲートのモデルを読み込めたときにゲートを組み直す
   * @param keepState 扉の開き具合を引き継ぐ（出走中に読み込みが終わったとき用）
   */
  private rebuildGate(keepState = false) {
    if (this.lanes.length === 0) return;
    const previous = this.gate;
    this.gate = new StartingGate(this.lanes, this.laneWidth, this.gateModel);
    this.gate.group.position.x = this.startX;
    this.scene.add(this.gate.group);
    if (previous) {
      if (keepState) this.gate.copyStateFrom(previous);
      this.scene.remove(previous.group);
      previous.dispose();
    }
  }

  private resize() {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    this.studio?.setSize(width, height);
    // ブルームは半分の解像度で十分
    this.bloom.resolution.set(width / 2, height / 2);
    this.camera.aspect = width / height;
    // 縦長画面では少し引く
    this.baseFov = width / height < 1.2 ? 55 : 42;
    this.camera.fov = this.shot === "jockey" ? JOCKEY_FOV : this.baseFov;
    this.camera.updateProjectionMatrix();
  }

  private setShot(shot: Shot, cut = true, force = false) {
    if (this.shot === shot && !force) return;
    this.shot = shot;
    this.shotTime = 0;
    if (shot === "jockey") this.jockeyHorse = this.pickJockeyHorse();
    if (shot === "rail") this.railCameraX = this.leaderX() + 20;
    // 勝ち馬のアップでは他馬の名前ラベルが大きく重なるので、勝ち馬のラベルだけ残す
    const winner = this.race?.winner ?? -1;
    this.horses.forEach((horse, i) => {
      // ジョッキー視点では、乗っている馬のラベルが目の前に来るので消す
      const isRidden = shot === "jockey" && i === this.jockeyHorse;
      horse.label.visible = shot === "board" || isRidden ? false : shot !== "winner" || i === winner;
    });
    if (cut) {
      this.blur.markCut();
      this.computeShot(0);
      this.cameraBase.copy(this.desiredPos);
      this.camera.position.copy(this.desiredPos);
      this.lookAt.copy(this.desiredLook);
      // カットでは画角と傾きも一気に切り替え、前のカットの動きの勢いは持ち越さない
      this.cameraVelocity.set(0, 0, 0);
      this.lookVelocity.set(0, 0, 0);
      this.prevDesiredPos.copy(this.desiredPos);
      this.prevDesiredLook.copy(this.desiredLook);
      this.cameraRoll = SHOT_STYLES[shot].roll;
      this.camera.fov = shot === "jockey" ? JOCKEY_FOV : this.styleFov(shot);
      this.camera.updateProjectionMatrix();
    }
  }

  private loop = () => {
    this.rafId = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());
    this.time += dt;
    this.updateNews(dt);
    this.update(dt);
    // ニュースのスタジオを映している間は、競馬場は動かすだけで描かない（VTR のカットでは競馬場を映す）
    const studio = this.studio;
    const inStudio = studio && this.news && this.news.index >= 0 && !this.replay;
    if (inStudio) {
      studio.update(dt);
      studio.render();
      return;
    }
    // 毛並みの模様を馬の体に貼りつけるため、今フレームの行列を確定させてから馬ごとの逆行列を渡す
    this.scene.updateMatrixWorld();
    for (const horse of this.horses) horse.syncCoatSpace();
    // 決勝写真はゴール線の 1 列を撮るだけなので、レース中は毎フレーム撮っておく（撮る範囲の時刻の外では何もしない）
    // ゴール線の上のゴール板や、内馬場側の写真判定の塔などの備品は写さない（背景は内馬場の芝と生垣の縞になる）
    // VTR のリプレイ中は撮らない（撮り終えた写真を上書きしない）
    if (this.running && !this.replay) {
      const hidden = [this.courseMarks, this.courseExtras?.group].filter((object) => object !== undefined);
      this.photoFinish.capture(this.renderer, this.scene, this.raceT, hidden);
    }
    this.composer.render();
    this.renderVisionVideo();
    this.frameListener?.(this.renderer.domElement);
    if (this.finishPhotoPending) {
      this.finishPhotoPending = false;
      this.finishPhoto = this.snapshot();
    }
  };

  /** 馬のレース内部での位置（単位） */
  private horseProgress(i: number): number {
    return this.race ? runningPositionAt(this.race, i, this.raceT) : 0;
  }

  private currentOrder(progresses: number[]) {
    return progresses.map((_, i) => i).sort((a, b) => progresses[b] - progresses[a]);
  }

  /**
   * 馬を動かす。progresses はレース内部の位置（単位）。走路の上の位置・向き・脚の運び・土煙を決める
   * @param dt 馬の動きの時間（スローモーション中は短い）
   * @param realDt 実時間（速さの平滑化に使う）
   */
  private moveHorses(progresses: number[], order: number[], leaderFraction: number, dt: number, realDt: number) {
    const target = this.race?.target ?? 1;
    const courseLength = FINISH_X - this.startX;
    const innermost = this.lanes[0] ?? 0;
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
      if (this.speeds[i] > 4 && Math.random() < dt * this.dust.rate) {
        this.dust.emit(x - 0.7, z, this.speeds[i]);
      }
    });
  }

  /** レース内部時刻 t の位置へ馬を飛ばす（リプレイの始まりと終わり）。速さも t の時点の速さにそろえる */
  private jumpHorsesTo(race: RaceSimulation, t: number) {
    const target = race.target;
    const courseLength = FINISH_X - this.startX;
    const step = 1 / 60;
    const worldX = (time: number, i: number) =>
      compressAfterFinish(this.startX + (runningPositionAt(race, i, time) / target) * courseLength);
    this.raceT = t;
    this.horses.forEach((_, i) => {
      const before = worldX(t - step * this.raceRate, i);
      this.prevWorldX[i] = before;
      this.speeds[i] = (worldX(t, i) - before) / step;
    });
    const progresses = this.horses.map((_, i) => this.horseProgress(i));
    const order = this.currentOrder(progresses);
    this.moveHorses(progresses, order, Math.min(1, (progresses[order[0]] ?? 0) / target), step, step);
  }

  // ----- レース後のニュース -----

  /** ニュースのカットを時間で進める。最後のカットが終わったら競馬場に戻る */
  private updateNews(dt: number) {
    const news = this.news;
    if (!news || news.index < 0) return;
    news.time += dt;
    const segment = news.segments[news.index];
    if (news.time < segment.seconds) return;
    const next = news.index + 1;
    if (next >= news.segments.length) {
      this.stopNews();
      news.callbacks.onEnd?.();
      return;
    }
    this.enterNewsSegment(next);
  }

  private enterNewsSegment(index: number) {
    const news = this.news;
    if (!news) return;
    news.index = index;
    news.time = 0;
    const segment = news.segments[index];
    // 番組の残り時間（AD のカンペに書く）
    const remaining = news.segments.slice(index).reduce((sum, s) => sum + s.seconds, 0);
    this.studio?.setSegment(segment, remaining);
    if (segment.shot === "vtr") this.startReplay(segment.seconds);
    else this.stopReplay();
    news.callbacks.onSegment?.(index);
  }

  /**
   * ゴール前のリプレイ（ニュースの VTR）。直線を正面の超望遠と真横のドリーで等速に見せ、ゴールの前後はゴール線の真横からスローで見せる。
   * 全体が seconds 秒に収まるよう、等速で見せる長さを決める
   */
  private startReplay(seconds: number) {
    const race = this.race;
    if (!race) return;
    const finish = winnerTime(race);
    const slowSeconds = (REPLAY_SLOW_BEFORE + REPLAY_SLOW_AFTER) / REPLAY_SLOW_SCALE;
    // 最後に 0.3 秒ほど余らせて、ゴールを過ぎた所で切り替わるようにする
    const normalSeconds = Math.max(1.5, seconds - slowSeconds - 0.3);
    const slowFrom = finish - REPLAY_SLOW_BEFORE * this.raceRate;
    const from = slowFrom - normalSeconds * this.raceRate;
    this.replay = { slowFrom, savedT: this.raceT, time: 0 };
    this.jumpHorsesTo(race, Math.max(0, from));
    this.timeScale = 1;
    this.setShot("headon", true, true);
  }

  private updateReplay(race: RaceSimulation, realDt: number) {
    const replay = this.replay;
    if (!replay) return realDt;
    replay.time += realDt;
    const slow = this.raceT >= replay.slowFrom;
    // 等速の前半は正面から、後半は真横で並走、ゴールの前後はゴール線の真横からスローで
    if (slow) this.setShot("finish");
    else if (replay.time > 2.4) this.setShot("stretch");
    const dt = realDt * (slow ? REPLAY_SLOW_SCALE : 1);
    const progresses = this.horses.map((_, i) => this.horseProgress(i));
    const order = this.currentOrder(progresses);
    const leaderFraction = Math.min(1, (progresses[order[0]] ?? 0) / race.target);
    this.raceT += dt * this.raceRate;
    this.moveHorses(progresses, order, leaderFraction, dt, realDt);
    return dt;
  }

  /** リプレイをやめて、リプレイ前の位置（ゴール後に流している所）へ戻す */
  private stopReplay() {
    const replay = this.replay;
    if (!replay) return;
    this.replay = null;
    if (this.race) this.jumpHorsesTo(this.race, replay.savedT);
  }

  private update(realDt: number) {
    const race = this.race;
    let dt = realDt;

    if (race && this.replay) {
      dt = this.updateReplay(race, realDt);
    } else if (race && this.running) {
      const target = race.target;
      // 位置順と接戦判定
      const progresses = this.horses.map((_, i) => this.horseProgress(i));
      const order = this.currentOrder(progresses);
      const leader = progresses[order[0]] ?? 0;
      const second = progresses[order[1]] ?? 0;
      const leaderFraction = Math.min(1, leader / target);
      const gapTop2 = leader - second;
      this.slowMotion = !this.winnerCrossed && leaderFraction > 0.93 && gapTop2 < CLOSE_FINISH_GAP;
      // 再生速度は急に変えず、なめらかに寄せる
      const targetScale = this.slowMotion ? SLOW_MOTION_SCALE : 1;
      this.timeScale += (targetScale - this.timeScale) * (1 - Math.exp(-realDt * 5));
      dt = realDt * this.timeScale;
      this.excitement = Math.min(1, Math.max(this.excitement * 0.98, leaderFraction * leaderFraction));

      this.raceT += dt * this.raceRate;
      this.moveHorses(progresses, order, leaderFraction, dt, realDt);

      this.leaderFraction = leaderFraction;
      this.recordCrossings(progresses, target);

      // ゴール判定（勝ち馬はシミュレーション上のゴール時刻ちょうどにゴール線を越える）
      if (!this.winnerCrossed && this.raceT >= winnerTime(race)) {
        this.winnerCrossed = true;
        this.excitement = 1;
        this.callbacks.onWinnerCross?.();
        this.setShot("finish");
        this.finishPhotoPending = true;
      }
      if (this.winnerCrossed) {
        this.postFinishTime += realDt;
        if (this.postFinishTime > FINISH_HOLD_SECONDS && this.shot === "finish") {
          this.setShot("winner");
        }
        // 着順掲示板に切り替わったら掲示板を映し、確定してしばらくしたら勝ち馬に戻す
        if (this.time >= this.resultBoardAt && this.boardShotUntil === Infinity) {
          this.boardShotUntil = Number.MAX_VALUE;
          this.setShot("board");
        }
        if (this.shot === "board" && this.time >= this.boardShotUntil) {
          this.setShot("winner");
        }
        // 確定は全馬がゴールしてから（後ろの馬がまだ走っているうちに結果を出さない）
        const allFinished = this.finishOrder.length >= this.horses.length;
        // 写真判定の間（決勝写真を映している間）は確定しない
        const settled =
          allFinished && this.time - this.lastCrossAt > CONFIRM_AFTER_LAST_SECONDS && this.time >= this.photoUntil;
        if (
          !this.completed &&
          this.postFinishTime > POST_FINISH_SECONDS &&
          (settled || this.postFinishTime > MAX_POST_FINISH_SECONDS)
        ) {
          this.completed = true;
          this.boardShotUntil = this.time + BOARD_HOLD_AFTER_CONFIRM_SECONDS;
          this.environment.vision.setState({ confirmed: true, photo: false, mode: "result" });
          this.callbacks.onComplete?.();
        }
      } else {
        this.chooseRaceShot(leaderFraction);
      }

      this.updateVisionState(order, race);

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
    this.courseProps?.update(this.time);
    this.courseExtras?.update(this.time);
    this.pigeons?.update(dt, this.running ? this.leaderX() : -Infinity);
    this.stepPhysics(dt);
    this.dust.update(dt);
    // 芝の葉はカメラと注視点の間を中心に生やす（手前の地面ほど葉が大きく見える）
    this.environment.update(this.time, this.excitement, (this.camera.position.x + this.lookAt.x) / 2);
    this.environment.vision.update();
    this.updateCamera(realDt);
    this.updateVideoCamera(realDt);
    this.updateBlur();
    // 映画風の画づくりはレースの間だけ強める（レース前の画面はすっきり見せる）
    const cinemaTarget = this.running ? 1 : 0.3;
    this.cinemaAmount += (cinemaTarget - this.cinemaAmount) * (1 - Math.exp(-realDt * 1.5));
    this.cinema.setAmount(this.cinemaAmount);
  }

  /**
   * 物理エンジンを進める。尻尾の付け根と当たり判定を馬に合わせ、旗と尻尾に風をかけてから 1 ステップ解き、描画用の頂点へ写す。
   * スローモーション中は物理もゆっくり進む（dt はスローの時間）
   */
  private stepPhysics(dt: number) {
    if (!this.softWorld || dt <= 0) return;
    this.tailPhysics?.beforeStep(dt, this.time, this.wind);
    this.clothFlags?.beforeStep(dt, this.time);
    this.softWorld.step(dt);
    this.tailPhysics?.afterStep(this.camera);
    this.clothFlags?.afterStep();
  }

  /**
   * ぶれとぼけの設定。ピントは注視点に合わせ、寄りのカットほど背景を大きくぼかす。
   * 馬群の範囲と進んだ分を渡して、カメラが追う馬をぶらさないようにする
   */
  private updateBlur() {
    const n = this.horses.length;
    let meanX = this.prevFieldX;
    if (n > 0) {
      this.fieldMin.set(Infinity, 0.15, Infinity);
      this.fieldMax.set(-Infinity, 4.2, -Infinity);
      let sumX = 0;
      for (const horse of this.horses) {
        const p = horse.root.position;
        sumX += p.x;
        this.fieldMin.x = Math.min(this.fieldMin.x, p.x - 2.3);
        this.fieldMax.x = Math.max(this.fieldMax.x, p.x + 2.3);
        this.fieldMin.z = Math.min(this.fieldMin.z, p.z - 1.2);
        this.fieldMax.z = Math.max(this.fieldMax.z, p.z + 1.2);
      }
      meanX = sumX / n;
    } else {
      this.fieldMin.setScalar(1e9);
      this.fieldMax.setScalar(-1e9);
    }
    this.fieldDelta.set(this.running ? meanX - this.prevFieldX : 0, 0, 0);
    this.prevFieldX = meanX;
    this.blur.setField(this.fieldMin, this.fieldMax, this.fieldDelta);

    const focusDistance = this.camera.position.distanceTo(this.lookAt);
    const closeUp = this.shot === "winner" || this.shot === "gate" || this.shot === "idle" || this.shot === "board";
    // 画面がかすんで見えないよう、ぶれは速く流れる手前の地面や柵に出る程度、ぼけは寄りのカットの遠景に出る程度に抑える
    this.blur.setSettings({
      shutter: this.running ? 0.25 : 0.15,
      focusDistance,
      focusRange: focusDistance * (closeUp ? 0.45 : 1.2),
      maxCoc: this.shot === "board" ? 0.002 : closeUp ? 0.0035 : 0.001,
    });
  }

  /**
   * ゴール線を越えた馬を順に記録する。越えた時刻は前のフレームとの間で補間して、
   * フレームの粗さで着差がぶれないようにする
   */
  private recordCrossings(progresses: number[], target: number) {
    progresses.forEach((progress, i) => {
      if (!Number.isNaN(this.crossTimes[i]) || progress < target) return;
      const before = this.prevProgress[i];
      const ratio = progress > before ? (target - before) / (progress - before) : 1;
      this.crossTimes[i] = this.prevRaceT + (this.raceT - this.prevRaceT) * Math.min(1, Math.max(0, ratio));
      this.finishOrder.push(i);
      this.lastCrossAt = this.time;
      // 上位 5 頭がそろったら、少し間をおいて着順掲示板に切り替える
      if (this.finishOrder.length === Math.min(5, this.horses.length)) {
        // 写真判定の最中なら、決勝写真を映し終えてから
        this.resultBoardAt = Math.max(this.time + RESULT_BOARD_DELAY_SECONDS, this.photoUntil);
      }
    });
    this.prevProgress = progresses;
    this.prevRaceT = this.raceT;
  }

  /**
   * 写真判定。1・2 着が接戦なら、2 着の馬が写真に写りきったところでターフビジョンを決勝写真に切り替え、
   * しばらく映してから着順掲示板（確定）へ進む。写真にはゴールした馬の馬番の札と、1 着の鼻先の判定線を重ねる
   */
  private updatePhotoFinish(photo: boolean) {
    const [first, second] = this.finishOrder;
    if (first === undefined) return;
    const vision = this.environment.vision;
    const shown = this.time >= this.photoShownAt;
    if (!shown) {
      if (!photo || second === undefined) return;
      // 2 着の馬の体（1 馬身）が写真に写りきるまで待つ
      const secondDone = this.photoFinish.xAt(this.crossTimes[second]) * PHOTO_WIDTH + PHOTO_PIXELS_PER_LENGTH;
      const captured = this.photoFinish.done || this.photoFinish.xAt(this.raceT) * PHOTO_WIDTH >= secondDone;
      if (!captured) return;
      this.photoShownAt = this.time;
      this.photoUntil = this.time + PHOTO_HOLD_SECONDS;
      // 着順掲示板は写真判定の後
      this.resultBoardAt = Math.max(this.resultBoardAt, this.photoUntil);
      this.boardShotUntil = Number.MAX_VALUE;
      this.setShot("board");
    }
    const marks = this.finishOrder
      .map((index) => ({ index, x: this.photoFinish.xAt(this.crossTimes[index]) }))
      .filter((mark) => mark.x >= 0 && mark.x <= 1);
    vision.setPhoto(this.photoFinish.texture, marks, this.photoFinish.xAt(this.crossTimes[first]));
  }

  /** 着順・着差・時計・位置順をターフビジョンに渡す */
  private updateVisionState(order: number[], race: RaceSimulation) {
    const labels = this.visionInfo?.labels;
    // ゴール付近の速さ（ワールド単位 / レース内部時刻）で、ゴールの時刻の差を画面上の距離にする
    const unitsPerTime = (FINISH_X - this.startX) / Math.max(0.1, winnerTime(race));
    const lengthsBetween = (ahead: number, behind: number) =>
      ((this.crossTimes[behind] - this.crossTimes[ahead]) * unitsPerTime) / HORSE_LENGTH_UNITS;
    const margins = this.finishOrder
      .slice(1)
      .map((horse, k) => (labels ? marginLabel(lengthsBetween(this.finishOrder[k], horse), labels) : ""));
    const [first, second] = this.finishOrder;
    const photo = second !== undefined && lengthsBetween(first, second) < PHOTO_MARGIN_LENGTHS;
    this.updatePhotoFinish(photo);
    // ゴールした馬は着順のまま、まだ走っている馬は位置順で後ろに並べる
    const finished = new Set(this.finishOrder);
    const liveOrder = [...this.finishOrder, ...order.filter((i) => !finished.has(i))];
    this.environment.vision.setState({
      mode: this.completed || this.time >= this.resultBoardAt ? "result" : this.time >= this.photoShownAt ? "photo" : "live",
      placings: [...this.finishOrder],
      margins,
      finalTime: this.winnerCrossed ? formatRaceTime(this.winnerSeconds) : "",
      clock: formatRaceClock(Math.min(this.raceT, winnerTime(race)) * this.secondsPerUnit),
      liveOrder,
      photo: photo && !this.completed,
      confirmed: this.completed,
    });
  }

  /**
   * 中継映像のカメラ。実際の競馬中継のように、レース前はゲート、道中はスタンドの上から望遠で馬群を横から追い、
   * 直線は正面から、ゴール後は勝ち馬を映す。ショットが切り替わったら補間せずに切り替える
   */
  private updateVideoCamera(dt: number) {
    const camera = this.environment.vision.camera;
    let shot: string;
    let fov: number;
    const winner = this.race && this.winnerCrossed ? this.horses[this.race.winner] : undefined;
    if (!this.running || !this.race) {
      shot = "gate";
      fov = 20;
      this.videoDesiredPos.set(this.startX + 16, 3.5, -12);
      this.videoDesiredLook.set(this.startX, 1.6, 0);
    } else if (winner) {
      shot = "winner";
      fov = 16;
      const p = winner.root.position;
      this.videoDesiredPos.set(p.x + 9, 3, p.z - 11);
      this.videoDesiredLook.set(p.x, 1.6, p.z);
    } else if (this.leaderFraction > 0.8) {
      shot = "stretch";
      fov = 10;
      this.videoDesiredPos.set(FINISH_X + 70, 5, -4);
      this.videoDesiredLook.set(this.focusX, 1.3, 2);
    } else {
      shot = "side";
      fov = 24;
      // スタンドの屋根の前の縁（高さ 15.7 の屋根の少し上）から撮る。屋根より奥（後ろの建物や屋上）から撮ると、
      // スタンドの前を走る間は建物や屋根に隠れる
      this.videoDesiredPos.set(this.focusX - 2, 18, -16);
      this.videoDesiredLook.set(this.focusX + 3, 1.2, 2);
    }
    const cut = shot !== this.videoShot;
    this.videoShot = shot;
    const s = cut ? 1 : 1 - Math.exp(-dt * 4);
    this.videoPos.lerp(this.videoDesiredPos, s);
    this.videoLook.lerp(this.videoDesiredLook, s);
    camera.position.copy(this.videoPos);
    camera.lookAt(this.videoLook);
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  /** ターフビジョンの中継映像を描く。画面が映っていないときと、1 フレームおきの残りは描かない */
  private renderVisionVideo() {
    const vision = this.environment.vision;
    this.frameCount += 1;
    if (this.frameCount % 2 !== 0 || !vision.showsVideo) return;
    this.frustumMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.frustumMatrix);
    if (!vision.isVideoVisible(this.frustum)) return;
    vision.renderVideo(this.renderer, this.scene);
  }

  private chooseRaceShot(fraction: number) {
    if (fraction < 0.12) this.setShot("chase", false);
    else if (fraction < 0.26) this.setShot("side");
    else if (fraction < 0.38) this.setShot("jockey");
    else if (fraction < 0.5) this.setShot("aerial");
    else if (fraction < 0.62) this.setShot("rail");
    else if (fraction < 0.78) this.setShot("headon");
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

  /**
   * ジョッキー視点で乗る馬。先頭の馬は前に何も映らないので除き、2 番手以下からランダムに選ぶ
   * （レースごとに違う騎手の目線になる。1 頭立てならその馬）
   */
  private pickJockeyHorse() {
    const order = this.horses
      .map((horse, i) => ({ i, x: horse.root.position.x }))
      .sort((a, b) => b.x - a.x);
    const chasers = order.slice(1);
    const isSolo = chasers.length === 0;
    if (isSolo) return order[0]?.i ?? 0;
    return chasers[Math.floor(Math.random() * chasers.length)].i;
  }

  private leaderX(): number {
    let best = -Infinity;
    for (const h of this.horses) best = Math.max(best, h.root.position.x);
    return Number.isFinite(best) ? best : this.focusX;
  }

  private computeShot(t: number) {
    const px = this.focusX;
    const sx = this.startX;
    const lx = this.leaderX();
    const winnerIdx = this.race?.winner ?? -1;
    switch (this.shot) {
      case "idle": {
        // クレーン: 高い所からゲートのまわりを回りながら、ゆっくり降りてくる
        const a = t * 0.06 + 0.6;
        const r = 19 - Math.min(t, 10) * 0.6;
        this.desiredPos.set(sx + Math.cos(a) * r + 2, 3.4 + Math.max(0, 9 - t * 1.1), Math.sin(a) * r - 3);
        this.desiredLook.set(sx, 1.5, 0);
        break;
      }
      case "gate":
        // 低い位置からゲートへゆっくり寄る
        this.desiredPos.set(sx + 13 - t * 0.5, 0.9, -4 + t * 0.2);
        this.desiredLook.set(sx, 1.8, 0);
        break;
      case "chase":
        // 地面すれすれの正面から望遠で受ける。飛び出した馬群がこちらへ迫ってくる（近づきすぎたら下がる）
        this.desiredPos.set(Math.max(sx + 36, lx + 14), 0.75, -2.5);
        this.desiredLook.set(Math.max(px, sx + 2), 1.5, 0);
        break;
      case "side":
        // 外ラチの外から望遠の横移動。外周の生垣（高さ 1.6）越しに脚元まで見えるよう、少し高い所から撮る
        this.desiredPos.set(px - 1 + Math.sin(t * 0.35) * 1.5, 4.4, -(TRACK_HALF_WIDTH + 22));
        this.desiredLook.set(px + 2.5, 1.3, 0);
        break;
      case "jockey": {
        const rider = this.horses[this.jockeyHorse];
        if (rider) rider.root.updateMatrixWorld(true);
        if (rider) rider.jockeyView(this.desiredPos, this.desiredLook);
        break;
      }
      case "aerial":
        // ドローン: 馬群の後ろの高い所から、馬群を追い越しながら降りてくる（内馬場側からスタンドを背景に）
        this.desiredPos.set(px - 20 + t * 3.2, Math.max(6, 17 - t * 1.4), TRACK_HALF_WIDTH + 12 - t * 0.8);
        this.desiredLook.set(px + 5, 0.9, -2);
        break;
      case "rail":
        // 内ラチ沿いの蹄の高さに置いたカメラ。目の前を馬群が駆け抜け、通り過ぎたら首を振って見送る
        this.desiredPos.set(this.railCameraX, 0.55, TRACK_HALF_WIDTH - 0.7);
        this.desiredLook.set(Math.min(lx + 1, this.railCameraX + 14), 1.3, 1);
        break;
      case "headon":
        // 超望遠の正面。遠近が詰まり、馬群が団子になって迫ってくる
        this.desiredPos.set(lx + 34 - Math.min(t, 5) * 1.2, 2.4, 2.5);
        this.desiredLook.set(px, 1.4, 0);
        break;
      case "stretch": {
        // 真横のドリー: 先頭の馬に並走しながら少しずつ前へ出る
        const leader = this.horses.reduce<HorseModel | null>(
          (best, horse) => (!best || horse.root.position.x > best.root.position.x ? horse : best),
          null
        );
        const lz = leader ? leader.root.position.z : 0;
        this.desiredPos.set(lx + 1.5 + Math.min(t, 6) * 0.35, 1.9, -(TRACK_HALF_WIDTH + 5.5));
        this.desiredLook.set(lx - 0.5, 1.5, lz);
        break;
      }
      case "finish":
        // 写真判定カメラ（スタンド前からゴール線を真横に。奥に内ラチ側のゴール板）
        this.desiredPos.set(FINISH_X + 0.15, 2.2, -(TRACK_HALF_WIDTH + 6));
        this.desiredLook.set(FINISH_X, 1.2, 0);
        break;
      case "board": {
        // 電光掲示板の結果を正面から。掲示板（幅 38）が画面の幅に収まる距離を、画角と縦横比から求める。
        // 広い画面では右側に結果パネルが出るので掲示板を左寄りに置き、狭い画面（パネルが下に出る）では中央に置く
        const wide = this.container.clientWidth >= 700;
        // 寄っていくにつれて画面に占める割合が増える（最後に start + 0.08）
        const fill = (wide ? 0.55 : 0.8) + 0.02 * Math.min(t, 4);
        // 画角はこのカットの最終的な画角で求める（切り替わりの途中の画角で求めると、狙いの距離が揺れる）
        const halfTan = Math.tan(THREE.MathUtils.degToRad(this.styleFov("board") / 2));
        const viewWidth = 38 / fill;
        // 正方形に近い画面（全画面など）では、掲示板の幅を収める距離がスタンドの中まで届いてしまう。
        // 客席に入ると手前に観客が重なるので、スタンドの前（エプロン）より後ろへは下がらない（掲示板の端が少し切れてもよい）
        const distance = Math.min(viewWidth / (2 * halfTan * this.camera.aspect), BOARD_CENTER.z + TRACK_HALF_WIDTH + 7);
        // スタンド側から +Z を向くと画面の右は -X。注視点を -X 側にずらすと掲示板が左に寄る（左端から画面幅の 3% あける）
        const shift = wide ? (0.5 - 0.03 - fill / 2) * viewWidth : 0;
        this.desiredPos.set(BOARD_CENTER.x - shift, BOARD_CENTER.y - 2, BOARD_CENTER.z - distance);
        this.desiredLook.set(BOARD_CENTER.x - shift, BOARD_CENTER.y - 0.6, BOARD_CENTER.z);
        break;
      }
      case "winner": {
        // 勝ち馬のまわりを低い位置からゆっくり回る（望遠で背景をぼかし、主役を浮かび上がらせる）
        const w = this.horses[winnerIdx];
        const wx = w ? w.root.position.x : px;
        const wz = w ? w.root.position.z : 0;
        const a = -1.2 + t * 0.22;
        this.desiredPos.set(wx + Math.cos(a) * 9, 1.6, wz + Math.sin(a) * 9);
        // 結果パネル（右側）に被らないよう、勝ち馬を画面の左寄りに置く
        this.desiredLook.set(wx + Math.sin(a) * 2.2, 1.8, wz - Math.cos(a) * 2.2);
        break;
      }
    }
  }

  /** カットの画角。縦長の画面では横が狭くなるので広げる */
  private styleFov(shot: Shot) {
    const narrow = this.camera.aspect < 1.2;
    const fov = SHOT_STYLES[shot].fov;
    return narrow ? Math.min(70, fov * 1.35) : fov;
  }

  /**
   * 手持ちカメラの揺れ。いくつかの周期の波を重ねて、規則的に見えないようにする
   * @param amount 揺れの大きさ（ワールド単位）
   */
  private handheld(amount: number, out: THREE.Vector3) {
    const t = this.time;
    return out.set(
      (Math.sin(t * 1.3) + 0.5 * Math.sin(t * 3.7 + 1.1)) * amount,
      (Math.sin(t * 1.7 + 2.3) + 0.4 * Math.sin(t * 4.3)) * amount * 0.7,
      (Math.sin(t * 1.1 + 4.1) + 0.5 * Math.sin(t * 2.9 + 0.3)) * amount
    );
  }

  private updateCamera(dt: number) {
    this.shotTime += dt;
    this.computeShot(this.shotTime);
    const style = SHOT_STYLES[this.shot];
    // 狙いが動く速さ（馬群を追うカットでは毎秒 16 単位ほど）。急に飛んだときは速さとみなさない
    const targetVelocity = (current: THREE.Vector3, previous: THREE.Vector3, out: THREE.Vector3) => {
      out.subVectors(current, previous).divideScalar(Math.max(dt, 1e-3));
      if (out.length() > 40) out.set(0, 0, 0);
      previous.copy(current);
      return out;
    };
    targetVelocity(this.desiredPos, this.prevDesiredPos, this.desiredPosVelocity);
    targetVelocity(this.desiredLook, this.prevDesiredLook, this.desiredLookVelocity);
    if (this.shot === "jockey") {
      // 騎手の目にそのまま付ける。なめらかに追いかけると、ギャロップの揺れが消えてしまう
      this.cameraBase.copy(this.desiredPos);
      this.lookAt.copy(this.desiredLook);
      this.cameraVelocity.set(0, 0, 0);
      this.lookVelocity.set(0, 0, 0);
      // すぐ隣の馬のラベルは目の前で大きくなりすぎるので、少し離れた馬のラベルだけ出す
      this.horses.forEach((horse, i) => {
        const isNear = horse.root.position.distanceTo(this.camera.position) < 10;
        horse.label.visible = i !== this.jockeyHorse && !isNear;
      });
    } else {
      // 臨界減衰のバネで追う（行き過ぎず、動き出しと止まりがなめらか）。
      // 狙いの動く速さも合わせて追うので、一定の速さで走る馬群には遅れずに付いていく（速さを合わせないと 2 × 速さ ÷ ω だけ遅れる）
      const omega = style.follow;
      const step = (
        current: THREE.Vector3,
        target: THREE.Vector3,
        velocity: THREE.Vector3,
        targetVel: THREE.Vector3
      ) => {
        const ax = (target.x - current.x) * omega * omega + 2 * omega * (targetVel.x - velocity.x);
        const ay = (target.y - current.y) * omega * omega + 2 * omega * (targetVel.y - velocity.y);
        const az = (target.z - current.z) * omega * omega + 2 * omega * (targetVel.z - velocity.z);
        velocity.x += ax * dt;
        velocity.y += ay * dt;
        velocity.z += az * dt;
        current.addScaledVector(velocity, dt);
      };
      step(this.cameraBase, this.desiredPos, this.cameraVelocity, this.desiredPosVelocity);
      step(this.lookAt, this.desiredLook, this.lookVelocity, this.desiredLookVelocity);
      // カメラのすぐそばを通る馬のラベルは大きくなりすぎるので隠す。勝ち馬のアップは勝ち馬のラベルだけ、寄りすぎたら隠す
      // （掲示板のカットは setShot で決めた表示のまま）
      if (this.shot !== "board") {
        const winner = this.race?.winner ?? -1;
        this.horses.forEach((horse, i) => {
          const isNear = horse.root.position.distanceTo(this.cameraBase) < (this.shot === "winner" ? 11 : 8);
          horse.label.visible = !isNear && (this.shot !== "winner" || i === winner);
        });
      }
    }
    // 画角と傾きは撮り方へなめらかに寄せる
    const fov = this.shot === "jockey" ? JOCKEY_FOV : this.styleFov(this.shot);
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov += (fov - this.camera.fov) * (1 - Math.exp(-dt * 3));
      this.camera.updateProjectionMatrix();
    }
    this.cameraRoll += (style.roll - this.cameraRoll) * (1 - Math.exp(-dt * 2));
    // 見えるカメラは、バネで動かした位置に手持ちの揺れを足した所
    this.camera.position.copy(this.cameraBase).add(this.handheld(style.shake, this.shakeOffset));
    this.camera.lookAt(this.lookAt);
    this.camera.rotateZ(this.cameraRoll);

    // 影はカメラの注視点付近だけ高解像度で落とす
    const dir = this.sun.userData.dir as THREE.Vector3;
    this.sun.target.position.set(this.lookAt.x, 0, this.lookAt.z * 0.3);
    this.sun.position.copy(this.sun.target.position).addScaledVector(dir, 120);
  }
}
