import * as THREE from "three";

// ニューススタジオの材質の共通部品。
// - 3D テクスチャ（newsMaterialTextures.ts）を座標から引いて、色の明暗・粗さ・凹凸を足す（UV を使わない）
// - 艶のある床に、スタジオを上下反転して描いた映り込みを重ねる（環境マップだけでは LED ビジョンや照明が床に映らない）

export interface DetailOptions {
  texture: THREE.Data3DTexture;
  /** テクスチャ 1 周期の長さ（m） */
  period: number;
  /**
   * どの座標で引くか。world は動かない物（床・デスク）、object は動く物（キャスターの服・髪・肌）。
   * object にすると、頭を回しても模様が体に貼りついたまま動く
   */
  space: "world" | "object";
  /** テクスチャの軸の入れ替え（例: "yxz" で木目を横向きに） */
  swizzle?: string;
  /** diffuseColor を変える GLSL。vec4 detail（各チャンネル 0..1）が使える */
  color?: string;
  /** roughnessFactor を変える GLSL。vec4 detail が使える */
  roughness?: string;
  /** 高さ（detail.a）による凹凸の強さ。0 で凹凸なし */
  bump?: number;
}

/**
 * MeshStandardMaterial / MeshPhysicalMaterial に 3D テクスチャの質感を足す。
 * Why not: UV で 2D テクスチャを貼ると、Blender のモデルに UV 展開が要り、継ぎ目も出る。座標から引けば UV も継ぎ目もいらない
 */
export const addDetail = <T extends THREE.MeshStandardMaterial>(material: T, options: DetailOptions): T => {
  const swizzle = options.swizzle ?? "xyz";
  const bump = options.bump ?? 0;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDetail = { value: options.texture };
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vDetailPos;`
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vec3 detailSource = ${options.space === "world" ? "(modelMatrix * vec4(transformed, 1.0)).xyz" : "transformed"};
        vDetailPos = detailSource.${swizzle} * ${(1 / options.period).toFixed(6)};`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform highp sampler3D uDetail;
        varying vec3 vDetailPos;
        // 高さの勾配から法線を傾ける（three.js の bumpmap と同じ求め方。UV がいらない）
        vec3 detailBump(vec3 surfPos, vec3 surfNorm, vec2 dHdxy, float faceDir) {
          vec3 sigmaX = dFdx(surfPos);
          vec3 sigmaY = dFdy(surfPos);
          vec3 r1 = cross(sigmaY, surfNorm);
          vec3 r2 = cross(surfNorm, sigmaX);
          float det = dot(sigmaX, r1) * faceDir;
          vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
          return normalize(abs(det) * surfNorm - grad);
        }`
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        vec4 detail = texture(uDetail, vDetailPos);
        ${options.color ?? ""}`
      )
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>
        ${options.roughness ?? ""}`
      );
    if (bump > 0) {
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
        {
          float h = detail.a;
          vec2 dHdxy = vec2(dFdx(h), dFdy(h)) * ${bump.toFixed(4)};
          normal = detailBump(-vViewPosition, normal, dHdxy, faceDirection);
        }`
      );
    }
  };
  material.customProgramCacheKey = () =>
    `detail:${options.space}:${swizzle}:${bump}:${options.period}:${options.color ?? ""}:${options.roughness ?? ""}`;
  return material;
};

/**
 * 水平な床への映り込み。カメラを床で上下反転した位置からスタジオを描き、床のシェーダーで投影して重ねる
 * （three.js の Reflector と同じ求め方。床の材質は照明の効く MeshPhysicalMaterial のまま使いたいので、描く部分だけ自前にする）
 */
export class PlanarReflection {
  readonly target: THREE.WebGLRenderTarget;
  readonly textureMatrix = new THREE.Matrix4();
  /** 床のシェーダーに渡す値（大きさが変わっても同じオブジェクトを書き換える） */
  readonly uniforms: {
    uReflection: { value: THREE.Texture };
    uReflectionMatrix: { value: THREE.Matrix4 };
    uReflectionTexel: { value: THREE.Vector2 };
  };
  private readonly mirrorCamera = new THREE.PerspectiveCamera();
  private readonly plane = new THREE.Plane();
  private readonly clipPlane = new THREE.Vector4();
  private readonly q = new THREE.Vector4();
  private readonly cameraPosition = new THREE.Vector3();
  private readonly rotation = new THREE.Matrix4();
  private readonly lookAt = new THREE.Vector3();
  private readonly view = new THREE.Vector3();
  private readonly target3 = new THREE.Vector3();
  private readonly normal = new THREE.Vector3(0, 1, 0);
  private readonly point = new THREE.Vector3();

