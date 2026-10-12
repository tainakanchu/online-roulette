import * as THREE from "three";
import type { RaceWind } from "../../../utils/raceWind";
import type { CourseUniforms } from "./surfaceCommon";

// 競馬場に吹く風。向きと平均の強さ（utils/raceWind.ts）から、時刻と場所ごとの風を求める。
// 旗と尻尾の物理（clothFlag.ts・tailPhysics.ts）はここで求めた風を受け、芝と木のシェーダーには向きと強さを渡す。
//
// 風は一定ではなく、
// - 突風（強弱のうねり）は風下へ流れていくので、風上の旗ほど先にはためき、少し遅れて風下の旗が続く
// - 向きもゆっくり振れる
// - 細かな乱れが横と上下に混じる

/** 1m ≒ 1.5 ワールド単位 */
const UNITS_PER_METER = 1.5;

export class CourseWind {
  /** 風が吹いていく向き（x-z 平面。+X がゴールへ向かう向き、+Z が内馬場） */
  private readonly direction = new THREE.Vector2(1, 0);
  /** 平均の風速（ワールド単位/秒） */
  private speed = 3 * UNITS_PER_METER;

  constructor(private readonly uniforms: CourseUniforms) {}

  set(wind: RaceWind) {
    const rad = THREE.MathUtils.degToRad(wind.directionDeg);
    this.direction.set(Math.cos(rad), Math.sin(rad));
    this.speed = wind.speedMps * UNITS_PER_METER;
    this.uniforms.uWindDir.value.copy(this.direction);
    // 芝と木の揺れの大きさ。風速 3m/s を 1 とし、無風でも少しは揺れる
    this.uniforms.uWindStrength.value = THREE.MathUtils.clamp(wind.speedMps / 3, 0.35, 2.4);
  }

  /**
   * 時刻 time・位置 position の風（ワールド単位/秒）
   */
  sample(position: THREE.Vector3, time: number, out: THREE.Vector3) {
    const along = position.x * this.direction.x + position.z * this.direction.y;
    // 突風は風速ほどの速さで風下へ流れていく
    const t = time - along / (this.speed + 2);
    const gust =
      1 + 0.25 * Math.sin(t * 0.7) + 0.12 * Math.sin(t * 1.9 + 1.3) + 0.45 * Math.max(0, Math.sin(t * 0.23 + 2)) ** 3;
    // 向きのゆっくりした振れ
    const veer = 0.18 * Math.sin(t * 0.11 + 0.5) + 0.06 * Math.sin(t * 0.9 + position.z * 0.05);
    const cos = Math.cos(veer);
    const sin = Math.sin(veer);
    const dx = this.direction.x * cos - this.direction.y * sin;
    const dz = this.direction.x * sin + this.direction.y * cos;
    const speed = this.speed * gust;
    // 細かな乱れ（風向きに直角な横と、上下）
    const swirl = this.speed * 0.12 * Math.sin(t * 2.3 + position.x * 0.2);
    const lift = this.speed * 0.06 * Math.sin(t * 1.7 + position.z * 0.3);
    return out.set(dx * speed - dz * swirl, lift, dz * speed + dx * swirl);
  }
}
