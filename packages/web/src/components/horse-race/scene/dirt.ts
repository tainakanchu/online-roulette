import * as THREE from "three";
import type { GroundDetail } from "./groundTextures";
import { getNoise3D, NOISE3D_GLSL } from "./noise3d";
import { SURFACE_GLSL, type CourseUniforms } from "./surfaceCommon";

// ダート（砂）のシェーダー。砂粒や小石・土くれは 3D 細部テクスチャ（createDirtDetail）をワールド座標で引き、
// ハロー掛け（整地）の溝・蹄の跡・大きなムラは 3D ノイズとシェーダーで足す。
// 馬場が渋るほど暗く湿り、不良では水が浮いて空が映る。

const dirtFunctions = (trackHalfWidth: number) => /* glsl */ `
  ${NOISE3D_GLSL}
  ${SURFACE_GLSL}
  uniform sampler3D uDirtDetail;
  varying vec3 vDirtWorld;

  // 走路に散らばる蹄の跡（0..1）
  float hoofPrint(vec2 p) {
    vec2 cell = floor(p * 2.5);
    vec2 f = fract(p * 2.5) - 0.5;
    vec2 jitter = vec2(hash21(cell + 13.1), hash21(cell + 71.7)) - 0.5;
    float present = step(0.55, hash21(cell));
    vec2 q = (f - jitter * 0.4) * vec2(1.0, 1.3);
    // 走路の外では消す
    float onTrack = 1.0 - smoothstep(${(trackHalfWidth - 1.5).toFixed(2)}, ${trackHalfWidth.toFixed(2)}, abs(p.y));
    return present * onTrack * smoothstep(0.17, 0.1, length(q));
  }
`;

const DIRT_COLOR = /* glsl */ `
  vec3 dirtWorld = vDirtWorld;
  vec2 dirtXZ = dirtWorld.xz;
  // 遠くでは細かい模様を平均へ寄せて、ちらつき（エイリアス）を防ぐ
  float dirtFine = 1.0 - clamp(length(fwidth(dirtXZ)) * 6.0, 0.0, 1.0);

  // 3D 細部テクスチャ（createDirtDetail）を地面の (x, z) で引く。奥行き方向は低周波ノイズで動かして
  // 場所ごとに別のスライスを使い、タイルの繰り返しを崩す（隣のスライスとはなめらかにつながる）
  float dirtSlice = noise3(vec3(dirtXZ * 0.03, 0.71)).r;
  vec3 dirtCoordA = vec3(dirtXZ / 1.5, dirtSlice);
  vec3 dirtCoordB = vec3(vec2(dirtXZ.y, -dirtXZ.x) / 4.3, dirtSlice + 0.5);
  vec4 dirtSampA = texture(uDirtDetail, dirtCoordA);
  vec4 dirtSampB = texture(uDirtDetail, dirtCoordB);

  // 3D ノイズ（noise3）による大きなムラとハローの溝の揺らぎ
  float dirtBroad = noise3(vec3(dirtXZ * 0.015, 0.2)).r * 0.6 + noise3(vec3(dirtXZ * 0.06, 0.6)).g * 0.4;
  // ハロー掛けで走る方向に沿ってついた細い溝（少し蛇行させる）
  float harrowWobble = (noise3(vec3(dirtXZ.x * 0.02, dirtXZ.y * 0.1, 0.3)).r - 0.5) * 3.0;
  float dirtHarrowPhase = dirtXZ.y * 24.0 + harrowWobble;
  float dirtHarrow = sin(dirtHarrowPhase) * dirtFine;
  float dirtHoof = hoofPrint(dirtXZ) * dirtFine;
  // 水たまり: ムラの低いところに水が浮く。重でぽつぽつ出始め、不良でも 1 割ほど（走路の大半は水を含んだ砂のまま）
  float dirtLow = dirtBroad - 0.25 * (noise3(vec3(dirtXZ * 0.2, 0.8)).g - 0.5);
  // 3D ノイズは値の幅が狭め（平均 0.5 付近に集まる）なので、しきい値を高めにとる
  float dirtPuddle = smoothstep(0.0, 0.03, 0.385 - (1.0 - uWetness) * 0.3 - dirtLow);

  diffuseColor.rgb *= mix(dirtSampA.rgb, dirtSampB.rgb, 0.35);
  diffuseColor.rgb *= 1.0 + (dirtBroad - 0.5) * 0.25 + dirtHarrow * 0.05 - dirtHoof * 0.22;
  // 水を含むほど暗く、赤みを帯びる。水たまりの底はさらに暗い（色は空の映り込みで決まる）
  diffuseColor.rgb *= mix(vec3(1.0), vec3(0.5, 0.42, 0.36), uWetness);
  diffuseColor.rgb *= 1.0 - dirtPuddle * 0.6;
`;

