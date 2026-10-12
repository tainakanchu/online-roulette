import {
  aheadDistance,
  canMerge,
  followSpeeds,
  formatWeightChange,
  horseWeight,
  lapLength,
  paddockGap,
  sOnUpperStraight,
  stadiumPoint,
  stepRing,
  weightChange,
} from "../paddock";

const shape = { straightHalf: 27, radius: 18 };

describe("パドックの周回路", () => {
  it("1 周は直線 2 本と半円 2 つの長さ", () => {
    expect(lapLength(shape)).toBeCloseTo(108 + 2 * Math.PI * 18);
  });

  it("左回り（上から見て反時計回り）に、+Z 側の直線を +X へ、−Z 側の直線を −X へ進む", () => {
    expect(stadiumPoint(shape, 10)).toMatchObject({ x: 10, z: 18, heading: 0 });
    const far = stadiumPoint(shape, 27 + Math.PI * 18 + 20);
    expect(far.x).toBeCloseTo(7);
    expect(far.z).toBeCloseTo(-18);
    expect(far.heading).toBeCloseTo(Math.PI);
  });

  it("半円の頂点は中心線から半径の所で、向きは直線と直線の間（+X 側の端では −Z へ進む）", () => {
    const end = stadiumPoint(shape, 27 + (Math.PI * 18) / 2);
    expect(end.x).toBeCloseTo(45);
    expect(end.z).toBeCloseTo(0);
    expect(end.heading).toBeCloseTo(Math.PI / 2);
  });

  it("1 周すると元の所に戻り、つなぎ目で途切れない", () => {
    const a = stadiumPoint(shape, 3);
    const b = stadiumPoint(shape, 3 + lapLength(shape));
    expect(b.x).toBeCloseTo(a.x);
    expect(b.z).toBeCloseTo(a.z);
    const before = stadiumPoint(shape, lapLength(shape) - 0.01);
    const after = stadiumPoint(shape, 0.01);
    expect(Math.hypot(before.x - after.x, before.z - after.z)).toBeLessThan(0.05);
  });

  it("内側へずらすと中心に近づく（引き手は馬の左 = 周回の内側を歩く）", () => {
    expect(stadiumPoint(shape, 10, -1.2).z).toBeCloseTo(16.8);
    expect(stadiumPoint(shape, 27 + Math.PI * 18 + 20, -1.2).z).toBeCloseTo(-16.8);
  });

  it("+Z 側の直線の x から、そこの位置 s が求まる", () => {
    expect(stadiumPoint(shape, sOnUpperStraight(shape, 22)).x).toBeCloseTo(22);
    expect(stadiumPoint(shape, sOnUpperStraight(shape, -10)).x).toBeCloseTo(-10);
  });

  it("頭数が少なければ詰めて歩き、多ければ 1 周に均等に並ぶ", () => {
    expect(paddockGap(shape, 3)).toBe(14);
    expect(paddockGap(shape, 18)).toBeCloseTo(lapLength(shape) / 18);
  });
});

describe("馬体重", () => {
  it("420〜540kg 前後の 2kg 刻みで、同じ馬・同じレースなら同じ", () => {
    for (let seed = 1; seed < 200; seed += 7) {
      const weight = horseWeight(seed, 3);
      expect(weight).toBeGreaterThanOrEqual(408);
      expect(weight).toBeLessThanOrEqual(552);
      expect(weight % 2).toBe(0);
      expect(horseWeight(seed, 3)).toBe(weight);
    }
  });

  it("前走からの増減は −12〜+12 の 2kg 刻みで、レースごとに変わる", () => {
    const changes = new Set<number>();
    for (let race = 0; race < 30; race += 1) {
      const change = weightChange(12345, race);
      expect(Math.abs(change)).toBeLessThanOrEqual(12);
      expect(Number.isInteger(change / 2)).toBe(true);
      changes.add(change);
    }
    expect(changes.size).toBeGreaterThan(3);
  });

  it("増減の表示は、増えたら +、減ったら −、変わらなければ 0", () => {
    expect(formatWeightChange(4)).toBe("+4");
    expect(formatWeightChange(-6)).toBe("−6");
    expect(formatWeightChange(0)).toBe("0");
  });
});

describe("パドックの周回（重ならない）", () => {
  const options = { lap: lapLength(shape), gap: 14, minGap: 5, walkSpeed: 2.2 };
  /** settle 秒たってから後の、いちばん近づいた間隔を測る */
  const simulate = (start: number[], seconds: number, settle = 0) => {
    let positions = start;
    let closest = Infinity;
    for (let t = 0; t < seconds; t += 1 / 30) {
      positions = stepRing(positions, followSpeeds(positions, options), 1 / 30, options);
      if (t < settle) continue;
      for (let i = 0; i < positions.length; i += 1) {
        for (let j = 0; j < positions.length; j += 1) {
          if (i !== j) closest = Math.min(closest, aheadDistance(positions[i], positions[j], options.lap));
        }
      }
    }
    return { positions, closest };
  };

  it("詰まって並んだ馬も、前の馬に近づきすぎずに歩き、最後は間隔がそろう", () => {
    const { positions, closest } = simulate([0, 6, 12, 18, 24], 60);
    expect(closest).toBeGreaterThanOrEqual(options.minGap - 1e-6);
    const sorted = [...positions].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) expect(sorted[i] - sorted[i - 1]).toBeCloseTo(options.gap, 0);
  });

  it("近すぎる所から歩き出しても、前の馬が先に進んで間隔が開き、その後は追い越さず重ならない", () => {
    const start = [3, 50, 52, 120, 180, 181];
    const { positions, closest } = simulate(start, 40, 5);
    expect(closest).toBeGreaterThanOrEqual(options.minGap - 1e-6);
    const order = (values: number[]) =>
      values.map((_, i) => i).sort((a, b) => aheadDistance(0, values[a], options.lap) - aheadDistance(0, values[b], options.lap));
    // 1 周の起点をまたいでも、円の上の並び（巡回順）は変わらない
    const before = order(start);
    const after = order(positions);
    const shift = after.indexOf(before[0]);
    expect([...after.slice(shift), ...after.slice(0, shift)]).toEqual(before);
  });

  it("入口の前後に馬がいるときは入らず、空いたら入る", () => {
    const lap = options.lap;
    expect(canMerge([20, 100], 22, lap, 10, 5)).toBe(false);
    expect(canMerge([15, 100], 22, lap, 10, 5)).toBe(false);
    expect(canMerge([40, 100], 22, lap, 10, 5)).toBe(true);
  });
});
