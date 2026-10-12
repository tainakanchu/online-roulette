import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { NewsSegment, NewsShot } from "../../../utils/raceNews";
import { loadModel, takeNode, type ModelPart } from "./models";
import { NewsAnchor, type AnchorRole } from "./newsAnchors";
import { NewsCrew } from "./newsCrew";
import { addDetail, addFloorReflection, PlanarReflection } from "./newsMaterials";
import {
  createCityNightBackdrop,
  createFloorMonitorScreen,
  createProgramLogo,
  createSideScreenBackground,
  createVideoWallBackground,
} from "./newsGraphicsTextures";
import {
  createDeskStoneDetail,
  createHairStrandDetail,
  createHinokiGrain,
  createSkinDetail,
  createStudioFloorDetail,
  createWoolTwillDetail,
} from "./newsMaterialTextures";
import { NewsScreens, type NewsWallInfo } from "./newsScreens";

// レースの後に流すニュース番組のスタジオ。競馬場とは別のシーン（単位はメートル）で、同じレンダラーで描く。
// セット（news-studio.glb）とキャスター（news-anchors.glb）は Blender で作り、材質・照明・カメラワーク・画面の中身はここで付ける。

export type NewsModels = [studio: GLTF, anchors: GLTF, crew: GLTF | null];

/** スタジオのモデルを読み込む（レースが始まったら先に読み始めておく）。AD は読めなくてもニュースは流す */
export const loadNewsModels = (): Promise<NewsModels> =>
  Promise.all([
    loadModel("news-studio.glb"),
    loadModel("news-anchors.glb"),
    loadModel("news-ad.glb").catch((error) => {
      console.warn("Failed to load news crew", error);
      return null;
    }),
  ]);

/** ステージ（円形の床）の上面の高さ */
const STAGE_TOP = 0.08;
/** キャスターの席（main は画面の左、sub は右） */
const SEAT_X: Record<AnchorRole, number> = { main: -0.85, sub: 0.85 };
/**
 * AD の立ち位置。左と正面のスタジオカメラ（x = -1.6, 0）の間で、キャスターの方を向く。
 * 番組の頭のクレーン（右の高い所から降りる）では画面の左に小さく映り、手前に大きく入り込まない
 */
const CREW_POSITION = new THREE.Vector3(-0.75, 0, 4.3);

interface CameraPose {
  position: THREE.Vector3;
  target: THREE.Vector3;
  /** 縦の画角（度） */
  fov: number;
}

const pose = (position: [number, number, number], target: [number, number, number], fov: number): CameraPose => ({
  position: new THREE.Vector3(...position),
  target: new THREE.Vector3(...target),
  fov,
});

const lerpPose = (a: CameraPose, b: CameraPose, t: number, out: CameraPose) => {
  out.position.lerpVectors(a.position, b.position, t);
  out.target.lerpVectors(a.target, b.target, t);
  out.fov = THREE.MathUtils.lerp(a.fov, b.fov, t);
  return out;
};

