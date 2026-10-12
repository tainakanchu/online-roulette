import { changeWindForGoing, createRaceWind, stretchWind } from "../raceWind";

const fixed = (...values: number[]) => {
  let i = 0;
  return () => values[i++ % values.length];
};

describe("createRaceWind", () => {
  it("馬場が渋るほど強い風になる（良は 1〜3m/s、不良は 5〜8m/s の範囲）", () => {
    expect(createRaceWind("firm", fixed(0.5, 0)).speedMps).toBe(1);
    expect(createRaceWind("firm", fixed(0.5, 0.999)).speedMps).toBe(3);
    expect(createRaceWind("soft", fixed(0.5, 0)).speedMps).toBe(5);
    expect(createRaceWind("soft", fixed(0.5, 0.999)).speedMps).toBe(8);
  });

  it("向きは 0 以上 360 未満の整数の角度になる", () => {
    const wind = createRaceWind("good", fixed(0.9999, 0.5));
    expect(wind.directionDeg).toBeGreaterThanOrEqual(0);
    expect(wind.directionDeg).toBeLessThan(360);
    expect(Number.isInteger(wind.directionDeg)).toBe(true);
  });
});

describe("changeWindForGoing", () => {
  it("馬場状態を変えても風向きは変わらず、強さだけがその馬場の範囲に入る", () => {
    const wind = { directionDeg: 123, speedMps: 2 };
    const changed = changeWindForGoing(wind, "soft", fixed(0.5));
    expect(changed.directionDeg).toBe(123);
    expect(changed.speedMps).toBeGreaterThanOrEqual(5);
    expect(changed.speedMps).toBeLessThanOrEqual(8);
  });
});

describe("stretchWind", () => {
  it("ゴールへ向かって吹けば追い風、逆なら向かい風、横から吹けば横風になる", () => {
    expect(stretchWind({ directionDeg: 10, speedMps: 3 })).toBe("tailwind");
    expect(stretchWind({ directionDeg: 350, speedMps: 3 })).toBe("tailwind");
    expect(stretchWind({ directionDeg: 180, speedMps: 3 })).toBe("headwind");
    expect(stretchWind({ directionDeg: 90, speedMps: 3 })).toBe("crosswind");
    expect(stretchWind({ directionDeg: 260, speedMps: 3 })).toBe("crosswind");
  });
});
