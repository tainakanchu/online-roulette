import { formatRaceClock, formatRaceTime, marginLabel, winningTimeSeconds } from "../raceResult";

const labels = { nose: "ハナ", head: "アタマ", neck: "クビ", distance: "大差" };

describe("勝ち時計", () => {
  it("芝の良馬場のマイルは 1 分 33 秒台", () => {
    const seconds = winningTimeSeconds(1600, "turf", "firm");
    expect(seconds).toBeGreaterThan(93);
    expect(seconds).toBeLessThan(94);
  });

  it("ダートは芝より遅く、芝は渋るほど遅い", () => {
    expect(winningTimeSeconds(1600, "dirt", "firm")).toBeGreaterThan(winningTimeSeconds(1600, "turf", "firm"));
    expect(winningTimeSeconds(1600, "turf", "soft")).toBeGreaterThan(winningTimeSeconds(1600, "turf", "firm"));
  });

  it("ダートは渋ると少し速くなる", () => {
    expect(winningTimeSeconds(1600, "dirt", "soft")).toBeLessThan(winningTimeSeconds(1600, "dirt", "firm"));
  });
});

describe("時計の表示", () => {
  it("1 分を超えると 分:秒.1/10 秒", () => {
    expect(formatRaceTime(93.54)).toBe("1:33.5");
    expect(formatRaceTime(61.0)).toBe("1:01.0");
  });

  it("1 分未満は 秒.1/10 秒", () => {
    expect(formatRaceTime(59.84)).toBe("59.8");
  });

  it("繰り上がりで 60 秒にならない", () => {
    expect(formatRaceTime(119.97)).toBe("2:00.0");
  });

  it("中継の時計は 分.秒", () => {
    expect(formatRaceClock(65.9)).toBe("1.05");
    expect(formatRaceClock(9.2)).toBe("0.09");
  });
});

describe("着差", () => {
  it("僅差はハナ・アタマ・クビ", () => {
    expect(marginLabel(0.02, labels)).toBe("ハナ");
    expect(marginLabel(0.1, labels)).toBe("アタマ");
    expect(marginLabel(0.2, labels)).toBe("クビ");
  });

  it("2 馬身までは 1/4 刻み", () => {
    expect(marginLabel(0.5, labels)).toBe("1/2");
    expect(marginLabel(0.8, labels)).toBe("3/4");
    expect(marginLabel(1.0, labels)).toBe("1");
    expect(marginLabel(1.3, labels)).toBe("1 1/4");
    expect(marginLabel(1.74, labels)).toBe("1 3/4");
  });

  it("2 馬身を超えると 1/2 刻み、4 馬身からは 1 馬身刻み", () => {
    expect(marginLabel(2.6, labels)).toBe("2 1/2");
    expect(marginLabel(3.1, labels)).toBe("3");
    expect(marginLabel(5.4, labels)).toBe("5");
  });

  it("10 馬身を超えると大差", () => {
    expect(marginLabel(12, labels)).toBe("大差");
  });
});
