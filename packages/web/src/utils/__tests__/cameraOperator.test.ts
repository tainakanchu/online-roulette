import { CameraOperator, focusHunt, type OperatorFrame, ZOOM_MAX_RATE } from "../cameraOperator";

const DT = 1 / 60;

/** 決まった並びの乱数（テストで毎回同じ動きにする） */
const seeded = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
};

const fovFor = (distance: number, halfHeight = 3.4) => (2 * Math.atan(halfHeight / distance) * 180) / Math.PI;

const frameOf = (subject: { x: number; z: number }, velocity = { x: 0, z: 0 }): OperatorFrame => {
  const camera = { x: 0, y: 6.5, z: -40 };
  const distance = Math.hypot(subject.x - camera.x, subject.z - camera.z);
  return {
    subject: { x: subject.x, y: 0, z: subject.z },
    subjectVelocity: { x: velocity.x, y: 0, z: velocity.z },
    camera,
    idealFov: fovFor(distance),
    aspect: 1.6,
  };
};

describe("パドック中継のカメラマン（人が手で操作するカメラ）", () => {
  it("止まっている馬なら、合わせた後は向ける所・ズーム・ピントが動かない", () => {
    const operator = new CameraOperator(seeded(1));
    const frame = frameOf({ x: 0, z: 0 });
    operator.snap(frame);
    const before = { ...operator.aim, fov: operator.fov, focus: operator.focusDistance };
    for (let i = 0; i < 300; i += 1) operator.update(DT, frame);
    expect(operator.aim.x).toBeCloseTo(before.x, 6);
    expect(operator.aim.z).toBeCloseTo(before.z, 6);
    expect(operator.fov).toBeCloseTo(before.fov, 6);
    expect(operator.focusDistance).toBeCloseTo(before.focus, 6);
  });

  it("歩く馬は毎フレームぴったり追わず、ずれが許せる範囲を超えてから振って直す", () => {
    const operator = new CameraOperator(seeded(2));
    const velocity = { x: 1.5, z: 0 };
    let subject = { x: -10, z: 0 };
    operator.snap(frameOf(subject, velocity));
    let jumps = 0;
    let maxDrift = 0;
    for (let i = 0; i < 600; i += 1) {
      subject = { x: subject.x + velocity.x * DT, z: 0 };
      const previous = operator.aim.x;
      operator.update(DT, frameOf(subject, velocity));
      const step = operator.aim.x - previous;
      // 振り続ける分（1 フレームに 1.5 / 60 ほど）より大きく動いたら、直したとみなす
      if (Math.abs(step) > 0.1) jumps += 1;
      maxDrift = Math.max(maxDrift, Math.abs(subject.x - operator.aim.x));
    }
    expect(jumps).toBeGreaterThan(0);
    expect(maxDrift).toBeGreaterThan(0.3);
    // 画面の幅（40 先で画角およそ 9.7 度・横長 1.6 倍 → 幅 10.9）の 2 割より大きくはずれない
    expect(maxDrift).toBeLessThan(2.2);
  });

  it("ズームは一気に変わらず、1 秒あたりの変化に上限がある", () => {
    const operator = new CameraOperator(seeded(3));
    operator.snap(frameOf({ x: 0, z: 0 }));
    // 馬が近づいて、ちょうどよい画角が倍になった
    const near = { ...frameOf({ x: 0, z: 0 }), idealFov: operator.fov * 2 };
    let previous = Math.log(operator.fov);
    for (let i = 0; i < 360; i += 1) {
      operator.update(DT, near);
      const current = Math.log(operator.fov);
      expect(Math.abs(current - previous)).toBeLessThanOrEqual(ZOOM_MAX_RATE * DT + 1e-9);
      previous = current;
    }
    // 6 秒あれば、見当違いのずれ（ときどき大きく外す分）の範囲まで合わせ終わる
    expect(Math.abs(Math.log(operator.fov / near.idealFov))).toBeLessThan(0.25);
  });

  it("次の馬へ振ると決めても、気づくまでは前の馬を向いたまま。その後は次の馬へ振る", () => {
    const operator = new CameraOperator(seeded(4));
    operator.snap(frameOf({ x: 0, z: 0 }));
    operator.retarget();
    const next = frameOf({ x: 12, z: 6 });
    // 気づくまで（最短 0.2 秒）は動かない
    for (let i = 0; i < 11; i += 1) operator.update(DT, next);
    expect(operator.aim.x).toBeCloseTo(0, 6);
    for (let i = 0; i < 60; i += 1) operator.update(DT, next);
    expect(Math.hypot(operator.aim.x - 12, operator.aim.z - 6)).toBeLessThan(3);
  });

  it("次の馬へ振ると一度引き（ズームアウト）、見つけてから寄り直す", () => {
    const operator = new CameraOperator(seeded(5));
    const frame = frameOf({ x: 0, z: 0 });
    operator.snap(frame);
    const start = operator.fov;
    operator.retarget();
    let widest = start;
    for (let i = 0; i < 60; i += 1) {
      operator.update(DT, frame);
      widest = Math.max(widest, operator.fov);
    }
    expect(widest).toBeGreaterThan(start * 1.15);
    for (let i = 0; i < 360; i += 1) operator.update(DT, frame);
    expect(Math.abs(Math.log(operator.fov / frame.idealFov))).toBeLessThan(0.25);
  });

  it("ピントは次の馬へ振ってすぐには合わず、探ってから合う", () => {
    const operator = new CameraOperator(seeded(6));
    operator.snap(frameOf({ x: 0, z: 0 }));
    operator.retarget();
    const far = frameOf({ x: 0, z: 25 });
    const distance = 65;
    let worst = 0;
    for (let i = 0; i < 90; i += 1) {
      operator.update(DT, far);
      worst = Math.max(worst, Math.abs(operator.focusDistance - distance) / distance);
    }
    expect(worst).toBeGreaterThan(0.2);
    for (let i = 0; i < 240; i += 1) operator.update(DT, far);
    expect(Math.abs(operator.focusDistance - distance) / distance).toBeLessThan(0.05);
  });

  it("気づくまでの間や探り方は乱数で毎回変わる", () => {
    const run = (seed: number) => {
      const operator = new CameraOperator(seeded(seed));
      operator.snap(frameOf({ x: 0, z: 0 }));
      operator.retarget();
      const next = frameOf({ x: 12, z: 6 });
      const trace: number[] = [];
      for (let i = 0; i < 90; i += 1) {
        operator.update(DT, next);
        trace.push(operator.aim.x, operator.fov, operator.focusDistance);
      }
      return trace;
    };
    expect(run(7)).not.toEqual(run(8));
  });

  it("ピントの探りは、振り出しで外れ、行き過ぎて反対へ外れてから 0 に収まる", () => {
    expect(focusHunt(0, 0.4)).toBe(0);
    expect(focusHunt(0.45, 0.4)).toBeCloseTo(0.4);
    const opposite = Math.min(...[0.6, 0.7, 0.8, 0.9, 1].map((t) => focusHunt(t, 0.4)));
    expect(opposite).toBeLessThan(0);
    expect(Math.abs(focusHunt(3, 0.4))).toBeLessThan(0.001);
  });
});
