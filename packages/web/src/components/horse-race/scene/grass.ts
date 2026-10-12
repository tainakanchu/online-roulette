import * as THREE from "three";
import type { GroundDetail } from "./groundTextures";
import { getNoise3D, NOISE3D_GLSL } from "./noise3d";
import { COURSE_UNIFORMS_GLSL, SURFACE_GLSL, WIND_GLSL, type CourseUniforms } from "./surfaceCommon";

// 芝のシェーダー。
// - 芝の面: 見る向きで明暗が変わる刈り込みの縞、風が渡る明暗の波、大小のムラ、濡れたときのツヤ
// - 芝の葉: カメラの近くだけに生やし、頂点シェーダーで風になびかせる
// 細部（葉と隙間の明暗・凹凸）とムラは 3D テクスチャをワールド座標で引く。

// ----- 芝の面 -----
const TURF_COLOR = /* glsl */ `
  vec3 turfWorld = vTurfWorld;
  vec2 turfXZ = turfWorld.xz;
  // 3D 細部テクスチャ（createTurfDetail）を地面の (x, z) で引く。奥行き方向は低周波ノイズで動かして
  // 場所ごとに別のスライスを使い、タイルの繰り返しを崩す
  float turfSlice = noise3(vec3(turfXZ * 0.03, 0.29)).r;
  vec3 turfCoordA = vec3(turfXZ / 2.5, turfSlice);
  vec3 turfCoordB = vec3(vec2(turfXZ.y, -turfXZ.x) / 6.3, turfSlice + 0.5);
  vec4 sampA = texture(uTurfDetail, turfCoordA);
  vec4 sampB = texture(uTurfDetail, turfCoordB);
  // 遠くでは凹凸を平らに寄せて、ちらつき（エイリアス）を防ぐ
  float turfFine = 1.0 - clamp(length(fwidth(turfXZ)) * 4.0, 0.0, 1.0);
  {
    vec2 xz = turfXZ;
    // 芝目: テクスチャの縞の帯ごとに刈る向きが逆なので、走る方向から見ると明暗が強まり、反対から見ると反転する
    float band = fract(vMapUv.x) < 0.5 ? 1.0 : -1.0;
    vec2 toCamera = normalize(cameraPosition.xz - xz + vec2(1e-4, 0.0));
    float sheen = band * toCamera.x * 0.12;
    float wind = windStrength(xz);
    // 大小のムラ（3D ノイズのなめらか fBm と細かいノイズ）でテクスチャの繰り返しを目立たなくする
    float patchy = noise3(vec3(xz * 0.015, 0.12)).r * 0.6 + noise3(vec3(xz * 0.09, 0.45)).g * 0.4;
    diffuseColor.rgb *= 1.0 + sheen + (wind - 0.5) * 0.08 + (patchy - 0.5) * 0.22;
    // ムラの明るいところは少し黄味がかった芝にする
    diffuseColor.rgb *= mix(vec3(1.0), vec3(1.08, 1.04, 0.82), smoothstep(0.55, 0.85, patchy));
    // 水を含むほど暗く深い緑になる
    diffuseColor.rgb *= mix(vec3(1.0), vec3(0.62, 0.7, 0.6), uWetness);
    // 葉と葉の隙間の明暗（どちらも平均 0.5 なので、足すと平均 1 で全体の明るさは変わらない）
    diffuseColor.rgb *= sampA.r + sampB.r;
  }
`;

const TURF_NORMAL = /* glsl */ `
  {
    // 3D テクスチャの高さ（A、葉の束の盛り上がり。最大 2.5cm 相当）で上向きの法線を傾け、ビュー空間へ移す
    float turfHeight = (sampA.a + sampB.a) * 0.5 * 0.025 * turfFine;
    vec3 worldNormal = bumpNormal(vTurfWorld, vec3(0.0, 1.0, 0.0), turfHeight);
    normal = normalize((viewMatrix * vec4(worldNormal, 0.0)).xyz);
  }
`;

/**
 * 芝の面のマテリアル。縞模様のテクスチャ（createTurfTexture）を地の色に、
 * 細部テクスチャ（createTurfDetail）を 3D ワールド座標で重ねる
 */
