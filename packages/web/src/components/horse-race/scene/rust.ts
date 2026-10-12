import * as THREE from "three";
import { getNoise3D, NOISE3D_GLSL } from "./noise3d";

// 競馬場の金属・塗装（柵/ラチ、スタートゲート等）向けの手続き型錆びシェーダーマテリアル。
//
// 設計方針と実装理由（How / Why not）:
// 1. 3D テクスチャによるソリッドテクスチャサンプリング:
//    - How: ワールド座標 (vRustWorld) で直接 3D ノイズ（sampler3D / noise3）を引く。
//      重力方向（-y）に伸びる雨水由来の錆の垂れ筋（streak）は、y 軸方向のサンプリング座標を
//      水平方向よりも引き伸ばす（y スケールを小さくする）ことで表現する。
//    - Why not: 従来のトライプラナー投影（X/Y/Z 各面で 2D ノイズを評価して法線でブレンド）は
//      テクスチャ参照やノイズ評価回数が 3 倍になり重かったが、3D テクスチャであれば
//      1 回のサンプリングで継ぎ目なく 3 次元のソリッドテクスチャが得られ、計算コストも大幅に削減できるため。
// 2. InstancedMesh 対応:
//    - How: 頂点シェーダーで #ifdef USE_INSTANCING を用い、instanceMatrix を乗算して各個体のワールド座標を求める。
//    - Why not: Three.js 標準の worldPosition はチャンク条件によって定義されない場合があり、
//      また instanceMatrix を乗算しないとインスタンスの位置・回転が反映されず全個体で同じ模様が重複してしまうため。
// 3. 遠景エイリアシング対策:
//    - How: 3D テクスチャ側のミップマップと、fwidth(vRustWorld * uScale) から画面上のピクセル幅を算出し、
//      遠景では細部の縦筋や微細ノイズを平均値 (0.5) へフェードさせる。
//    - Why not: 1000m 先まで続く長いラチや遠くのゲートで高周波ノイズがサンプリングされると、
//      カメラ移動時に激しいモアレやチラツキ（エイリアシング）を引き起こすため。
// 4. スクリーンスペース法線摂動（Mikkelsen 方式）:
//    - How: 画面空間微分 (dFdx, dFdy) を用いて、高さマップ勾配から法線を摂動させる。
//    - Why not: 対象メッシュ群には法線マップ用の接線（Tangent）属性が存在しないため、
//      接空間を仮定せずに画面空間で動的に法線凹凸を計算する手法を採用した。

export interface RustyMetalOptions {
  /** 塗装の色（白いラチ、緑のゲート枠など） */
  paint: THREE.ColorRepresentation;
  /** 錆の量 0..1（0 = ほぼ新品、1 = 塗装がかなり剥げて錆が浮く） */
  rust: number;
  /** 模様の細かさ（1 ワールド単位あたり、既定値 1.0） */
  scale?: number;
  /** 健全な塗装面の粗さ 0..1（既定値 0.4） */
  roughness?: number;
  /** 健全な塗装面の金属感 0..1（既定値 0.1） */
  metalness?: number;
}

const RUST_VERTEX_DECLARATIONS = /* glsl */ `
  varying vec3 vRustWorld;
  varying vec3 vRustNormal;
`;

const RUST_VERTEX_CALCULATION = /* glsl */ `
  #include <begin_vertex>
  #ifdef USE_INSTANCING
    mat4 rustModel = modelMatrix * instanceMatrix;
    vRustWorld = (rustModel * vec4(transformed, 1.0)).xyz;
    vRustNormal = normalize((rustModel * vec4(objectNormal, 0.0)).xyz);
  #else
    vRustWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
    vRustNormal = normalize((modelMatrix * vec4(objectNormal, 0.0)).xyz);
  #endif
`;

