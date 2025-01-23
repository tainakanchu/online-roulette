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

    it("100000回の試行での選択分布を確認する", () => {
      const options = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]; // 10個の選択肢
      const counts: { [key: string]: number } = {};
      options.forEach((option) => (counts[option] = 0));

      const logic = createDefaultRouletteLogic();
      const trials = 100000;

      // 100000回試行
      for (let i = 0; i < trials; i++) {
        // 毎回新しい回転を計算（前回の回転は考慮しない）
        const { totalRotation } = logic.calculateRotation();
        // 最終的な角度のみを使用して選択肢を決定
        const finalRotation = totalRotation % 360;
        const selectedIndex = logic.calculateSelectedIndex(
          options,
          finalRotation
        );
        counts[options[selectedIndex]]++;
      }

      // 結果を出力
      console.log("\n=== 100000回の試行結果 ===");
      console.log("選択肢 | 回数 | 割合(%)");
      console.log("------------------------");
      Object.entries(counts).forEach(([option, count]) => {
        const percentage = ((count / trials) * 100).toFixed(2);
        console.log(`${option} | ${count} | ${percentage}%`);
      });

      // 各選択肢が全体の8%から12%の間に収まっていることを確認
      // (完全な一様分布では10%になるはず)
      Object.values(counts).forEach((count) => {
        const percentage = (count / trials) * 100;
        expect(percentage).toBeGreaterThanOrEqual(8);
        expect(percentage).toBeLessThanOrEqual(12);
      });
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