export const createTurfMaterial = (map: THREE.Texture, detail: GroundDetail, uniforms: CourseUniforms) => {
  const material = new THREE.MeshStandardMaterial({ map, roughness: 0.85 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, {
      uTurfDetail: { value: detail.texture },
      uNoise3D: { value: getNoise3D() },
    });
    shader.vertexShader =
      "varying vec3 vTurfWorld;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\n  vTurfWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;"
      );
    shader.fragmentShader =
      "varying vec3 vTurfWorld;\nuniform sampler3D uTurfDetail;\n" +
      NOISE3D_GLSL +
      SURFACE_GLSL +
      shader.fragmentShader
        .replace("#include <map_fragment>", "#include <map_fragment>\n" + TURF_COLOR)
        .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\n" + TURF_NORMAL)
        .replace(
          "#include <roughnessmap_fragment>",
          "#include <roughnessmap_fragment>\n  roughnessFactor = mix(roughnessFactor, 0.5, uWetness);"
        )
        // 濡れた芝は浅い角度から見ると空が映ってツヤが出る
        .replace(
          "#include <opaque_fragment>",
          "outgoingLight = wetReflection(outgoingLight, vTurfWorld, vec3(0.0, 1.0, 0.0), uWetness * 0.15);\n#include <opaque_fragment>"
        );
  };
  return material;
};

// ----- 芝の葉 -----
const BLADE_VERTEX = /* glsl */ `
  vec2 root = vec2(aBlade.x, sign(aBlade.y) * mix(uZone.x, uZone.y, abs(aBlade.y)));
  // 周期 uPeriod で並べた芝を、注視点に一番近い周期へ折り返す（芝自体は地面に対して動かない）
  root.x += uPeriod * floor((uCenter - root.x) / uPeriod + 0.5);
  float fromCenter = abs(root.x - uCenter) / (uPeriod * 0.5);
  // 帯の端へ向かって背を低くして、芝が生えている範囲の境目を見せない
  float height = uBladeHeight * (0.6 + 0.8 * aBlade.z) * (1.0 - smoothstep(0.35, 1.0, fromCenter));
  float angle = aBlade.w * 6.28318;
  vec2 across = vec2(cos(angle), sin(angle)) * uBladeWidth;
  float t = position.y;
  // 濡れた葉は重くてあまりなびかない
  float wind = windStrength(root) * (1.0 - 0.5 * uWetness);
  // 先端ほど風下へ倒し、倒れた分だけ背を縮める
  vec2 lean = uWindDir * (0.15 + 0.55 * wind) * uWindStrength * t * t * height;
  vec3 transformed = vec3(
    root.x + across.x * position.x + lean.x,
    t * height * (1.0 - 0.2 * wind * t),
    root.y + across.y * position.x + lean.y
  );
  // 根元は葉の陰で暗く、先端は光を透かして明るく。濡れると全体に暗くなる
  vBladeShade = mix(0.5, 1.15, t) * (0.85 + 0.3 * fract(aBlade.z * 7.0)) * mix(1.0, 0.68, uWetness);
  // 芝の面と同じ刈り込みの縞（帯ごとの明暗と、見る向きで変わるツヤ）をつけて、葉のある所とない所をなじませる
  float stripe = fract((root.x - uStripeOrigin) / uStripePeriod) < 0.5 ? 1.0 : -1.0;
  vec2 toCamera = normalize(cameraPosition.xz - root + vec2(1e-4, 0.0));
  vBladeShade *= 1.0 + stripe * (0.08 + toCamera.x * 0.12);
  // ゴール線は芝の上から白く塗ってある
  vBladePaint = (1.0 - step(0.25, abs(root.x - uFinish.x))) * (1.0 - step(uFinish.y, abs(root.y)));
`;

export interface GrassFieldOptions {
  /** 葉の本数 */
  count: number;
  /** x 方向の周期。この長さの帯を注視点の近くへ折り返して使う */
  period: number;
  /** 芝の面の縞（createTurfTexture）の始点と 1 周期の長さ */
  stripeOrigin: number;
  stripePeriod: number;
  /** ゴール線の x 座標と、ゴール線を引く走路の半幅（線の上の葉は白く塗る） */
  finishX: number;
  trackHalfWidth: number;
  bladeHeight: number;
  bladeWidth: number;
  color: THREE.ColorRepresentation;
}

