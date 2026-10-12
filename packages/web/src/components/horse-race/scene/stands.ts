import * as THREE from "three";
import { NOISE3D_GLSL, noise3DUniform } from "./noise3d";
import { COURSE_UNIFORMS_GLSL, NOISE_GLSL, SKY_GLSL, type CourseUniforms } from "./surfaceCommon";

// スタンドまわりのシェーダー（座席の段・観客・背後のガラス張りの建物・屋根）。
// どれも単純な箱やカプセルのままなので、汚れやムラは共有の 3D テクスチャ（noise3）をワールド座標で引き、
// 座席や窓の並びのような規則的な模様だけを座標から計算する（hash21 は座席・窓ごとの乱数に使う）。

const worldVaryingVertex = (name: string) => /* glsl */ `
  #include <begin_vertex>
  #ifdef USE_INSTANCING
    v${name}World = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  #else
    v${name}World = (modelMatrix * vec4(transformed, 1.0)).xyz;
  #endif
  v${name}Normal = normalize(mat3(modelMatrix) * objectNormal);
`;

// ----- 座席の段 -----

export interface SeatOptions {
  /** スタンドの x の始まり（座席・ブロックの基準） */
  start: number;
  /** 最前列の段の中心 z */
  front: number;
  rowDepth: number;
  rowRise: number;
  /** 座席の間隔（観客の間隔と同じ） */
  seatSpacing: number;
  /** ブロックの長さと、ブロックの間の通路の幅 */
  blockLength: number;
  aisleWidth: number;
}

const SEAT_FRAGMENT = /* glsl */ `
  {
    vec3 p = vStandWorld;
    vec3 n = normalize(vStandNormal);
    float along = p.x - uSeatStart;
    float block = floor(along / uBlockLength);
    float isAisle = step(along - block * uBlockLength, uAisleWidth);
    // ブロックごとに座席の色を変える
    vec3 seatColor = mod(block, 2.0) < 0.5 ? vec3(0.32, 0.02, 0.04) : vec3(0.02, 0.07, 0.24);
    float cell = fract(along / uSeatSpacing);
    seatColor *= 0.9 + 0.2 * hash21(vec2(floor(along / uSeatSpacing), floor(p.z)));
    float seatX = smoothstep(0.08, 0.12, cell) * (1.0 - smoothstep(0.88, 0.92, cell)) * (1.0 - isAisle);
    // 段の前端からの位置（整数部が列、小数部が段の中の奥行き 0 = 前端）
    float rowCoord = (uSeatFront + uRowDepth * 0.5 - p.z) / uRowDepth;

    // コンクリートの汚れと、縦に引き伸ばして引いた雨だれ
    float stain = noise3(p * 0.12).r * 0.6 + noise3(p * 0.9).g * 0.4;
    float drip = noise3(vec3(p.x * 0.7, p.y * 0.05, p.z * 0.7)).g;
    vec3 color = diffuseColor.rgb * (0.78 + 0.35 * stain) * (1.0 - 0.15 * smoothstep(0.55, 0.8, drip));
    if (n.y > 0.5) {
      // 段の上: 座面
      float d = fract(rowCoord);
      float pan = smoothstep(0.3, 0.34, d) * (1.0 - smoothstep(0.92, 0.96, d));
      color = mix(color, seatColor * 0.85, pan * seatX);
    } else if (n.z > 0.5) {
      // 段の立ち上がり: 1 つ前の列の背もたれ。最前列の壁にはチームカラーの帯を引く
      float row = floor(rowCoord + 0.5);
      float yl = fract(p.y / uRowRise);
      float back = (1.0 - smoothstep(0.82, 0.86, yl)) * step(0.5, row) * seatX;
      color = mix(color, seatColor, back);
      float band = step(row, 0.5) * smoothstep(0.55, 0.6, yl) * (1.0 - smoothstep(0.85, 0.9, yl));
      color = mix(color, vec3(0.6, 0.45, 0.02), band);
    }
    diffuseColor.rgb = color;
  }
`;

/** 座席の段（箱を積んだスタンド）のマテリアル。地の色はコンクリート */
export const createSeatMaterial = (options: SeatOptions) => {
  const material = new THREE.MeshStandardMaterial({ color: "#c9c4bb", roughness: 0.9 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, noise3DUniform(), {
      uSeatStart: { value: options.start },
      uSeatFront: { value: options.front },
      uRowDepth: { value: options.rowDepth },
      uRowRise: { value: options.rowRise },
      uSeatSpacing: { value: options.seatSpacing },
      uBlockLength: { value: options.blockLength },
      uAisleWidth: { value: options.aisleWidth },
    });
    shader.vertexShader =
      "varying vec3 vStandWorld;\nvarying vec3 vStandNormal;\n" +
      shader.vertexShader.replace("#include <begin_vertex>", worldVaryingVertex("Stand"));
    shader.fragmentShader =
      "varying vec3 vStandWorld;\nvarying vec3 vStandNormal;\nuniform float uSeatStart;\nuniform float uSeatFront;\nuniform float uRowDepth;\nuniform float uRowRise;\nuniform float uSeatSpacing;\nuniform float uBlockLength;\nuniform float uAisleWidth;\n" +
      NOISE_GLSL +
      NOISE3D_GLSL +
      shader.fragmentShader.replace("#include <color_fragment>", "#include <color_fragment>\n" + SEAT_FRAGMENT);
  };
  return material;
};

