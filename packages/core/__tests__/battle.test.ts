import { drawBattleSequence, tallyBattle } from "../src/battle";

describe("battle", () => {
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