const DIRT_ROUGHNESS = /* glsl */ `
  // 濡れた砂の艶は粒の凹凸で散るので、太陽の照り返しは広く淡くにじむ程度（鏡のように光らせない）
  roughnessFactor = mix(roughnessFactor, 0.62, uWetness);
  // 泥水の水たまりも、さざ波と濁りで真っ白な点にはならない
  roughnessFactor = mix(roughnessFactor, 0.16, dirtPuddle);
`;

const DIRT_NORMAL = /* glsl */ `
  // 砂粒・小石の凹凸（3D テクスチャの高さ A。最大 3cm 相当）と溝で陰影をつける。遠くでは平らに寄せる
  float dirtHeight = mix(dirtSampA.a, dirtSampB.a, 0.35) * 0.03 * dirtFine;
  vec3 dirtNormal = bumpNormal(vDirtWorld, vec3(0.0, 1.0, 0.0), dirtHeight);

  dirtNormal.z -= cos(dirtHarrowPhase) * 0.18 * dirtFine;
  dirtNormal = normalize(dirtNormal);
  dirtNormal = mix(dirtNormal, vec3(0.0, 1.0, 0.0), dirtPuddle);
  // 水たまりのさざ波（3D ノイズの時間送り）
  vec3 rippleP = vec3(dirtXZ * 1.5, uTime * 0.6);
  dirtNormal.xz += (vec2(
    noise3(rippleP).r,
    noise3(rippleP + vec3(1.7, 3.2, 0.5)).g
  ) - 0.5) * 0.08 * dirtPuddle;
  dirtNormal = normalize(dirtNormal);
  normal = normalize((viewMatrix * vec4(dirtNormal, 0.0)).xyz);
`;

export interface DirtMaterialOptions {
  /** 砂の色と凹凸 */
  detail: GroundDetail;
  /** 蹄の跡をつける走路の半幅（z） */
  trackHalfWidth: number;
}

export const createDirtMaterial = (uniforms: CourseUniforms, options: DirtMaterialOptions) => {
  // 地の色は細部テクスチャが持つので、マテリアルの色は白にしておく
  const material = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 0.95 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, {
      uDirtDetail: { value: options.detail.texture },
      uNoise3D: { value: getNoise3D() },
    });
    shader.vertexShader =
      "varying vec3 vDirtWorld;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\n  vDirtWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;"
      );
    shader.fragmentShader =
      dirtFunctions(options.trackHalfWidth) +
      shader.fragmentShader
        .replace("#include <map_fragment>", "#include <map_fragment>\n" + DIRT_COLOR)
        .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n" + DIRT_ROUGHNESS)
        .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\n" + DIRT_NORMAL)
        // 湿った砂はほんのり、水たまりは空を映す。泥水なので鏡ほどは映さない（曇天の明るい空がそのまま白く浮かないように）
        .replace(
          "#include <opaque_fragment>",
          "outgoingLight = wetReflection(outgoingLight, vDirtWorld, dirtNormal, dirtPuddle * 0.5 + uWetness * 0.05);\n#include <opaque_fragment>"
        );
  };
  return material;
};

