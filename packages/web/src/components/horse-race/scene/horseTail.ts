import * as THREE from "three";

// 馬の尻尾。細長い毛の房（リボン状の板）を束ね、なびきは頂点シェーダーで動かす。
// 房は根元（原点）から -X 方向へ伸びる形で作り、尻尾全体の向き（垂れる・上がる）は親のグループの回転で決める。

const STRANDS = 34;
const SEGMENTS = 8;

/** 種から決まる乱数（mulberry32）。馬ごとに房の長さや広がりを変える */
const seededRandom = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * 尻尾のジオメトリ。房 1 本 = 根元から先まで SEGMENTS 個の区間を持つ細い帯。
 * aStrand: x = 根元 0 〜 先 1、y = 房ごとの位相、z = 房ごとの揺れの大きさ
 */
export const createTailGeometry = (seed: number, length = 0.95) => {
  const random = seededRandom(seed);
  const positions: number[] = [];
  const normals: number[] = [];
  const strands: number[] = [];
  const indices: number[] = [];
  for (let s = 0; s < STRANDS; s += 1) {
    // 根元は小さな円の中に、先へ行くほど外へ広がる
    const angle = random() * Math.PI * 2;
    const rootRadius = Math.sqrt(random()) * 0.05;
    const spread = 0.05 + random() * 0.09;
    const strandLength = length * (0.82 + random() * 0.22);
    const phase = random();
    const amplitude = 0.7 + random() * 0.6;
    const dirY = Math.cos(angle);
    const dirZ = Math.sin(angle);
    const base = positions.length / 3;
    for (let k = 0; k <= SEGMENTS; k += 1) {
      const t = k / SEGMENTS;
      const radius = rootRadius + spread * t * t;
      const x = -strandLength * t;
      const y = dirY * radius;
      const z = dirZ * radius;
      // 帯の幅は根元が太く、先は細い。帯の向きは尻尾の軸を回る接線方向
      const width = 0.034 * (1 - t) + 0.008;
      for (const side of [-1, 1]) {
        positions.push(x, y - dirZ * width * 0.5 * side, z + dirY * width * 0.5 * side);
        // 法線は尻尾の軸から外向き。尻尾全体が 1 本の太い毛束として丸く照らされる
        normals.push(0, dirY, dirZ);
        strands.push(t, phase, amplitude);
      }
      if (k < SEGMENTS) {
        const a = base + k * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("aStrand", new THREE.Float32BufferAttribute(strands, 3));
  geometry.setIndex(indices);
  return geometry;
};

/** 尻尾 1 本ぶんのユニフォーム（馬ごと） */
export interface TailUniforms {
  uTailTime: { value: number };
  /** 走る速さ 0..1（なびき具合） */
  uTailSpeed: { value: number };
}

export const createTailUniforms = (): TailUniforms => ({
  uTailTime: { value: 0 },
  uTailSpeed: { value: 0 },
});

const TAIL_VERTEX = /* glsl */ `
  #include <begin_vertex>
  float tailT = aStrand.x;
  float tailPhase = aStrand.y * 6.2831;
  float tailAmp = aStrand.z;
  float tailEnv = tailT * tailT;
  // 根元から先へ走る波。走るほど速く大きく、止まっているとゆっくり小さく揺れる
  float tailFreq = 2.0 + 9.0 * uTailSpeed;
  float waveY = sin(uTailTime * tailFreq - tailT * 6.5 + tailPhase) * (0.035 + 0.11 * uTailSpeed);
  float waveZ = cos(uTailTime * tailFreq * 0.8 - tailT * 5.0 + tailPhase * 1.7) * (0.03 + 0.07 * uTailSpeed);
  transformed.y += waveY * tailEnv * tailAmp;
  transformed.z += waveZ * tailEnv * tailAmp;
  // 走ると毛先が広がってなびき、止まると先が重みで下へ垂れる（親の回転に対してローカルの -Y が下寄り）
  transformed.yz *= 1.0 + uTailSpeed * 0.7 * tailT;
  transformed.y -= (1.0 - uTailSpeed) * 0.12 * tailEnv;
`;

const TAIL_SHADING = /* glsl */ `
  {
    // 毛の流れに沿った帯状の光沢（Kajiya-Kay）。毛の向き（ローカルの -X）と、光と視線の中間の方向から求める
    #if NUM_DIR_LIGHTS > 0
      vec3 hairTangent = normalize(vTailTangent);
      vec3 hairHalf = normalize(directionalLights[0].direction + normalize(vViewPosition));
      float hairDot = dot(hairTangent, hairHalf);
      float hairSpec = pow(sqrt(max(0.0, 1.0 - hairDot * hairDot)), 60.0);
      outgoingLight += directionalLights[0].color * hairSpec * 0.18 * (0.3 + 0.7 * vTailT);
    #endif
  }
`;

/** 尻尾のマテリアル。毛色は鬣（たてがみ）と同じ色を渡す */
export const createTailMaterial = (color: THREE.ColorRepresentation, uniforms: TailUniforms) => {
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.7, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader =
      "attribute vec3 aStrand;\nuniform float uTailTime;\nuniform float uTailSpeed;\nvarying float vTailT;\nvarying vec3 vTailTangent;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        TAIL_VERTEX + "\n  vTailT = tailT;\n  vTailTangent = normalize((modelViewMatrix * vec4(-1.0, 0.0, 0.0, 0.0)).xyz);"
      );
    shader.fragmentShader =
      "varying float vTailT;\nvarying vec3 vTailTangent;\n" +
      shader.fragmentShader
        // 根元は暗く、毛先は光を透かして少し明るい
        .replace("#include <color_fragment>", "#include <color_fragment>\n  diffuseColor.rgb *= mix(0.55, 1.15, vTailT);")
        // 両面とも外向きの法線のまま照らす（帯の裏表で明暗が反転しないように）
        .replace("#include <normal_fragment_begin>", "#include <normal_fragment_begin>\n  normal = normalize(vNormal);")
        .replace("#include <opaque_fragment>", TAIL_SHADING + "\n#include <opaque_fragment>");
  };
  return material;
};

/**
 * 物理エンジンで動かす尻尾（tailPhysics.ts）のマテリアル。頂点はワールド座標で毎フレーム書き換えるので、頂点シェーダーでは揺らさない。
 * 毛の流れの向き（aTangent、ワールド座標）は頂点ごとに渡し、毛色は頂点カラー（馬ごとに違う）
 */
export const createSimulatedTailMaterial = () => {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader =
      "attribute vec3 aStrand;\nattribute vec3 aTangent;\nvarying float vTailT;\nvarying vec3 vTailTangent;\n" +
      shader.vertexShader.replace(
        "#include <begin_vertex>",
        "#include <begin_vertex>\n  vTailT = aStrand.x;\n  vTailTangent = normalize((viewMatrix * vec4(aTangent, 0.0)).xyz);"
      );
    shader.fragmentShader =
      "varying float vTailT;\nvarying vec3 vTailTangent;\n" +
      shader.fragmentShader
        .replace("#include <color_fragment>", "#include <color_fragment>\n  diffuseColor.rgb *= mix(0.55, 1.15, vTailT);")
        .replace("#include <normal_fragment_begin>", "#include <normal_fragment_begin>\n  normal = normalize(vNormal);")
        .replace("#include <opaque_fragment>", TAIL_SHADING + "\n#include <opaque_fragment>");
  };
  return material;
};

/** 影も揺れに合わせる（影を描くときも同じように頂点を動かす） */
export const createTailDepthMaterial = (uniforms: TailUniforms) => {
  const material = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader =
      "attribute vec3 aStrand;\nuniform float uTailTime;\nuniform float uTailSpeed;\n" +
      shader.vertexShader.replace("#include <begin_vertex>", TAIL_VERTEX);
  };
  return material;
};
