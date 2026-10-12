import * as THREE from "three";
import { NOISE3D_GLSL, noise3DUniform } from "./noise3d";

// 遠景のシェーダー（丘・コースの外側の地面）。
// 共有の 3D テクスチャ（noise3）をワールド座標で大きく引いて、森と草地の塊・畑のような濃淡を作る。

const WORLD_VERTEX = /* glsl */ `
  #include <begin_vertex>
  vLandWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

const HILL_COLOR = /* glsl */ `
  {
    vec3 p = vLandWorld;
    // 山肌の 3D テクスチャ（mountainTextures.ts）を 2 つの大きさで引く。
    //   R: 樹冠の凹凸  G: 植生（0 草地・畑 / 0.5 広葉樹 / 1 針葉樹）  B: 尾根と谷筋  A: 岩・裸地・林道
    vec4 fine = texture(uMountainDetail, p / 60.0);
    vec4 broad = texture(uMountainDetail, p / 240.0 + 0.37);
    // 植生は大きな分布を主にし、高い所ほど針葉樹に寄せる
    float vegetation = clamp(mix(broad.g, fine.g, 0.3) + smoothstep(25.0, 70.0, p.y) * 0.3, 0.0, 1.0);
    vec3 meadow = vec3(0.17, 0.27, 0.09) * (0.85 + 0.3 * fine.r);
    vec3 broadleaf = vec3(0.05, 0.13, 0.04);
    vec3 conifer = vec3(0.02, 0.06, 0.03);
    vec3 color = vegetation < 0.5
      ? mix(meadow, broadleaf, smoothstep(0.25, 0.5, vegetation))
      : mix(broadleaf, conifer, smoothstep(0.55, 0.85, vegetation));
    // 森では樹冠の丸い凹凸が明暗になる（草地は平ら）
    float forest = smoothstep(0.3, 0.5, vegetation);
    color *= mix(1.0, 0.55 + 0.9 * fine.r, forest);
    // 谷筋は暗く、尾根は明るい
    color *= 0.72 + 0.4 * mix(broad.b, fine.b, 0.5);
    // 岩場・伐採地・林道
    color = mix(color, vec3(0.26, 0.24, 0.2), smoothstep(0.7, 0.95, fine.a) * 0.6);
    diffuseColor.rgb = color;
  }
`;

/** 遠くの丘（なめらかな球をつぶした形）。山肌は 3D テクスチャ（createMountainDetail）で描く */
export const createHillMaterial = (detail: THREE.Data3DTexture) => {
  const material = new THREE.MeshStandardMaterial({ color: "#ffffff", roughness: 1 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, noise3DUniform(), { uMountainDetail: { value: detail } });
    shader.vertexShader = "varying vec3 vLandWorld;\n" + shader.vertexShader.replace("#include <begin_vertex>", WORLD_VERTEX);
    shader.fragmentShader =
      "varying vec3 vLandWorld;\nuniform sampler3D uMountainDetail;\n" +
      NOISE3D_GLSL +
      shader.fragmentShader.replace("#include <color_fragment>", "#include <color_fragment>\n" + HILL_COLOR);
  };
  return material;
};

const GROUND_COLOR = /* glsl */ `
  {
    vec3 p = vLandWorld;
    // 草の濃淡の大きな塊と、ところどころ乾いて黄ばんだ場所
    float patchy = noise3(p * 0.006).r * 0.6 + noise3(p * 0.03).g * 0.4;
    float dry = smoothstep(0.55, 0.75, noise3(p * 0.0025 + 0.5).r);
    diffuseColor.rgb *= 0.8 + 0.4 * patchy;
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.25, 1.1, 0.7), dry * 0.6);
  }
`;

/** コースの外側の地面。芝のタイルテクスチャの繰り返しを大きなムラで隠す */
export const createFarGroundMaterial = (map: THREE.Texture) => {
  const material = new THREE.MeshStandardMaterial({ map, roughness: 0.95 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, noise3DUniform());
    shader.vertexShader = "varying vec3 vLandWorld;\n" + shader.vertexShader.replace("#include <begin_vertex>", WORLD_VERTEX);
    shader.fragmentShader =
      "varying vec3 vLandWorld;\n" +
      NOISE3D_GLSL +
      shader.fragmentShader.replace("#include <map_fragment>", "#include <map_fragment>\n" + GROUND_COLOR);
  };
  return material;
};
