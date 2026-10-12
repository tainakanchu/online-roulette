import * as THREE from "three";

// 旗の布のシェーダー（発走委員の赤い旗）。
// 竿の側（x = 0）は固定し、先端へ向かって進む波を重ねてはためかせる。風の強さは時間で強弱をつける（突風）。
// 波の高さを x・y で微分した傾きから法線を作り直すので、しわに沿った陰影が出る。
// 布は薄いので、太陽の向こうから見ると光が透けて明るく見える。

/** 旗の布の大きさ（竿の側 x = 0 から先端 x = 0.9、上端 y = 0 から下端 y = -0.6） */
export const FLAG_SIZE = { width: 0.9, height: 0.6 };

const FLAG_WAVE_GLSL = /* glsl */ `
  uniform float uFlagTime;
  uniform vec3 uFlagSunDir;
  // 風の強さ 0.35..1。ゆっくりした強弱に、ときどき突風が乗る
  float flagGust(float t) {
    float slow = 0.6 + 0.25 * sin(t * 0.7) + 0.15 * sin(t * 1.9 + 1.3);
    float gust = smoothstep(0.75, 1.0, sin(t * 0.37 + 2.0));
    return clamp(slow + 0.35 * gust, 0.35, 1.0);
  }
  // 布の面に垂直な変位（ローカルの z）。竿の側は動かず、先端ほど大きく、上下の端は少し遅れる
  float flagWave(vec2 p, float t) {
    float u = clamp(p.x / ${FLAG_SIZE.width.toFixed(2)}, 0.0, 1.0);
    float v = clamp(-p.y / ${FLAG_SIZE.height.toFixed(2)}, 0.0, 1.0);
    float wind = flagGust(t);
    float speed = 5.0 + 6.0 * wind;
    float travel = p.x * 9.0 - t * speed;
    float wave = sin(travel + v * 1.2) * 0.6 + sin(travel * 1.9 - v * 2.3 + 1.7) * 0.25 + sin(travel * 3.7 + v * 4.1) * 0.08;
    return wave * u * (0.09 + 0.12 * wind);
  }
`;

/**
 * 布の変形。three.js の頂点シェーダーは法線（beginnormal_vertex）を位置（begin_vertex）より先に計算するので、
 * 波と傾きはまとめて法線の位置で計算し、位置の所では結果を使うだけにする
 * @param withNormal 法線も作り直す（影を描くときは位置だけでよい）
 */
const flagVertex = (withNormal: boolean) => /* glsl */ `
  vec2 flagP = position.xy;
  float flagZ = flagWave(flagP, uFlagTime);
  ${
    withNormal
      ? `// 傾きは差分で求める（関数を 3 回呼ぶだけで、解析的に微分するより式がずっと短く、間違えにくい）
  float flagE = 0.01;
  float dzdx = (flagWave(flagP + vec2(flagE, 0.0), uFlagTime) - flagZ) / flagE;
  float dzdy = (flagWave(flagP + vec2(0.0, flagE), uFlagTime) - flagZ) / flagE;
  vec3 objectNormal = normalize(vec3(-dzdx, -dzdy, 1.0));`
      : ""
  }
  // 先端ほど風下へ流れて少し短く見え、強い風では水平に近づく（重みで垂れる量が減る）
  float flagU = clamp(position.x / ${FLAG_SIZE.width.toFixed(2)}, 0.0, 1.0);
  vec3 flagTransformed = vec3(
    position.x * (1.0 - 0.06 * flagU),
    position.y - (1.0 - flagGust(uFlagTime)) * 0.06 * flagU * flagU,
    position.z + flagZ
  );
  vFlagUv = vec2(flagU, 1.0 - clamp(-position.y / ${FLAG_SIZE.height.toFixed(2)}, 0.0, 1.0));
`;

const FLAG_TRANSLUCENCY = /* glsl */ `
  {
    // 逆光で布が透ける。透け具合は布の厚み（縁や袋縫いは二重・三重で透けにくい）に従う
    vec3 flagView = normalize(vFlagWorld - cameraPosition);
    float backlit = pow(max(dot(flagView, normalize(uFlagSunDir)), 0.0), 3.0);
    float translucency = FLAG_TRANSLUCENCY_VALUE;
    outgoingLight += diffuseColor.rgb * backlit * translucency * 1.6;
  }
`;