  /** @param height 床の高さ */
  constructor(height: number) {
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 2 });
    this.target.texture.generateMipmaps = false;
    this.point.set(0, height, 0);
    this.uniforms = {
      uReflection: { value: this.target.texture },
      uReflectionMatrix: { value: this.textureMatrix },
      uReflectionTexel: { value: new THREE.Vector2(1, 1) },
    };
  }

  setSize(width: number, height: number) {
    // 映り込みはぼかして使うので半分の解像度で足りる
    const w = Math.max(1, Math.round(width / 2));
    const h = Math.max(1, Math.round(height / 2));
    this.target.setSize(w, h);
    this.uniforms.uReflectionTexel.value.set(1 / w, 1 / h);
  }

  /** 床（hidden）を隠して、上下反転したカメラからスタジオを描く */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, hidden: THREE.Object3D[]) {
    this.cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    this.view.subVectors(this.point, this.cameraPosition);
    // 床の下から見ているときは映らない
    if (this.view.dot(this.normal) > 0) return;
    this.view.reflect(this.normal).negate().add(this.point);
    this.rotation.extractRotation(camera.matrixWorld);
    this.lookAt.set(0, 0, -1).applyMatrix4(this.rotation).add(this.cameraPosition);
    this.target3.subVectors(this.point, this.lookAt).reflect(this.normal).negate().add(this.point);

    const mirror = this.mirrorCamera;
    mirror.position.copy(this.view);
    mirror.up.set(0, 1, 0).applyMatrix4(this.rotation).reflect(this.normal);
    mirror.lookAt(this.target3);
    mirror.far = camera.far;
    mirror.updateMatrixWorld();
    mirror.projectionMatrix.copy(camera.projectionMatrix);

    this.textureMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.textureMatrix.multiply(mirror.projectionMatrix).multiply(mirror.matrixWorldInverse);

    // 床より下のものを描かないよう、投影行列の近い面を床の面にする（斜めのクリップ面）
    this.plane.setFromNormalAndCoplanarPoint(this.normal, this.point).applyMatrix4(mirror.matrixWorldInverse);
    this.clipPlane.set(this.plane.normal.x, this.plane.normal.y, this.plane.normal.z, this.plane.constant);
    const projection = mirror.projectionMatrix;
    const e = projection.elements;
    this.q.set(
      (Math.sign(this.clipPlane.x) + e[8]) / e[0],
      (Math.sign(this.clipPlane.y) + e[9]) / e[5],
      -1,
      (1 + e[10]) / e[14]
    );
    this.clipPlane.multiplyScalar(2 / this.clipPlane.dot(this.q));
    e[2] = this.clipPlane.x;
    e[6] = this.clipPlane.y;
    e[10] = this.clipPlane.z + 1 - 0.003;
    e[14] = this.clipPlane.w;

    const previousTarget = renderer.getRenderTarget();
    const previousShadow = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    hidden.forEach((object) => (object.visible = false));
    renderer.setRenderTarget(this.target);
    renderer.clear();
    renderer.render(scene, mirror);
    hidden.forEach((object) => (object.visible = true));
    renderer.setRenderTarget(previousTarget);
    renderer.shadowMap.autoUpdate = previousShadow;
  }

  dispose() {
    this.target.dispose();
  }
}

/**
 * 床の材質に映り込みを重ねる。粗い所ほどぼかし、斜めから見るほど強く映す（フレネル）
 * @param strength 映り込みの強さ（磨いた石の床で 0.5 前後）
 */
export const addFloorReflection = <T extends THREE.MeshStandardMaterial>(
  material: T,
  reflection: PlanarReflection,
  strength: number
): T => {
  const previous = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    Object.assign(shader.uniforms, reflection.uniforms);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform mat4 uReflectionMatrix;
        varying vec4 vReflectionUv;`
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        vReflectionUv = uReflectionMatrix * modelMatrix * vec4(transformed, 1.0);`
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        uniform sampler2D uReflection;
        uniform vec2 uReflectionTexel;
        varying vec4 vReflectionUv;`
      )
      .replace(
        "#include <opaque_fragment>",
        `{
          // 凹凸で傾いた分だけ映り込みをゆがめ、粗さに応じて 9 点でぼかす
          vec2 uv = vReflectionUv.xy / vReflectionUv.w + (normal - nonPerturbedNormal).xy * 0.05;
          float spread = 1.5 + roughnessFactor * 26.0;
          vec3 mirror = vec3(0.0);
          for (int i = -1; i <= 1; i++) {
            for (int j = -1; j <= 1; j++) {
              mirror += texture2D(uReflection, uv + vec2(float(i), float(j)) * uReflectionTexel * spread).rgb;
            }
          }
          mirror /= 9.0;
          float facing = 1.0 - saturate(dot(normalize(vViewPosition), normal));
          float fresnel = 0.25 + 0.75 * pow(facing, 3.0);
          float gloss = 1.0 - smoothstep(0.15, 0.7, roughnessFactor);
          outgoingLight += mirror * fresnel * gloss * ${strength.toFixed(3)};
        }
        #include <opaque_fragment>`
      );
  };
  const previousKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${previousKey()}:reflection`;
  return material;
};
