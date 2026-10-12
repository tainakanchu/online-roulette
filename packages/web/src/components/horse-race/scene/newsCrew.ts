import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { takeNode, type ModelPart } from "./models";
import { createCueCardTexture } from "./newsCueCardTextures";

// スタジオカメラの横に立つ AD。キャスターに向けてスケッチブックのカンペを掲げる（news-ad.glb）。
//   AD_Body: 頭以外。原点は床
//   AD_Head: 首から上。原点は首の回転の中心
//   AD_Card: スケッチブック。原点は白いページの中心
//   AD_CardPage: 文字を貼るページの面（UV 0..1、前から読める向き）

export interface CueCardText {
  lines: string[];
  accent: number[];
}

export class NewsCrew {
  readonly group = new THREE.Group();
  private readonly head = new THREE.Group();
  private readonly card = new THREE.Group();
  private readonly page: THREE.MeshBasicMaterial;
  private pageTexture: THREE.CanvasTexture | null = null;
  private pageKey = "";
  /** カンペをめくった直後の揺れ（0..1） */
  private flip = 0;
  private time = 0;

  constructor(gltf: GLTF, material: (part: ModelPart) => THREE.Material) {
    // 紙は照明で白飛びしないよう、照明の影響を受けない材質にして明るさを抑える
    this.page = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.86, 0.86, 0.84) });
    const addPart = (name: string, parent: THREE.Object3D, override?: THREE.Material) => {
      const node = takeNode(gltf, name);
      if (!node) return null;
      for (const part of node.parts) {
        const mesh = new THREE.Mesh(part.geometry, override ?? material(part));
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        parent.add(mesh);
      }
      return node.origin;
    };
    const bodyOrigin = addPart("AD_Body", this.group) ?? new THREE.Vector3();
    // 原点（床）を基準に、頭とカンペを置く
    const headOrigin = addPart("AD_Head", this.head);
    if (headOrigin) {
      this.head.position.copy(headOrigin).sub(bodyOrigin);
      this.group.add(this.head);
    }
    const cardOrigin = addPart("AD_Card", this.card);
    if (cardOrigin) {
      this.card.position.copy(cardOrigin).sub(bodyOrigin);
      this.group.add(this.card);
      // ページの面はカンペと一緒に揺らす
      const pageOrigin = new THREE.Group();
      const origin = addPart("AD_CardPage", pageOrigin, this.page);
      if (origin) {
        pageOrigin.position.copy(origin).sub(cardOrigin);
        this.card.add(pageOrigin);
      }
    }
  }

  /** カンペに書くこと。変わったときだけ描き直し、めくった勢いで少し揺らす */
  setCard(text: CueCardText) {
    const key = `${text.lines.join("\n")}|${text.accent.join(",")}`;
    if (key === this.pageKey) return;
    const first = this.pageKey === "";
    this.pageKey = key;
    this.pageTexture?.dispose();
    this.pageTexture = createCueCardTexture(text.lines, { accent: text.accent });
    this.page.map = this.pageTexture;
    this.page.needsUpdate = true;
    if (!first) this.flip = 1;
  }

  update(dt: number) {
    this.time += dt;
    this.flip = Math.max(0, this.flip - dt * 2.2);
    const t = this.time;
    // キャスターの方を見ながら、時計（番組の残り）を気にして少し体を揺らす
    this.head.rotation.set(Math.sin(t * 0.9) * 0.03, Math.sin(t * 0.4) * 0.08, 0);
    const shake = Math.sin(this.flip * 18) * this.flip;
    this.card.rotation.set(-0.12 * this.flip + Math.sin(t * 1.3) * 0.012, 0, shake * 0.08 + Math.sin(t * 0.8) * 0.01);
    this.card.position.y += (Math.sin(t * 1.1) * 0.004 - (this.card.userData.bob ?? 0));
    this.card.userData.bob = Math.sin(t * 1.1) * 0.004;
  }

  dispose() {
    this.pageTexture?.dispose();
    this.page.dispose();
    this.group.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
  }
}
