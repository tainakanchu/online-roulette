import { useCallback, useEffect, useRef } from "react";
import { COLORS, getColorBrightness } from "../constants/colors";

interface RouletteCanvasProps {
  options: string[];
  rotation: number;
  width?: number;
  height?: number;
}

export const RouletteCanvas: React.FC<RouletteCanvasProps> = ({
  options,
  rotation,
  width = 400,
  height = 400,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hasOptions = options.length > 0;

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
      ctx.fillStyle = getColorBrightness(color) > 128 ? "#000000" : "#FFFFFF";
      ctx.font = "bold 16px sans-serif";
      ctx.fillText(option, radius - 20, 0);
      ctx.restore();
    });

    ctx.restore();

    // 矢印を描画
    ctx.beginPath();
    ctx.moveTo(centerX + radius + 30, centerY - 15);
    ctx.lineTo(centerX + radius - 10, centerY);
    ctx.lineTo(centerX + radius + 30, centerY + 15);
    ctx.closePath();
    ctx.fillStyle = "#FF0000";
    ctx.fill();
  }, [options, rotation, hasOptions]);

  useEffect(() => {
    drawRoulette();
  }, [drawRoulette]);

  return (
    <div className="canvas-container">
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className="roulette-canvas"
      />
    </div>
  );
};