const RUST_FRAGMENT_DECLARATIONS = /* glsl */ `
  varying vec3 vRustWorld;
  varying vec3 vRustNormal;

  uniform vec3 uPaintColor;
  uniform float uRust;
  uniform float uScale;

  ${NOISE3D_GLSL}

  // スクリーンスペース法線摂動。
  // 接空間（Tangent）や UV を持たないジオメトリでも、画面空間微分（dFdx, dFdy）から
  // 高さ勾配に応じた自然な法線凹凸を計算する（Morten S. Mikkelsen の手法に準拠）。
  vec3 rustPerturbNormal(vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir) {
    vec3 vSigmaX = normalize(dFdx(surfPos));
    vec3 vSigmaY = normalize(dFdy(surfPos));
    vec3 vN = surfNorm;
    vec3 r1 = cross(vSigmaY, vN);
    vec3 r2 = cross(vN, vSigmaX);
    float fDet = dot(vSigmaX, r1) * faceDir;
    vec3 vGrad = sign(fDet) * (dHdxy.x * r1 + dHdxy.y * r2);
    return normalize(abs(fDet) * surfNorm - vGrad);
  }
`;

const RUST_FRAGMENT_COLOR = /* glsl */ `
  // ワールド座標と法線
  vec3 rustP = vRustWorld * uScale;
  vec3 rustWn = normalize(vRustNormal);

  // 遠景でのちらつき（モアレ・エイリアシング）を防ぐため、画面上の微分量から細部フェード係数を求める。
  // 近景では fineFade = 1.0（細部描画）、遠景では fineFade = 0.0（平均値へ収束）。
  float rustPixelSize = length(fwidth(rustP));
  float rustFineFade = 1.0 - clamp(rustPixelSize * 3.5, 0.0, 1.0);

  // 3D テクスチャ（noise3）によるソリッドテクスチャ参照:
  // トライプラナーを用いず、ワールド座標から直接引く。
  // 1. 中周波パターン:
  //    重力方向 (-y) に伸びる錆の垂れ筋（streak）を表現するため、y 軸を水平方向に比べ引き伸ばす（倍率を小さくする）。
  //    垂直面では縦筋になり、水平面では滑らかな広がりになる。
  vec3 streakCoord = vec3(rustP.x * 0.35, rustP.y * 0.035, rustP.z * 0.35);
  vec4 streakSamp = noise3(streakCoord);
  float rustStreakBase = streakSamp.r;
  float rustStreakFine = noise3(streakCoord * 3.5).g;
  float rustMesoPattern = rustStreakBase * 0.65 + mix(0.5, rustStreakFine, rustFineFade) * 0.35;

  // 2. 低周波マクロノイズ（部材全体が一様に錆びるのを防ぐ偏り）
  float rustMacroNoise = noise3(rustP * 0.025).r;

  // 3. 微細な点錆・ピッティング（Worley セル距離 B チャンネルと高周波 G チャンネルを合成）
  vec4 microSamp = noise3(rustP * 1.5);
  // Worley セルの谷間（B チャンネルが小さい箇所）に点状の錆び穴ができる
  float rustPitting = 1.0 - smoothstep(0.0, 0.45, microSamp.b);
  float rustMicroNoise = mix(microSamp.g, rustPitting, 0.5);
  rustMicroNoise = mix(0.5, rustMicroNoise, rustFineFade);

  // 総合的な錆の発生ポテンシャル（0..1）
  float rustPotential = rustMacroNoise * 0.45 + rustMesoPattern * 0.40 + rustMicroNoise * 0.15;

  // uRust に基づく多段閾値。
  // uRust = 0 では一切錆びず、uRust が小さいときは薄い染みと微細な点錆だけが出現する。
  float rustThreshold = 1.02 - uRust * 1.05;
  float rustStainThreshold = rustThreshold - 0.22;
  float rustDeepThreshold = rustThreshold + 0.12;

  // 1. 錆の染み（塗装の上に雨水等で滲み出た淡い錆色）
  float rustStainMask = smoothstep(rustStainThreshold, rustStainThreshold + 0.18, rustPotential);
  rustStainMask *= clamp(uRust * 3.5, 0.0, 1.0);

  // 2. 塗装剥がれ・露出した赤茶色の錆
  float rustMask = smoothstep(rustThreshold, rustThreshold + 0.06, rustPotential);
  rustMask *= clamp(uRust * 6.0, 0.0, 1.0);

  // 3. 古く黒ずんだ深いこげ茶の錆（中心部）
  float rustDeepMask = smoothstep(rustDeepThreshold, rustDeepThreshold + 0.08, rustPotential);
  rustDeepMask *= clamp(uRust * 6.0, 0.0, 1.0);

  // 塗装剥がれ境界のエッジ（塗膜の厚みによる微細な段差陰影）
  float rustEdgeDist = abs(rustPotential - rustThreshold);
  float rustPeelEdge = (1.0 - smoothstep(0.0, 0.035, rustEdgeDist)) * rustMask;

  // 色パレット
  // 鮮やかな赤茶色の赤錆
  vec3 rustColFresh = vec3(0.50, 0.18, 0.07);
  // 古く黒ずんだこげ茶〜黒色の深い錆
  vec3 rustColDark = vec3(0.18, 0.08, 0.04);
  // 塗装に滲み出た淡い黄褐色・赤茶色の染み
  vec3 rustColStain = vec3(0.56, 0.28, 0.13);

  // 錆内部の色グラデーション
  vec3 rustColBody = mix(rustColFresh, rustColDark, rustDeepMask);

  // 塗装色にまず染みをブレンド（明るい色でも自然に馴染むよう明度を調整）
  vec3 rustStainBlend = mix(uPaintColor * 0.75, rustColStain, 0.65);
  vec3 rustStainedPaint = mix(uPaintColor, rustStainBlend, rustStainMask);
  // 剥がれ境界のわずかな陰影（膜厚感）
  rustStainedPaint *= 1.0 - rustPeelEdge * 0.3;

  // 剥がれた部分に本錆を合成
  diffuseColor.rgb = mix(rustStainedPaint, rustColBody, rustMask);
`;

