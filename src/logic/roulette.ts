// 暗号学的に安全な乱数生成器
export const cryptoRandom = (): number => {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return array[0] / (0xffffffff + 1);
};

// ルーレットのロジックのインターフェース
export interface RouletteLogic {
  // 回転角度を計算
  calculateRotation: () => {
    totalRotation: number;
    duration: number;
  };
  // 最終的な選択肢のインデックスを計算
  calculateSelectedIndex: (options: string[], finalRotation: number) => number;
}

// 初期回転角度のランダム化（セッション開始時の偏りを防ぐ）
export const generateInitialRotation = (): number => {
  return cryptoRandom() * 360;
};

// デフォルトのルーレットロジック（初期回転角度考慮版）
export const createDefaultRouletteLogic = (
  random: () => number = cryptoRandom,
  initialRotation?: number
): RouletteLogic => ({
  calculateRotation: () => ({
    totalRotation: 3600 + random() * 360, // 10回転 + ランダムな角度
    duration: 5000, // 5秒間
  }),
  calculateSelectedIndex: (options: string[], finalRotation: number) => {
    const sliceAngle = 360 / options.length;
    // 初期回転角度を考慮
    const adjustedRotation = finalRotation + (initialRotation || 0);
    // 時計回りの回転に対して、選択肢は反時計回りにインデックスが増える
    const normalizedRotation = (360 - (adjustedRotation % 360)) % 360;
    const index = Math.floor(normalizedRotation / sliceAngle);
    return index;
  },
});