// ----- 観客 -----

export interface CrowdUniforms {
  uTime: { value: number };
  /** 盛り上がりに応じた跳ねる高さ */
  uAmp: { value: number };
}

const CROWD_FRAGMENT = /* glsl */ `
  {
    // カプセル 1 つを人に見立てる。上から帽子 or 髪・顔・服に塗り分け、人ごとの違いは位相から作る
    float seed = fract(vCrowdPhase * 0.15915);
    float y = vCrowdLocal.y;
    vec3 skin = mix(vec3(0.86, 0.58, 0.42), vec3(0.3, 0.17, 0.1), hash21(vec2(seed, 1.0)) * 0.85);
    float hairTone = hash21(vec2(seed, 2.0));
    vec3 hair = hairTone > 0.85 ? vec3(0.45, 0.43, 0.4) : mix(vec3(0.015, 0.01, 0.008), vec3(0.2, 0.11, 0.05), hairTone);
    vec3 head = mix(skin, hair, smoothstep(0.3, 0.33, y));
    // 3 割ほどは帽子
    float hasHat = step(hash21(vec2(seed, 3.0)), 0.3);
    vec3 hat = vec3(hash21(vec2(seed, 4.0)), hash21(vec2(seed, 5.0)), hash21(vec2(seed, 6.0)));
    head = mix(head, hat * hat, hasHat * smoothstep(0.26, 0.28, y));
    // 服のしわ（人ごとにずらしたローカル座標で 3D テクスチャを引く）
    diffuseColor.rgb *= 0.85 + 0.3 * noise3(vCrowdLocal * 2.5 + seed * 7.0).g;
    diffuseColor.rgb = mix(diffuseColor.rgb, head, smoothstep(0.16, 0.19, y));
    // 座席に沈む下半身は暗く
    diffuseColor.rgb *= mix(0.55, 1.0, smoothstep(-0.38, 0.05, y));
  }
`;

/** 観客（CapsuleGeometry の InstancedMesh）。aPhase / aEnergy 属性で跳ね方を変える。服の色は setColorAt */
export const createCrowdMaterial = (uniforms: CrowdUniforms) => {
  const material = new THREE.MeshStandardMaterial({ roughness: 0.8 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, noise3DUniform());
    shader.vertexShader =
      "attribute float aPhase;\nattribute float aEnergy;\nuniform float uTime;\nuniform float uAmp;\nvarying vec3 vCrowdLocal;\nvarying float vCrowdPhase;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
  vCrowdLocal = position;
  vCrowdPhase = aPhase;
  transformed.y += max(0.0, sin(uTime * (3.0 + aEnergy * 3.0) + aPhase)) * uAmp * aEnergy;`
      );
    shader.fragmentShader =
      "varying vec3 vCrowdLocal;\nvarying float vCrowdPhase;\n" +
      NOISE_GLSL +
      NOISE3D_GLSL +
      shader.fragmentShader.replace("#include <color_fragment>", "#include <color_fragment>\n" + CROWD_FRAGMENT);
  };
  return material;
};

// ----- 背後のガラス張りの建物 -----

const FACADE_FRAGMENT = /* glsl */ `
  vec3 facadeN = normalize(vFacadeNormal);
  // 壁面の横方向の座標（正面は x、側面は z）
  float facadeU = abs(facadeN.z) > 0.5 ? vFacadeWorld.x : vFacadeWorld.z;
  float floorCoord = vFacadeWorld.y / 3.4;
  float floorFrac = fract(floorCoord);
  float bayFrac = fract(facadeU / 2.2);
  // 各階の床の帯（スパンドレル）と縦の方立て
  float slab = 1.0 - smoothstep(0.12, 0.16, floorFrac);
  float mullion = 1.0 - smoothstep(0.03, 0.06, min(bayFrac, 1.0 - bayFrac));
  float frame = max(slab, mullion) * (1.0 - step(0.5, facadeN.y));
  float facadeGlass = (1.0 - frame) * (1.0 - step(0.5, facadeN.y));
  vec2 facadeCell = vec2(floor(facadeU / 2.2), floor(floorCoord));
  // 夕方なので、ところどころの窓に暖かい明かりがつく（天井の照明なので窓の上側ほど明るい）
  float facadeLit = step(hash21(facadeCell), 0.22) * (0.4 + 0.6 * hash21(facadeCell + 7.0))
    * mix(0.35, 1.0, smoothstep(0.2, 0.95, floorFrac))
    * (0.6 + 0.8 * noise3(vFacadeWorld * vec3(0.7, 0.3, 0.7)).g);
  // 床の帯・方立ての汚れ
  float facadeDirt = noise3(vFacadeWorld * 0.08).r * 0.6 + noise3(vFacadeWorld * 0.6).g * 0.4;
  diffuseColor.rgb = mix(vec3(0.04, 0.06, 0.08), vec3(0.55, 0.55, 0.53) * (0.75 + 0.35 * facadeDirt), frame);
  // 屋上
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.3, 0.3, 0.29), step(0.5, facadeN.y));
`;

const FACADE_OUTPUT = /* glsl */ `
  {
    vec3 viewDir = normalize(vFacadeWorld - cameraPosition);
    float fresnel = 0.06 + 0.94 * pow(1.0 - max(dot(-viewDir, facadeN), 0.0), 5.0);
    // ガラスには空が映り、明かりのついた窓は中が透けて見える。ガラスごとのわずかな歪みで映り込みを揺らす
    vec3 wobble = (noise3(vFacadeWorld * 0.05).rgb - 0.5) * 0.06;
    vec3 reflected = skyColor(reflect(viewDir, normalize(facadeN + wobble))) * fresnel;
    vec3 interior = vec3(1.0, 0.7, 0.4) * facadeLit * 0.45;
    outgoingLight = mix(outgoingLight, reflected + interior * (1.0 - fresnel), facadeGlass);
  }