const RUST_FRAGMENT_ROUGHNESS = /* glsl */ `
  // 錆びた部分は塗装に比べて光沢を失いマットになる
  roughnessFactor = mix(roughnessFactor, min(roughnessFactor + 0.22, 0.85), rustStainMask);
  roughnessFactor = mix(roughnessFactor, 0.94, rustMask);
`;

const RUST_FRAGMENT_METALNESS = /* glsl */ `
  // 酸化した錆は誘電体（非金属）として振る舞うため、メタルネスをほぼゼロにする
  metalnessFactor = mix(metalnessFactor, 0.04, rustMask);
`;

const RUST_FRAGMENT_NORMAL = /* glsl */ `
  // 塗装面（平坦）に対して、剥がれエッジの段差と錆面の凹み・微細なザラつきを与える
  float rustHeight = (1.0 - rustMask * 0.14) + rustPeelEdge * 0.10 + (rustMesoPattern - 0.5) * 0.06 * rustMask;
  vec2 rustDHdxy = vec2(dFdx(rustHeight), dFdy(rustHeight)) * rustFineFade * 0.7;
  normal = rustPerturbNormal(-vViewPosition, normal, rustDHdxy, faceDirection);
`;

/**
 * 錆びた金属・塗装を表現する MeshStandardMaterial を作成する
 */
export const createRustyMetalMaterial = (options: RustyMetalOptions): THREE.MeshStandardMaterial => {
  const baseRoughness = options.roughness ?? 0.4;
  const baseMetalness = options.metalness ?? 0.1;
  const material = new THREE.MeshStandardMaterial({
    color: options.paint,
    roughness: baseRoughness,
    metalness: baseMetalness,
  });

  const clampedRust = Math.max(0, Math.min(1, options.rust));
  const scale = options.scale ?? 1.0;

  const uniforms = {
    uNoise3D: { value: getNoise3D() },
    uPaintColor: { value: new THREE.Color(options.paint) },
    uRust: { value: clampedRust },
    uScale: { value: scale },
  };

  material.customProgramCacheKey = () => "RustyMetalMaterial";

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader =
      RUST_VERTEX_DECLARATIONS +
      "\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        RUST_VERTEX_CALCULATION
      );

    shader.fragmentShader =
      RUST_FRAGMENT_DECLARATIONS +
      "\n" +
      shader.fragmentShader
        .replace(
          "#include <color_fragment>",
          "#include <color_fragment>\n" + RUST_FRAGMENT_COLOR
        )
        .replace(
          "#include <roughnessmap_fragment>",
          "#include <roughnessmap_fragment>\n" + RUST_FRAGMENT_ROUGHNESS
        )
        .replace(
          "#include <metalnessmap_fragment>",
          "#include <metalnessmap_fragment>\n" + RUST_FRAGMENT_METALNESS
        )
        .replace(
          "#include <normal_fragment_maps>",
          "#include <normal_fragment_maps>\n" + RUST_FRAGMENT_NORMAL
        );
  };

  return material;
};

