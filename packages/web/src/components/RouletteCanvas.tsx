import {
  useCallback,
  useEffect,
  useRef,
  forwardRef,
  useImperativeHandle,
} from "react";
import { COLORS, getColorBrightness } from "@tainakanchu/roulette-core";

const SIZE = 460;
const CENTER = SIZE / 2;
const SLICE_RADIUS = 178;
const FRAME_RADIUS = 202;
const BULB_RADIUS = 191;
const BULB_COUNT = 24;
const HUB_OUTER = 40;
const HUB_INNER = 29;
const ACCENT = "#4CAF50";

interface RouletteCanvasProps {
  options: string[];
  rotation: number;
  onSpin?: () => void;
  canSpin?: boolean;
}

export interface RouletteCanvasRef {
  getCanvas: () => HTMLCanvasElement | null;
}

export const RouletteCanvas = forwardRef<RouletteCanvasRef, RouletteCanvasProps>(
  ({ options, rotation, onSpin, canSpin = false }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useImperativeHandle(ref, () => ({
      getCanvas: () => canvasRef.current,
    }));

    const drawRoulette = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      ctx.clearRect(0, 0, SIZE, SIZE);

      // フレームディスク
      ctx.beginPath();
      ctx.arc(CENTER, CENTER, FRAME_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = "#2a1550";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(255,255,255,.14)";
      ctx.stroke();

      // スライス
      if (options.length) {
        const slice = (Math.PI * 2) / options.length;
        ctx.save();
        ctx.translate(CENTER, CENTER);
        ctx.rotate((rotation * Math.PI) / 180);
        options.forEach((option, i) => {
          const start = i * slice;
          const end = start + slice;
          const color = COLORS[i % COLORS.length];
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.arc(0, 0, SLICE_RADIUS, start, end);
          ctx.closePath();
          ctx.fillStyle = color;
          ctx.fill();
          ctx.strokeStyle = "rgba(255,255,255,.85)";
          ctx.lineWidth = 2;
          ctx.stroke();

          ctx.save();
          ctx.rotate(start + slice / 2);
          ctx.textAlign = "right";
          ctx.textBaseline = "middle";
          ctx.fillStyle = getColorBrightness(color) > 128 ? "#1a1330" : "#ffffff";
          ctx.font = "600 17px Fredoka, sans-serif";
          ctx.fillText(option, SLICE_RADIUS - 18, 0);
          ctx.restore();
        });
        ctx.restore();
      }

      // 電球（フレーム上、静止）
      for (let k = 0; k < BULB_COUNT; k += 1) {
        const a = (k / BULB_COUNT) * Math.PI * 2;
        const x = CENTER + Math.cos(a) * BULB_RADIUS;
        const y = CENTER + Math.sin(a) * BULB_RADIUS;
        const on = k % 2 === 0;
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = on ? "#FFD23F" : "#ffffff";
        ctx.shadowColor = on ? "rgba(255,210,63,.9)" : "rgba(255,255,255,.7)";
        ctx.shadowBlur = 10;
        ctx.fill();
      }
      ctx.shadowBlur = 0;

      // 中央ハブ
      ctx.beginPath();
      ctx.arc(CENTER, CENTER, HUB_OUTER, 0, Math.PI * 2);
      ctx.fillStyle = "#1a1330";
      ctx.fill();
      ctx.lineWidth = 4;
      ctx.strokeStyle = ACCENT;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(CENTER, CENTER, HUB_INNER, 0, Math.PI * 2);
      const hubGradient = ctx.createLinearGradient(
        CENTER - HUB_INNER,
        CENTER - HUB_INNER,
        CENTER + HUB_INNER,
        CENTER + HUB_INNER
      );
      hubGradient.addColorStop(0, "#ffffff");
      hubGradient.addColorStop(1, "#dcd3f5");
      ctx.fillStyle = hubGradient;
      ctx.fill();
      ctx.fillStyle = "#1a1330";
      ctx.font = "700 13px Fredoka, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("SPIN", CENTER, CENTER);

      // ポインター（3時=右、内向き）
      ctx.beginPath();
      ctx.moveTo(CENTER + FRAME_RADIUS + 2, CENTER - 16);
      ctx.lineTo(CENTER + FRAME_RADIUS + 2, CENTER + 16);
      ctx.lineTo(CENTER + FRAME_RADIUS - 30, CENTER);
      ctx.closePath();
      ctx.fillStyle = "#FFD23F";
      ctx.shadowColor = "rgba(255,210,63,.8)";
      ctx.shadowBlur = 14;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
    }, [options, rotation]);

    useEffect(() => {
      drawRoulette();
    }, [drawRoulette]);

    return (
      <canvas
        ref={canvasRef}
        width={SIZE}
        height={SIZE}
        className="roulette-canvas"
        style={{ cursor: canSpin ? "pointer" : "default" }}
        onClick={() => {
          if (canSpin) onSpin?.();
        }}
      />
    );
  }
);
