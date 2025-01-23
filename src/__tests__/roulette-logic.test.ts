import { createDefaultRouletteLogic } from "../App";

describe("RouletteLogic", () => {
  describe("calculateRotation", () => {
    it("固定の乱数値で一貫した回転角度を返す", () => {
      const mockRandom = () => 0.5; // 固定の乱数値
      const logic = createDefaultRouletteLogic(mockRandom);

      const { totalRotation, duration } = logic.calculateRotation();

      expect(totalRotation).toBe(3600 + 180); // 10回転 + (0.5 * 360)度
      expect(duration).toBe(5000);
    });

    it("異なる乱数値で異なる回転角度を返す", () => {
      const results = new Set();

      // 異なる乱数値で10回テスト
      for (let i = 0; i < 10; i++) {
        const mockRandom = () => i / 10;
        const logic = createDefaultRouletteLogic(mockRandom);
        const { totalRotation } = logic.calculateRotation();
        results.add(totalRotation);
      }

      // 全ての結果が異なることを確認
      expect(results.size).toBe(10);
    });
  });

  describe("calculateSelectedIndex", () => {
    const options = ["A", "B", "C", "D"]; // 4つの選択肢

    it("正しいインデックスを計算する", () => {
      const logic = createDefaultRouletteLogic();

      // 90度ごとに区切られた4つの領域をテスト
      expect(logic.calculateSelectedIndex(options, 0)).toBe(0); // 0度
      expect(logic.calculateSelectedIndex(options, 90)).toBe(1); // 90度
      expect(logic.calculateSelectedIndex(options, 180)).toBe(2); // 180度
      expect(logic.calculateSelectedIndex(options, 270)).toBe(3); // 270度
    });

    it("360度以上の回転でも正しく計算する", () => {
      const logic = createDefaultRouletteLogic();

      // 1回転後の同じ位置で同じインデックスを返すことを確認
      expect(logic.calculateSelectedIndex(options, 360)).toBe(0);
      expect(logic.calculateSelectedIndex(options, 450)).toBe(1);
      expect(logic.calculateSelectedIndex(options, 540)).toBe(2);
    });

    it("選択肢の数が変わっても正しく計算する", () => {
      const logic = createDefaultRouletteLogic();
      const twoOptions = ["A", "B"];
      const sixOptions = ["A", "B", "C", "D", "E", "F"];

      // 2つの選択肢（180度ごと）
      expect(logic.calculateSelectedIndex(twoOptions, 0)).toBe(0);
      expect(logic.calculateSelectedIndex(twoOptions, 180)).toBe(1);

      // 6つの選択肢（60度ごと）
      expect(logic.calculateSelectedIndex(sixOptions, 0)).toBe(0);
      expect(logic.calculateSelectedIndex(sixOptions, 60)).toBe(1);
      expect(logic.calculateSelectedIndex(sixOptions, 120)).toBe(2);
    });
  });
});
