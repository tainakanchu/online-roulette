/**
 * ブラウザ環境でのランダム性検証テスト
 */

import { cryptoRandom, createDefaultRouletteLogic } from "../logic/roulette";

describe("Browser Randomness Analysis", () => {
  beforeAll(() => {
    // ブラウザ環境をシミュレート
    if (!global.crypto) {
      global.crypto = {
        getRandomValues: (array: Uint32Array) => {
          // Node.js環境での疑似実装
          for (let i = 0; i < array.length; i++) {
            array[i] = Math.floor(Math.random() * 0xffffffff);
          }
          return array;
        },
      } as Crypto;
    }
  });

  it("初期回転角度の偏りを検証", () => {
    const options = ["A", "B", "C", "D"];
    const trials = 10000;
    const counts = new Array(options.length).fill(0);
    
    // 常に初期回転角度0から開始する問題をテスト
    for (let i = 0; i < trials; i++) {
      const logic = createDefaultRouletteLogic();
      const { totalRotation } = logic.calculateRotation();
      
      // 初期回転角度を0に固定してテスト
      const initialRotation = 0;
      const finalRotation = initialRotation + totalRotation;
      const selectedIndex = logic.calculateSelectedIndex(options, finalRotation);
      counts[selectedIndex]++;
    }
    
    console.log("\n=== 初期回転角度0固定での分布 ===");
    options.forEach((option, index) => {
      const percentage = (counts[index] / trials * 100).toFixed(2);
      console.log(`${option}: ${counts[index]} (${percentage}%)`);
    });
    
    // 分布の均等性を確認
    counts.forEach(count => {
      const percentage = (count / trials) * 100;
      expect(percentage).toBeGreaterThanOrEqual(20); // 20%以上
      expect(percentage).toBeLessThanOrEqual(30); // 30%以下
    });
  });

  it("セッション間の独立性を検証", () => {
    const options = ["A", "B", "C", "D", "E", "F"];
    const sessionCount = 100;
    const trialsPerSession = 100;
    const sessionResults: number[][] = [];
    
    // 複数セッションをシミュレート
    for (let session = 0; session < sessionCount; session++) {
      const sessionCounts = new Array(options.length).fill(0);
      
      // 各セッションで複数回実行
      for (let trial = 0; trial < trialsPerSession; trial++) {
        const logic = createDefaultRouletteLogic();
        const { totalRotation } = logic.calculateRotation();
        
        // セッション開始時の初期回転角度をランダム化
        const initialRotation = cryptoRandom() * 360;
        const finalRotation = initialRotation + totalRotation;
        const selectedIndex = logic.calculateSelectedIndex(options, finalRotation);
        sessionCounts[selectedIndex]++;
      }
      
      sessionResults.push(sessionCounts);
    }
    
    // セッション間の分散を計算
    const averages = new Array(options.length).fill(0);
    sessionResults.forEach(sessionCounts => {
      sessionCounts.forEach((count, index) => {
        averages[index] += count / sessionCount;
      });
    });
    
    console.log("\n=== セッション間分析結果 ===");
    console.log(`平均分布: ${averages.map(avg => (avg / trialsPerSession * 100).toFixed(1) + '%').join(', ')}`);
    
    // 各セッションの平均が期待値に近いことを確認
    averages.forEach(avg => {
      const percentage = (avg / trialsPerSession) * 100;
      expect(percentage).toBeGreaterThanOrEqual(12); // 12%以上
      expect(percentage).toBeLessThanOrEqual(20); // 20%以下
    });
  });

  it("時間的相関の検証", () => {
    const options = ["A", "B"];
    const trials = 1000;
    const results: number[] = [];
    
    // 連続実行での結果を記録
    for (let i = 0; i < trials; i++) {
      const logic = createDefaultRouletteLogic();
      const { totalRotation } = logic.calculateRotation();
      const finalRotation = totalRotation;
      const selectedIndex = logic.calculateSelectedIndex(options, finalRotation);
      results.push(selectedIndex);
    }
    
    // 連続する結果の相関を計算
    let consecutiveSame = 0;
    for (let i = 1; i < results.length; i++) {
      if (results[i] === results[i - 1]) {
        consecutiveSame++;
      }
    }
    
    const correlationRate = consecutiveSame / (trials - 1);
    console.log(`\n連続同一結果率: ${(correlationRate * 100).toFixed(2)}%`);
    
    // 理想的には50%付近になるべき（完全にランダムな場合）
    // 40-60%の範囲であれば許容範囲
    expect(correlationRate).toBeGreaterThanOrEqual(0.4);
    expect(correlationRate).toBeLessThanOrEqual(0.6);
  });

  it("crypto.getRandomValues() の品質検証", () => {
    const samples = 10000;
    const values: number[] = [];
    
    // 大量のサンプルを生成
    for (let i = 0; i < samples; i++) {
      values.push(cryptoRandom());
    }
    
    // 基本統計の計算
    const mean = values.reduce((sum, val) => sum + val, 0) / samples;
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / samples;
    const stdDev = Math.sqrt(variance);
    
    console.log(`\n=== crypto.getRandomValues() 統計 ===`);
    console.log(`平均: ${mean.toFixed(4)} (期待値: 0.5000)`);
    console.log(`標準偏差: ${stdDev.toFixed(4)} (期待値: 0.2887)`);
    
    // 一様分布の統計的特性を検証
    expect(mean).toBeGreaterThanOrEqual(0.48);
    expect(mean).toBeLessThanOrEqual(0.52);
    expect(stdDev).toBeGreaterThanOrEqual(0.25);
    expect(stdDev).toBeLessThanOrEqual(0.32);
  });
});