/**
 * カメラの近くだけに生やす芝の葉。コース全長に生やすと本数が膨大になるので、
 * 一定の周期で並べた帯を頂点シェーダーで注視点の近くへ折り返す。
 */
export class GrassField {
  readonly mesh: THREE.Mesh;
  private readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly material: THREE.MeshStandardMaterial;
  private readonly center = { value: 0 };
  /** 葉を生やす |z| の範囲（内側, 外側） */
  private readonly zone = { value: new THREE.Vector2(0, 1) };

  constructor(uniforms: CourseUniforms, options: GrassFieldOptions) {
    // 細長い 1 枚の葉（幅 -0.5..0.5、高さ 0..1）
    const shape = [-0.5, 0, 0.5, 0, -0.32, 0.5, 0.32, 0.5, 0, 1];
    const positions = new Float32Array(15);
    const normals = new Float32Array(15);
    for (let i = 0; i < 5; i += 1) {
      positions[i * 3] = shape[i * 2];
      positions[i * 3 + 1] = shape[i * 2 + 1];
      normals[i * 3 + 1] = 1;
    }
    this.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    this.geometry.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
    this.geometry.setIndex([0, 1, 2, 2, 1, 3, 2, 3, 4]);
    // x は周期内の位置、y は -1..1（符号で内外どちら側か、絶対値で zone 内の位置）
    const blades = new Float32Array(options.count * 4);
    for (let i = 0; i < options.count; i += 1) {
      blades[i * 4] = Math.random() * options.period;
      blades[i * 4 + 1] = Math.random() * 2 - 1;
      blades[i * 4 + 2] = Math.random();
      blades[i * 4 + 3] = Math.random();
    }
    this.geometry.setAttribute("aBlade", new THREE.InstancedBufferAttribute(blades, 4));
    this.geometry.instanceCount = options.count;

    this.material = new THREE.MeshStandardMaterial({
      color: options.color,
      roughness: 0.8,
      side: THREE.DoubleSide,
    });
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms, {
        uCenter: this.center,
        uZone: this.zone,
        uPeriod: { value: options.period },
        uStripeOrigin: { value: options.stripeOrigin },
        uStripePeriod: { value: options.stripePeriod },
        uFinish: { value: new THREE.Vector2(options.finishX, options.trackHalfWidth) },
        uBladeHeight: { value: options.bladeHeight },
        uBladeWidth: { value: options.bladeWidth },
      });
      shader.vertexShader =
        "attribute vec4 aBlade;\nuniform float uCenter;\nuniform vec2 uZone;\nuniform float uPeriod;\nuniform float uStripeOrigin;\nuniform float uStripePeriod;\nuniform vec2 uFinish;\nvarying float vBladePaint;\nuniform float uBladeHeight;\nuniform float uBladeWidth;\nvarying float vBladeShade;\n" +
        // 頂点シェーダーでは風の関数だけ使う（SURFACE_GLSL の凹凸関数はフラグメント専用の dFdx を含む）
        COURSE_UNIFORMS_GLSL +
        WIND_GLSL +
        shader.vertexShader
          // 葉は細いので向きどおりに陰影をつけるとちらつく。地面と同じ上向きの法線で照らす
          .replace("#include <beginnormal_vertex>", "vec3 objectNormal = vec3(0.0, 1.0, 0.0);")
          .replace("#include <begin_vertex>", BLADE_VERTEX);
      shader.fragmentShader =
        "varying float vBladeShade;\nvarying float vBladePaint;\n" +
        shader.fragmentShader
          .replace(
            "#include <color_fragment>",
            "#include <color_fragment>\n  diffuseColor.rgb = mix(diffuseColor.rgb * vBladeShade, vec3(0.9) * vBladeShade, vBladePaint);"
          )
          // 裏面でも法線を反転させない（両面とも地面と同じ明るさにする）
          .replace("#include <normal_fragment_begin>", "#include <normal_fragment_begin>\n  normal = normalize(vNormal);");
    };

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    // 位置は頂点シェーダーで決まるので、境界球による視錐台カリングは使えない
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
  }

  /** 芝を生やす帯の中心（x 座標） */
  setCenter(x: number) {
    this.center.value = x;
  }

  /** 芝を生やす |z| の範囲 */
  setZone(inner: number, outer: number) {
    this.zone.value.set(inner, outer);
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
