import { useState, useCallback, useRef, useMemo, useEffect } from "react";

// ランダム選択に関するロジックを分離
interface RouletteLogic {
  // 回転角度を計算
  calculateRotation: () => {
    totalRotation: number;
    duration: number;
  };
  // 最終的な選択肢のインデックスを計算
  calculateSelectedIndex: (options: string[], finalRotation: number) => number;
}

// デフォルトのルーレットロジック
export const createDefaultRouletteLogic = (
  random: () => number = Math.random
): RouletteLogic => ({
  calculateRotation: () => ({
    totalRotation: 3600 + random() * 360, // 10回転 + ランダムな角度
    duration: 5000, // 5秒間
  }),
  calculateSelectedIndex: (options: string[], finalRotation: number) => {
    const sliceAngle = 360 / options.length;
    const normalizedRotation = finalRotation % 360;
    // 時計回りの回転に合わせて計算を修正
    const index = Math.floor(normalizedRotation / sliceAngle);
    return index;
  },
});

// 色の明るさを計算する関数
const getColorBrightness = (hexColor: string): number => {
  // #を除去し、RGBの値を取得
  const rgb = hexColor.replace("#", "").match(/.{2}/g);
  if (!rgb) return 0;

  // 16進数を10進数に変換
  const r = parseInt(rgb[0], 16);
  const g = parseInt(rgb[1], 16);
  const b = parseInt(rgb[2], 16);

  // YIQ式で明るさを計算（人間の目の感度を考慮した重み付け）
  return (r * 299 + g * 587 + b * 114) / 1000;
};

// 30色のカラーパレット
const COLORS = [
  "#FF6B6B", // 赤
  "#4ECDC4", // ターコイズ
  "#45B7D1", // 青
  "#96CEB4", // 薄緑
  "#FFEEAD", // クリーム
  "#FFD93D", // 黄色
  "#6C5CE7", // 紫
  "#A8E6CF", // ミント
  "#FF8B94", // サーモンピンク
  "#A3A1FF", // ラベンダー
  "#FFB6B9", // ピーチ
  "#67E0A3", // エメラルド
  "#FF9A76", // コーラル
  "#88D8B0", // セージグリーン
  "#FFC75F", // オレンジ
  "#B5EAD7", // パステルグリーン
  "#E2F0CB", // ライムグリーン
  "#C7CEEA", // パウダーブルー
  "#FF9AA2", // ローズ
  "#B5B9FF", // パステルパープル
  "#ADE8F4", // スカイブルー
  "#FFB7B2", // ピンク
  "#E0BBE4", // ライラック
  "#957DAD", // モーブ
  "#D4A5A5", // ダスティローズ
  "#9ED2C6", // シーフォーム
  "#FFE5D9", // ピーチクリーム
  "#FED7C3", // アプリコット
  "#F9DCC4", // ベージュ
  "#FEC89A", // メロン
];