`;

/** 背後の建物（箱）。窓のグリッド・空の映り込み・窓明かり */
export const createFacadeMaterial = (uniforms: CourseUniforms) => {
  const material = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.6, metalness: 0.1 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, noise3DUniform());
    shader.vertexShader =
      "varying vec3 vFacadeWorld;\nvarying vec3 vFacadeNormal;\n" +
      shader.vertexShader.replace("#include <begin_vertex>", worldVaryingVertex("Facade"));
    shader.fragmentShader =
      "varying vec3 vFacadeWorld;\nvarying vec3 vFacadeNormal;\n" +
      COURSE_UNIFORMS_GLSL +
      NOISE_GLSL +
      NOISE3D_GLSL +
      SKY_GLSL +
      shader.fragmentShader
        .replace("#include <color_fragment>", "#include <color_fragment>\n" + FACADE_FRAGMENT)
        .replace("#include <opaque_fragment>", FACADE_OUTPUT + "\n#include <opaque_fragment>");
  };
  return material;
};

// ----- 屋根 -----

const ROOF_FRAGMENT = /* glsl */ `
  float roofUnder = step(normalize(vRoofNormal).y, -0.5);
  {
    vec3 n = normalize(vRoofNormal);
    vec3 p = vRoofWorld;
    vec3 color = diffuseColor.rgb;
    if (n.y < -0.5) {
      // 屋根の裏: 大梁（x 方向に 4 単位ごと）と母屋（z 方向に 1.5 単位ごと）、その間の天井板
      float beam = 1.0 - smoothstep(0.04, 0.07, abs(fract(p.x / 4.0) - 0.5) * 2.0 - 0.9);
      float purlin = 1.0 - smoothstep(0.02, 0.05, abs(fract(p.z / 1.5) - 0.5) * 2.0 - 0.92);
      color *= 0.75 + 0.25 * noise3(p * 0.15).r;
      color = mix(color, vec3(0.3, 0.31, 0.33), max(beam, purlin * 0.7));
    } else if (n.y > 0.5) {
      // 屋根の上: 金属板の継ぎ目と、低い側へ流れる雨だれの汚れ
      float seam = 1.0 - smoothstep(0.02, 0.05, abs(fract(p.x / 0.9) - 0.5) * 2.0 - 0.94);
      float streak = noise3(vec3(p.x * 0.6, p.y, p.z * 0.04)).g;
      color *= (0.85 + 0.15 * streak) * (1.0 - seam * 0.15);
    }
    diffuseColor.rgb = color;
  }
`;

/** 屋根（薄い箱）。裏側の鉄骨と上面の金属板 */
export const createRoofMaterial = () => {
  const material = new THREE.MeshStandardMaterial({ color: "#eeeeee", roughness: 0.5, metalness: 0.2 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, noise3DUniform());
    shader.vertexShader =
      "varying vec3 vRoofWorld;\nvarying vec3 vRoofNormal;\n" +
      shader.vertexShader.replace("#include <begin_vertex>", worldVaryingVertex("Roof"));
    shader.fragmentShader =
      "varying vec3 vRoofWorld;\nvarying vec3 vRoofNormal;\n" +
      NOISE3D_GLSL +
      shader.fragmentShader
        .replace("#include <color_fragment>", "#include <color_fragment>\n" + ROOF_FRAGMENT)
        // 屋根の裏には日が当たらないので、走路や観客席からの照り返しの分だけ明るくする
        .replace(
          "#include <emissivemap_fragment>",
          "#include <emissivemap_fragment>\n  totalEmissiveRadiance += diffuseColor.rgb * 0.18 * roofUnder;"
        );
  };
  return material;
};