export interface FlagUniforms {
  uFlagTime: { value: number };
  uFlagSunDir: { value: THREE.Vector3 };
}

export const createFlagUniforms = (sunDirection: THREE.Vector3): FlagUniforms => ({
  uFlagTime: { value: 0 },
  uFlagSunDir: { value: sunDirection.clone().normalize() },
});

export interface FlagMaterialOptions {
  color: THREE.ColorRepresentation;
  /** 布の色のテクスチャ（u = 竿 0 → 先端 1、v = 下 0 → 上 1） */
  map?: THREE.Texture | null;
  /** 布の凹凸と透け具合（R: 布目の高さ G: 縫い目の高さ B: 透け具合） */
  detail?: THREE.Texture | null;
  /**
   * 物理エンジンで動かす布（clothFlag.ts）。頂点はワールド座標で毎フレーム書き換えるので、頂点シェーダーでは揺らさず、
   * 布の上の位置は aFlagUv 属性から読む
   */
  simulated?: boolean;
}

/** 旗の布（平面のジオメトリ。竿の側 x = 0、上端 y = 0） */
export const createFlagMaterial = (uniforms: FlagUniforms, options: FlagMaterialOptions) => {
  const material = new THREE.MeshStandardMaterial({
    color: options.map ? "#ffffff" : options.color,
    roughness: 0.85,
    side: THREE.DoubleSide,
  });
  const hasMap = Boolean(options.map);
  const hasDetail = Boolean(options.detail);
  const simulated = Boolean(options.simulated);
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, {
      uFlagMap: { value: options.map ?? null },
      uFlagDetail: { value: options.detail ?? null },
    });
    const worldVarying = "#include <project_vertex>\n  vFlagWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;";
    shader.vertexShader = simulated
      ? "attribute vec2 aFlagUv;\nvarying vec2 vFlagUv;\nvarying vec3 vFlagWorld;\n" +
        shader.vertexShader
          .replace("#include <begin_vertex>", "#include <begin_vertex>\n  vFlagUv = aFlagUv;")
          .replace("#include <project_vertex>", worldVarying)
      : "varying vec2 vFlagUv;\nvarying vec3 vFlagWorld;\n" +
        FLAG_WAVE_GLSL +
        shader.vertexShader
          .replace("#include <beginnormal_vertex>", flagVertex(true))
          .replace("#include <begin_vertex>", "vec3 transformed = flagTransformed;")
          .replace("#include <project_vertex>", worldVarying);
    const translucency = hasDetail ? "texture2D(uFlagDetail, vFlagUv).b" : "0.75";
    shader.fragmentShader =
      "varying vec2 vFlagUv;\nvarying vec3 vFlagWorld;\nuniform sampler2D uFlagMap;\nuniform sampler2D uFlagDetail;\nuniform vec3 uFlagSunDir;\n" +
      shader.fragmentShader
        .replace(
          "#include <color_fragment>",
          "#include <color_fragment>\n" +
            (hasMap ? "  diffuseColor.rgb *= texture2D(uFlagMap, vFlagUv).rgb;\n" : "") +
            (hasDetail
              ? "  diffuseColor.rgb *= 0.9 + 0.2 * texture2D(uFlagDetail, vFlagUv).r;\n"
              : "")
        )
        .replace("#include <opaque_fragment>", FLAG_TRANSLUCENCY.replace("FLAG_TRANSLUCENCY_VALUE", translucency) + "\n#include <opaque_fragment>");
  };
  // 色のテクスチャと凹凸のテクスチャの有無でシェーダーが変わるので、キャッシュを分ける
  material.customProgramCacheKey = () => `flag-${hasMap}-${hasDetail}-${simulated}`;
  return material;
};

/** 影も布の揺れに合わせる */
export const createFlagDepthMaterial = (uniforms: FlagUniforms) => {
  const material = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader =
      "varying vec2 vFlagUv;\n" +
      FLAG_WAVE_GLSL +
      shader.vertexShader.replace("#include <begin_vertex>", flagVertex(false) + "\n  vec3 transformed = flagTransformed;");
  };
  return material;
};