function App() {
  const [optionsText, setOptionsText] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const queryOptions = params.get("options");
    return queryOptions ? queryOptions.split(",").join("\n") : "";
  });
  const [currentOption, setCurrentOption] = useState("");
  const [isSpinning, setIsSpinning] = useState(false);
  const [rotation, setRotation] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();

  const options = useMemo(() => {
    return optionsText
      .split("\n")
      .map((option) => option.trim())
      .filter((option) => option.length > 0);
  }, [optionsText]);

  const hasOptions = options.length > 0;

  // URLを更新する関数
  const updateURL = useCallback((text: string) => {
    const options = text
      .split("\n")
      .map((option) => option.trim())
      .filter((option) => option.length > 0)
      .join(",");

    const url = new URL(window.location.href);
    if (options) {
      url.searchParams.set("options", options);
    } else {
      url.searchParams.delete("options");
    }
    window.history.replaceState({}, "", url.toString());
  }, []);

  // テキストエリアの変更時にURLも更新
  const handleOptionsChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newText = e.target.value;
      setOptionsText(newText);
      updateURL(newText);
    },
    [updateURL]
  );

  const drawRoulette = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !hasOptions) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const radius = Math.min(centerX, centerY) - 10;

    // 背景をクリア
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // ルーレットを描画
    const sliceAngle = (2 * Math.PI) / options.length;

    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate((rotation * Math.PI) / 180);

    options.forEach((option, index) => {
      const startAngle = index * sliceAngle;
      const endAngle = startAngle + sliceAngle;
      const color = COLORS[index % COLORS.length];

      // 扇形を描画
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, radius, startAngle, endAngle);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.stroke();

      // テキストを描画（背景色に応じて文字色を変更）
      ctx.save();
      ctx.rotate(startAngle + sliceAngle / 2);
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      // 背景色の明るさに応じて文字色を設定
      ctx.fillStyle = getColorBrightness(color) > 128 ? "#000000" : "#FFFFFF";
      ctx.font = "bold 16px sans-serif";
      ctx.fillText(option, radius - 20, 0);
      ctx.restore();
    });

    ctx.restore();

    // 矢印を描画
    ctx.beginPath();
    ctx.moveTo(centerX + radius + 10, centerY);
    ctx.lineTo(centerX + radius - 10, centerY - 10);
    ctx.lineTo(centerX + radius - 10, centerY + 10);
    ctx.closePath();
    ctx.fillStyle = "#FF0000";
    ctx.fill();
  }, [options, rotation, hasOptions]);

  useEffect(() => {
    drawRoulette();
  }, [drawRoulette]);

  // ルーレットロジックのインスタンスを作成
  const rouletteLogic = useMemo(() => createDefaultRouletteLogic(), []);

  const spin = useCallback(() => {
    if (!hasOptions || isSpinning) return;

    setIsSpinning(true);
    const startRotation = rotation;
    const { totalRotation, duration } = rouletteLogic.calculateRotation();
    const startTime = Date.now();

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = elapsed / duration;

      if (progress < 1) {
        const easeOut = 1 - Math.pow(1 - progress, 4);
        const currentRotation = startRotation + totalRotation * easeOut;
        setRotation(currentRotation);
        animationRef.current = requestAnimationFrame(animate);
      } else {
        const finalRotation = startRotation + totalRotation;
        setRotation(finalRotation);

        const selectedIndex = rouletteLogic.calculateSelectedIndex(
          options,
          finalRotation
        );
        setCurrentOption(options[selectedIndex]);
        setIsSpinning(false);
      }
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [hasOptions, isSpinning, options, rotation, rouletteLogic]);

  return (
    <div className="container">
      <h1>ルーレット</h1>

      <div className="input-section">
        <h2>選択肢を入力</h2>
        <textarea
          value={optionsText}
          onChange={handleOptionsChange}
          placeholder="選択肢を改行で区切って入力してください"
          rows={5}
          className="options-input"
        />
        <p className="help-text">
          ※
          URLのoptionsクエリパラメータでカンマ区切りの選択肢を指定することもできます
          <br />
          例: ?options=選択肢1,選択肢2,選択肢3
        </p>
      </div>

      <div className="roulette-section">
        <div className="canvas-container">
          <canvas
            ref={canvasRef}
            width={400}
            height={400}
            className="roulette-canvas"
          />
        </div>
        <div
          className={`result ${isSpinning ? "spinning" : ""} ${
            currentOption ? "has-result" : ""
          }`}
        >
          <div className="result-content">
            {isSpinning ? (
              <div className="loading-text">選択中...</div>
            ) : currentOption ? (
              <>
                <div className="result-label">結果</div>
                <div className="result-value">{currentOption}</div>
              </>
            ) : (
              <div className="default-text">結果がここに表示されます</div>
            )}
          </div>
        </div>
        <button
          onClick={spin}
          disabled={!hasOptions || isSpinning}
          className="spin-button"
        >
          回す
        </button>
      </div>

      <style>{`
        .container {
          max-width: 600px;
          margin: 0 auto;
          padding: 20px;
        }

        .input-section {
          margin-bottom: 30px;
        }

        .options-input {
          width: 100%;
          padding: 10px;
          font-size: 16px;
          border: 1px solid #ccc;
          border-radius: 4px;
          resize: vertical;
        }

        .roulette-section {
          text-align: center;
        }

        .canvas-container {
          margin: 20px 0;
          position: relative;
        }

        .roulette-canvas {
          max-width: 100%;
          height: auto;
        }

        .result {
          font-size: 24px;
          margin: 20px 0;
          padding: 20px;
          border-radius: 12px;
          min-height: 100px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(135deg, #f6f8fd 0%, #ffffff 100%);
          box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
          transition: all 0.3s ease;
          position: relative;
          overflow: hidden;
        }

        .result::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 4px;
          background: linear-gradient(90deg, #4CAF50, #45B7D1);
          transform: scaleX(0);
          transition: transform 0.3s ease;
        }

        .result.has-result::before {
          transform: scaleX(1);
        }

        .result.spinning {
          background: linear-gradient(135deg, #f0f3fa 0%, #ffffff 100%);
          animation: pulse 1.5s infinite;
        }

        .result-content {
          width: 100%;
          text-align: center;
        }

        .result-label {
          font-size: 16px;
          color: #666;
          margin-bottom: 8px;
          text-transform: uppercase;
          letter-spacing: 1px;
        }

        .result-value {
          font-size: 28px;
          font-weight: bold;
          color: #2c3e50;
          animation: fadeIn 0.5s ease;
        }

        .loading-text {
          color: #666;
          animation: loadingDots 1.5s infinite;
        }

        .default-text {
          color: #999;
          font-size: 18px;
        }

        .spin-button {
          padding: 10px 30px;
          font-size: 18px;
          background-color: #4CAF50;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          transition: background-color 0.3s;
        }

        .spin-button:hover:not(:disabled) {
          background-color: #45a049;
        }

        .spin-button:disabled {
          background-color: #cccccc;
          cursor: not-allowed;
        }

        .help-text {
          font-size: 14px;
          color: #666;
          margin-top: 8px;
        }

        @keyframes pulse {
          0% {
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
          }
          50% {
            box-shadow: 0 4px 20px rgba(76, 175, 80, 0.2);
          }
          100% {
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
          }
        }

        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        @keyframes loadingDots {
          0%, 20% {
            content: '選択中.';
          }
          40% {
            content: '選択中..';
          }
          60%, 100% {
            content: '選択中...';
          }
        }
      `}</style>
    </div>
  );
}

export default App;
