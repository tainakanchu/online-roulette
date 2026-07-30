import {
  drawBattleCounts,
  drawBattleSequence,
  tallyBattle,
  type RandomFiller,
} from "../src/battle";

// 与えた Uint32 値を順番に繰り返し書き込む filler
const cyclingFiller = (values: number[]): RandomFiller => {
  let call = 0;
  return (target) => {
    for (let i = 0; i < target.length; i += 1) {
      target[i] = values[call++ % values.length];
    }
  };
};

describe("battle", () => {
  describe("drawBattleCounts", () => {
    it("合計が drawCount になる", () => {
      const counts = drawBattleCounts({ optionCount: 4, drawCount: 5000 });
      expect(counts).toHaveLength(4);
      expect(counts.reduce((a, b) => a + b, 0)).toBe(5000);
      counts.forEach((count) => expect(count).toBeGreaterThanOrEqual(0));
    });

    it("fillRandom を差し替えると決定的な結果を返す", () => {
      const quarter = 0x40000000;
      const counts = drawBattleCounts({
        optionCount: 4,
        drawCount: 8,
        fillRandom: cyclingFiller([0, quarter, quarter * 2, quarter * 3]),
      });
      expect(counts).toEqual([2, 2, 2, 2]);
    });

    it("chunkSize を跨いでも全数を集計する", () => {
      const counts = drawBattleCounts({
        optionCount: 3,
        drawCount: 10,
        chunkSize: 3,
        fillRandom: cyclingFiller([0]),
      });
      expect(counts).toEqual([10, 0, 0]);
    });

    it("onProgress が累積の processed を通知し、最後は drawCount になる", () => {
      const processedLog: number[] = [];
      drawBattleCounts({
        optionCount: 2,
        drawCount: 10,
        chunkSize: 3,
        fillRandom: cyclingFiller([0]),
        onProgress: (processed) => processedLog.push(processed),
      });
      expect(processedLog).toEqual([3, 6, 9, 10]);
    });

    it("optionCount が 0 なら空配列", () => {
      expect(drawBattleCounts({ optionCount: 0, drawCount: 10 })).toEqual([]);
    });

    it("drawCount が 0 なら全てゼロ", () => {
      expect(drawBattleCounts({ optionCount: 3, drawCount: 0 })).toEqual([
        0, 0, 0,
      ]);
    });

    it("optionCount の範囲外を選ばない（上端の乱数値でも）", () => {
      const counts = drawBattleCounts({
        optionCount: 3,
        drawCount: 4,
        fillRandom: cyclingFiller([0xffffffff]),
      });
      expect(counts).toEqual([0, 0, 4]);
    });
  });

  describe("drawBattleSequence", () => {
    it("指定された回数分の index を返す", () => {
      const sequence = drawBattleSequence(4, 100);
      expect(sequence).toHaveLength(100);
      sequence.forEach((idx) => {
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(idx).toBeLessThan(4);
        expect(Number.isInteger(idx)).toBe(true);
      });
    });

    it("optionCount が 0 なら空配列", () => {
      expect(drawBattleSequence(0, 10)).toEqual([]);
    });

    it("drawCount が 0 なら空配列", () => {
      expect(drawBattleSequence(5, 0)).toEqual([]);
    });

    it("random を差し替えると決定的な結果を返す", () => {
      let call = 0;
      const values = [0.0, 0.25, 0.5, 0.75, 0.999];
      const mockRandom = () => values[call++ % values.length];
      const sequence = drawBattleSequence(4, 5, mockRandom);
      expect(sequence).toEqual([0, 1, 2, 3, 3]);
    });
  });

  describe("tallyBattle", () => {
    it("各 index の出現回数を集計する", () => {
      const counts = tallyBattle(4, [0, 1, 1, 2, 2, 2, 3, 3, 3, 3]);
      expect(counts).toEqual([1, 2, 3, 4]);
    });

    it("範囲外の index は無視する", () => {
      const counts = tallyBattle(3, [0, 1, 2, 3, -1, 10]);
      expect(counts).toEqual([1, 1, 1]);
    });

    it("draws が空なら全てゼロ", () => {
      expect(tallyBattle(3, [])).toEqual([0, 0, 0]);
    });
  });
});