const easeInOut = (t: number) => {
  const x = THREE.MathUtils.clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

/**
 * カットごとのカメラ。スタジオカメラ（ペデスタル）の前から望遠で撮る。カットの間はゆっくり寄る・引く。
 * [始まり, 終わり, 動きにかける秒数]
 */
const SHOTS: Record<Exclude<NewsShot, "vtr">, [CameraPose, CameraPose, number]> = {
  // 番組の頭: クレーンで高い所から降りてくる
  opening: [pose([5.6, 3.9, 8.4], [0, 1.3, -1.2], 44), pose([3.3, 2.2, 5.6], [0, 1.15, -0.6], 34), 3],
  // メインキャスターを画面の左 1/3 に置き、右の空いた所に肩のパネル（HTML）を出す
  mainSingle: [pose([-1.08, 1.36, 3.95], [-0.6, 1.2, -0.55], 12.5), pose([-1.06, 1.35, 3.75], [-0.6, 1.2, -0.55], 12), 6],
  subSingle: [pose([1.08, 1.3, 3.95], [0.6, 1.14, -0.55], 12.5), pose([1.06, 1.29, 3.75], [0.6, 1.14, -0.55], 12), 6],
  // 2 人の頭が画面の上 1/3 に来るよう、少し上から
  twoShot: [pose([0, 1.5, 4.5], [0, 1.18, -0.6], 24), pose([0, 1.48, 4.2], [0, 1.18, -0.6], 23), 5],
  sideTwoShot: [pose([3.0, 1.6, 3.6], [-0.2, 1.2, -1], 30), pose([2.8, 1.55, 3.4], [-0.2, 1.2, -1], 29), 5],
  // 背後の大型ビジョンを正面から（下の縁に 2 人の頭が少し入る）
  wall: [pose([0, 2.1, 2.7], [0, 2.1, -3.2], 33), pose([0, 2.12, 2.3], [0, 2.12, -3.2], 31), 6],
  // 切り替えの手違い: メインキャスターの左後ろから、スタジオカメラとカンペを掲げる AD を撮ってしまう（慌ててズームする）
  blooper: [pose([-1.9, 1.72, -1.25], [-0.5, 1.2, 4.3], 30), pose([-1.86, 1.7, -1.2], [-0.7, 1.3, 4.3], 19), 2.3],
  // 番組の終わり: ツーショットから引いて、スタジオ全体へ
  closing: [pose([0, 1.48, 4.2], [0, 1.18, -0.6], 23), pose([5.4, 3.7, 8.2], [0, 1.2, -1.0], 44), 5],
};

/** 画面ごとのノード名 */
const SCREEN_NODES = new Set(["VideoWallScreen", "SideScreenL", "SideScreenR", "FloorMonitorL", "FloorMonitorR", "TabletScreen"]);

export class NewsStudio {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.05, 60);
  private readonly composer: EffectComposer;
  private readonly bloom: UnrealBloomPass;
  private readonly reflection = new PlanarReflection(STAGE_TOP);
  private readonly anchors: Record<AnchorRole, NewsAnchor>;
  private readonly screens: NewsScreens;
  private readonly crew: NewsCrew | null;
  private info: NewsWallInfo | null = null;
  /** カットの始まりの時点の、番組の残り時間（秒） */
  private remainingAtStart = 0;
  private readonly floors: THREE.Object3D[] = [];
  private readonly materials = new Map<string, THREE.Material>();
  private readonly disposables: Array<{ dispose: () => void }> = [];
  private readonly environment: THREE.Texture;
  private readonly pose = pose([0, 0, 0], [0, 0, 0], 30);
  private segment: NewsSegment | null = null;
  private segmentTime = 0;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    [studio, anchors, crew]: NewsModels
  ) {
    this.scene.background = new THREE.Color("#04060b");
    // 磨いた天板・艶のある床・ガラスに映る、スタジオらしい明るい部屋の環境光
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environment = this.environment;
    this.scene.environmentIntensity = 0.35;

    const city = this.track(createCityNightBackdrop());
    const art = {
      wall: this.track(createVideoWallBackground()).image as CanvasImageSource,
      logo: this.track(createProgramLogo()).image as CanvasImageSource,
      side: this.track(createSideScreenBackground()).image as CanvasImageSource,
      floor: this.track(createFloorMonitorScreen()).image as CanvasImageSource,
    };
    this.screens = new NewsScreens(art);
    this.disposables.push(this.screens);

    this.buildSet(studio, city);
    this.anchors = {
      main: new NewsAnchor(anchors, "main", (part) => this.material(part)),
      sub: new NewsAnchor(anchors, "sub", (part) => this.material(part)),
    };
    this.scene.add(this.anchors.main.group, this.anchors.sub.group);
    this.crew = crew ? new NewsCrew(crew, (part) => this.material(part)) : null;
    if (this.crew) {
      this.crew.group.position.copy(CREW_POSITION);
      // モデルは +Z を向いているので、キャスター（-Z）の方へ回す
      this.crew.group.rotation.y = Math.PI;
      this.scene.add(this.crew.group);
    }
    this.addLights();

    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // 光のライン・照明のレンズ・ハローだけがにじむ程度に（明るさ 1 を超える所だけ。画面全体が霞まないよう弱めに）
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.22, 0.4, 1.0);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  /** 大型ビジョンに出す写真・結果 */
  setInfo(info: NewsWallInfo) {
    this.info = info;
    this.screens.setInfo(info);
  }

  /**
   * カットを切り替える。話す人・顔の向き・ビジョンの中身もカットに合わせる
   * @param remaining 番組の残り時間（このカットを含む。AD のカンペに書く）
   */
  setSegment(segment: NewsSegment, remaining: number) {
    this.segment = segment;
    this.segmentTime = 0;
    this.remainingAtStart = remaining;
    this.screens.setMode(segment.wall);
    const { main, sub } = this.anchors;
    main.setSpeaking(segment.speaker === "main" && segment.shot !== "vtr");
    sub.setSpeaking(segment.speaker === "sub" && segment.shot !== "vtr");
    // ひとことの場面は 2 人で顔を見合わせる。それ以外は正面のカメラを見る（聞いている人は少し相手の方へ）
    const isTalk = segment.id === "comment";
    main.setLook(isTalk ? 0.32 : segment.speaker === "sub" ? 0.12 : 0);
    sub.setLook(isTalk ? -0.42 : segment.speaker === "main" ? -0.12 : 0);
    this.updateCamera(0);
  }

  update(dt: number) {
    const before = this.segmentTime;
    this.segmentTime += dt;
    // 締めの言葉を言い終えたところで 2 人そろってお辞儀
    const bowAt = 1.9;
    const isBowTime = this.segment?.id === "closing" && before < bowAt && this.segmentTime >= bowAt;
    if (isBowTime) {
      this.anchors.main.bow();
      this.anchors.sub.bow();
    }
    this.anchors.main.update(dt);
    this.anchors.sub.update(dt);
    if (this.crew && this.info) {
      this.crew.setCard(this.info.cueCard(Math.max(0, this.remainingAtStart - this.segmentTime)));
      this.crew.update(dt);
    }
    this.updateCamera(this.segmentTime);
  }

  render() {
    this.scene.updateMatrixWorld();
    this.reflection.render(this.renderer, this.scene, this.camera, this.floors);
    this.composer.render();
  }

  setSize(width: number, height: number) {
    this.composer.setSize(width, height);
    this.bloom.resolution.set(width / 2, height / 2);
    this.reflection.setSize(width * this.renderer.getPixelRatio(), height * this.renderer.getPixelRatio());
    this.camera.aspect = width / height;
    this.updateCamera(this.segmentTime);
  }

  dispose() {
    this.anchors.main.dispose();
    this.anchors.sub.dispose();
    this.crew?.dispose();
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
    this.materials.forEach((material) => material.dispose());
    this.disposables.forEach((item) => item.dispose());
    this.reflection.dispose();
    this.environment.dispose();
    this.composer.dispose();
  }

  // ----- 内部 -----

  private track<T extends { dispose: () => void }>(item: T): T {
    this.disposables.push(item);
    return item;
  }

  private updateCamera(t: number) {
    const shot = this.segment?.shot ?? "opening";
    if (shot === "vtr") return;
    const [from, to, seconds] = SHOTS[shot];
    lerpPose(from, to, easeInOut(t / seconds), this.pose);
    // 縦長の画面では横が狭くなるので、画角を広げて 2 人が収まるようにする
    const narrow = this.camera.aspect < 1.2;
    this.camera.fov = narrow ? Math.min(70, this.pose.fov * 1.7) : this.pose.fov;
    this.camera.position.copy(this.pose.position);
    this.camera.lookAt(this.pose.target);
    this.camera.updateProjectionMatrix();
  }

  /** セットのノードを並べる。画面は画面ごとのテクスチャ、それ以外はマテリアル名で材質を決める */
  private buildSet(gltf: GLTF, city: THREE.Texture) {
    const screenTexture: Record<string, THREE.Texture> = {
      VideoWallScreen: this.screens.wall,
      SideScreenL: this.screens.side,
      SideScreenR: this.screens.side,
      FloorMonitorL: this.screens.floor,
      FloorMonitorR: this.screens.floor,
      TabletScreen: this.screens.floor,
    };
    for (const child of [...gltf.scene.children]) {
      const node = takeNode(gltf, child.name);
      if (!node) continue;
      const group = new THREE.Group();
      group.name = child.name;
      group.position.copy(node.origin);
      for (const part of node.parts) {
        let material: THREE.Material;
        if (SCREEN_NODES.has(child.name)) {
          material = this.screenMaterial(child.name, screenTexture[child.name]);
        } else if (part.materialName === "CityBackdrop") {
          material = this.cached("CityBackdrop", () => {
            const m = new THREE.MeshBasicMaterial({ map: city });
            // 窓の外の夜景は自分で光っている（照明に左右されない）
            m.color.setScalar(1.15);
            return m;
          });
        } else if (part.materialName === "DeskLogo" || child.name === "DeskLogo") {
          material = this.cached("DeskLogo", () => {
            const m = new THREE.MeshBasicMaterial({ map: this.screens.logo });
            m.color.setScalar(1.4);
            return m;
          });
        } else {
          material = this.material(part);
        }
        const mesh = new THREE.Mesh(part.geometry, material);
        const isFloor = part.materialName === "StageFloor" || part.materialName === "StudioFloor";
        mesh.receiveShadow = true;
        mesh.castShadow = !isFloor && !(material instanceof THREE.MeshBasicMaterial);
        if (isFloor) this.floors.push(mesh);
        group.add(mesh);
      }
      this.scene.add(group);
    }
  }

  private cached(name: string, create: () => THREE.Material) {
    let material = this.materials.get(name);
    if (!material) {
      material = create();
      this.materials.set(name, material);
    }
    return material;
  }

  private screenMaterial(node: string, texture: THREE.Texture) {
    return this.cached(`screen:${node}`, () => {
      const m = new THREE.MeshBasicMaterial({ map: texture });
      // LED の画面はまわりより明るい（トーンマップで沈まないよう 1 より大きく）
      m.color.setScalar(node === "VideoWallScreen" ? 1.2 : 1.1);
      return m;
    });
  }

  /** Blender のマテリアル名から材質を決める（同じ名前は共有） */
  private material(part: ModelPart): THREE.Material {
    const name = part.materialName;
    return this.cached(name, () => this.createMaterial(name, part.color));
  }

  private createMaterial(name: string, color: THREE.Color): THREE.Material {
    const glow = (hex: string, intensity: number) => {
      const m = new THREE.MeshBasicMaterial({ color: hex });
      m.color.multiplyScalar(intensity);
      return m;
    };
    const physical = (params: THREE.MeshPhysicalMaterialParameters) => new THREE.MeshPhysicalMaterial({ color, ...params });
    const detail = this.detailTextures();
    switch (name) {
      // ----- 床 -----
      case "StageFloor":
      case "StudioFloor":
        return addFloorReflection(
          addDetail(physical({ roughness: 0.2, clearcoat: 0.4, clearcoatRoughness: 0.12, envMapIntensity: 0.25 }), {
            texture: detail.floor,
            period: 1.6,
            space: "world",
            color: `diffuseColor.rgb *= 0.78 + 0.44 * detail.r;
              diffuseColor.rgb += vec3(0.05, 0.06, 0.08) * smoothstep(0.75, 1.0, detail.g);`,
            roughness: `roughnessFactor = clamp(roughnessFactor * (0.55 + detail.b * 1.3), 0.04, 1.0);`,
            bump: 0.003,
          }),
          this.reflection,
          name === "StageFloor" ? 0.6 : 0.45
        );
      // ----- デスク -----
      case "DeskTop":
        return addDetail(physical({ roughness: 0.16, clearcoat: 0.8, clearcoatRoughness: 0.06 }), {
          texture: detail.stone,
          period: 0.8,
          space: "world",
          color: `diffuseColor.rgb *= mix(1.0, 0.84, smoothstep(0.56, 0.86, detail.r)) * (0.97 + 0.06 * detail.g);`,
          roughness: `roughnessFactor = clamp(roughnessFactor + (detail.b - 0.2) * 0.2, 0.05, 1.0);`,
          bump: 0.0008,
        });
      case "DeskWood":
      case "Hinoki":
        // 腰板は横に張った板（木目は横向き）、縦格子は縦の角材（木目は縦向き）
        return addDetail(physical({ roughness: 0.55, sheen: 0.2, sheenColor: new THREE.Color("#ffe2b8") }), {
          texture: detail.wood,
          period: 0.5,
          space: "world",
          swizzle: name === "DeskWood" ? "yxz" : "xyz",
          color: `diffuseColor.rgb *= 0.8 + 0.36 * detail.r;
            diffuseColor.rgb *= 1.0 - 0.1 * detail.g;
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.72, 0.6, 0.48), detail.b);`,
          roughness: `roughnessFactor *= 0.85 + 0.3 * detail.g;`,
          bump: 0.0015,
        });
      case "DeskNavy":
      case "ScreenFrame":
      case "Mullion":
        return physical({ roughness: 0.32, metalness: 0.45, clearcoat: 0.5, clearcoatRoughness: 0.2 });
      case "WhiteFrame":
      case "Pot":
        return physical({ roughness: 0.4 });
      // ----- 光るもの（ブルームでにじむよう明るく） -----
      case "NeonLine":
        return glow("#a8dcff", 3.2);
      case "StageRim":
        return glow("#86c8ff", 3);
      case "Halo":
        return glow("#f4f8ff", 4);
      case "LightLens":
        return glow("#fff0d6", 6);
      case "SoftPanel":
        return glow("#f6f8ff", 2.6);
      // ----- 窓 -----
      case "Glass":
        return physical({
          color: "#9fb7d4",
          roughness: 0.04,
          transparent: true,
          opacity: 0.12,
          depthWrite: false,
          envMapIntensity: 1.2,
        });
      case "Prompter":
        return physical({ color: "#1b2330", roughness: 0.05, transparent: true, opacity: 0.7, envMapIntensity: 1.5 });
      // ----- 植栽 -----
      case "Moss":
        return addDetail(physical({ roughness: 0.95, sheen: 0.6, sheenColor: new THREE.Color("#a6c46a") }), {
          texture: detail.skin,
          period: 0.06,
          space: "world",
          color: `diffuseColor.rgb *= 0.7 + 0.6 * detail.g;`,
          bump: 0.004,
        });
      case "Leaf":
        return physical({ roughness: 0.6, side: THREE.DoubleSide });
      // ----- 機材・椅子・小物 -----
      case "Truss":
      case "LightBody":
      case "CameraBody":
      case "Tablet":
        return physical({ roughness: 0.45, metalness: 0.35 });
      case "Ceiling":
        return new THREE.MeshBasicMaterial({ color: "#020305" });
      case "ChairLeather":
      case "Shoes":
        return addDetail(physical({ roughness: 0.42, clearcoat: 0.3, clearcoatRoughness: 0.4 }), {
          texture: detail.skin,
          period: 0.03,
          space: "object",
          roughness: `roughnessFactor = clamp(roughnessFactor + (0.5 - detail.g) * 0.4, 0.2, 0.8);`,
          bump: 0.002,
        });
      case "StaffShirt":
      case "StaffPants":
        return addDetail(physical({ roughness: 0.85, sheen: 0.4, sheenColor: color.clone().lerp(new THREE.Color("#ffffff"), 0.3) }), {
          texture: detail.wool,
          period: 0.04,
          space: "object",
          color: `diffuseColor.rgb *= 0.9 + 0.2 * detail.r;`,
          bump: 0.0008,
        });
      case "Sneakers":
      case "Headset":
      case "Radio":
      case "Lanyard":
      case "PassCard":
      case "CueCover":
        return physical({ roughness: 0.6 });
      case "Tape":
        return physical({ roughness: 0.75, sheen: 0.3 });
      case "CuePaper":
        return physical({ roughness: 0.9 });
      case "CueSpiral":
      case "ChairMetal":
      case "Watch":
        return physical({ roughness: 0.15, metalness: 1 });
      case "Paper":
        return physical({ roughness: 0.85, side: THREE.DoubleSide });
      // ----- キャスター -----
      case "Skin":
        return addDetail(physical({ roughness: 0.55, sheen: 0.25, sheenColor: new THREE.Color("#ffc6a8"), sheenRoughness: 0.6 }), {
          texture: detail.skin,
          period: 0.04,
          space: "object",
          color: `diffuseColor.rgb *= 0.95 + 0.1 * detail.r;`,
          roughness: `roughnessFactor = clamp(roughnessFactor + (detail.b - 0.5) * 0.2 + (0.5 - detail.g) * 0.3, 0.3, 0.9);`,
          bump: 0.0012,
        });
      case "Hair":
      case "HairM":
      case "HairF":
      case "Brow":
        // 毛束の筋は控えめに（強いと頭の上で毛の断面が編み目のように見える）。艶は髪の色のまま弱く（青い逆光で色が浮かないように）
        return addDetail(physical({ roughness: 0.45, sheen: 0.3, sheenColor: color.clone().multiplyScalar(2), sheenRoughness: 0.4 }), {
          texture: detail.hair,
          period: 0.08,
          space: "object",
          color: `diffuseColor.rgb *= (0.85 + 0.25 * detail.r) * (0.82 + 0.18 * detail.g);`,
          roughness: `roughnessFactor = clamp(roughnessFactor + (detail.b - 0.5) * 0.15, 0.25, 0.8);`,
          bump: 0.0008,
        });
      case "EyeWhite":
      case "Iris":
      case "Pupil":
        // 目は濡れているので、照明の映り込み（キャッチライト）が出るように艶を強く
        return physical({ roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.03 });
      case "Lips":
        return physical({ roughness: 0.4, clearcoat: 0.3, clearcoatRoughness: 0.3 });
      case "MouthInner":
        return physical({ roughness: 0.7 });
      case "Teeth":
        return physical({ roughness: 0.3 });
      case "SuitM":
      case "JacketF":
      case "SkirtF":
        // 艶（sheen）は布の縁がわずかに光る程度に。強いと紺のスーツが灰色に見える
        return addDetail(physical({ roughness: 0.8, sheen: 0.12, sheenColor: color.clone().lerp(new THREE.Color("#ffffff"), 0.2) }), {
          texture: detail.wool,
          period: 0.05,
          space: "object",
          color: `diffuseColor.rgb *= (0.84 + 0.28 * detail.r) * (0.94 + 0.12 * detail.b);`,
          roughness: `roughnessFactor = clamp(roughnessFactor + (detail.g - 0.5) * 0.2, 0.5, 1.0);`,
          bump: 0.001,
        });
      case "Shirt":
      case "Blouse":
      case "Tie":
        return addDetail(physical({ roughness: name === "Tie" ? 0.38 : 0.62, sheen: 0.5, sheenColor: new THREE.Color("#ffffff") }), {
          texture: detail.wool,
          period: name === "Tie" ? 0.02 : 0.03,
          space: "object",
          color: `diffuseColor.rgb *= 0.95 + 0.1 * detail.r;`,
          bump: 0.0006,
        });
      default:
        return physical({ roughness: 0.6 });
    }
  }

  private detailCache: Record<string, THREE.Data3DTexture> | null = null;

  /** 質感の 3D テクスチャ（最初に要ったときに 1 回だけ作る） */
  private detailTextures() {
    if (!this.detailCache) {
      this.detailCache = {
        floor: this.track(createStudioFloorDetail()),
        stone: this.track(createDeskStoneDetail()),
        wood: this.track(createHinokiGrain()),
        wool: this.track(createWoolTwillDetail()),
        hair: this.track(createHairStrandDetail()),
        skin: this.track(createSkinDetail()),
      };
    }
    return this.detailCache as Record<"floor" | "stone" | "wood" | "wool" | "hair" | "skin", THREE.Data3DTexture>;
  }

  /**
   * スタジオの照明。キャスターそれぞれに正面上からのキーライト（影あり）、カメラ側からの柔らかいフィル、
   * 後ろ上からの逆光（髪と肩の輪郭を光らせる）、背後の LED ビジョンからの青い照り返し。
   * Why not: フィルと照り返しを面光源（RectAreaLight）にすると柔らかいが、計算に使う表（約 300KB）を読み込むことになるので、
   * 向きを持つ光と広く柔らかいスポットで代える
   */
  private addLights() {
    this.scene.add(new THREE.HemisphereLight("#9fb4d6", "#0b1220", 0.35));
    for (const role of ["main", "sub"] as const) {
      const x = SEAT_X[role];
      const key = new THREE.SpotLight("#fff2e2", 48, 14, THREE.MathUtils.degToRad(22), 0.6, 2);
      key.position.set(x + Math.sign(x) * 0.8, 4.4, 4.2);
      key.target.position.set(x, 1.15, -0.55);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.bias = -0.0002;
      key.shadow.normalBias = 0.02;
      this.scene.add(key, key.target);

      const rim = new THREE.SpotLight("#dfe9ff", 40, 10, THREE.MathUtils.degToRad(26), 0.7, 2);
      rim.position.set(x - Math.sign(x) * 1.2, 4.3, -3.0);
      rim.target.position.set(x, 1.3, -0.5);
      this.scene.add(rim, rim.target);
    }
    // カメラ側からのフィル（顔の影を浅くする）
    const fill = new THREE.DirectionalLight("#f3f6ff", 0.55);
    fill.position.set(0, 2.2, 4.6);
    fill.target.position.set(0, 1.2, -0.5);
    this.scene.add(fill, fill.target);
    // LED ビジョンの照り返し（背中と髪の後ろがうっすら青くなる）
    const spill = new THREE.SpotLight("#4f86ff", 7, 9, THREE.MathUtils.degToRad(70), 1, 2);
    spill.position.set(0, 2.15 + STAGE_TOP, -3.0);
    spill.target.position.set(0, 1.2, 0);
    this.scene.add(spill, spill.target);
  }
}
