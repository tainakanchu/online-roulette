import { CAMERA_PLANS, pickCameraPlan, shotForFraction } from "../raceCamera";

describe("レース中のカメラワークの型", () => {
  it("どの型も、進み具合の小さい順にカットが並び、最後は 1（ゴール）まで", () => {
    for (const plan of CAMERA_PLANS) {
      const untils = plan.cuts.map(([until]) => until);
      expect(untils).toEqual([...untils].sort((a, b) => a - b));
      expect(untils[untils.length - 1]).toBe(1);
    }
  });

  it("どの型も、ゴール前の直線は真横のドリーで並走する（ゴールの瞬間のカットへつなぐ）", () => {
    for (const plan of CAMERA_PLANS) expect(shotForFraction(plan, 0.99)).toBe("stretch");
  });

  it("どの型にも、騎手の目線（ジョッキー視点）のカットが入る", () => {
    for (const plan of CAMERA_PLANS) expect(plan.cuts.some(([, shot]) => shot === "jockey")).toBe(true);
  });

  it("型ごとにカットの並びが違う", () => {
    const sequences = CAMERA_PLANS.map((plan) => plan.cuts.map(([, shot]) => shot).join(","));
    expect(new Set(sequences).size).toBe(CAMERA_PLANS.length);
  });

  it("進み具合からカットが決まる（境目ちょうどは次のカット）", () => {
    const cinema = CAMERA_PLANS[0];
    expect(shotForFraction(cinema, 0)).toBe("chase");
    expect(shotForFraction(cinema, 0.12)).toBe("side");
    expect(shotForFraction(cinema, 0.4)).toBe("aerial");
  });

  it("次のレースでは、前回と違う型を選ぶ", () => {
    for (const previous of CAMERA_PLANS) {
      for (const r of [0, 0.3, 0.6, 0.9999]) {
        expect(pickCameraPlan(previous.id, () => r).id).not.toBe(previous.id);
      }
    }
  });
});
