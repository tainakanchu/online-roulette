import { useCallback, useEffect, useRef } from "react";
import { COLORS } from "@tainakanchu/roulette-core";

const PARTICLE_COUNT = 150;
const LIFETIME_MS = 2000;

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  g: number;
  rot: number;
  vr: number;
  size: number;
  color: string;
  /** 0 = square, 1 = circle */
  shape: 0 | 1;
}

/**
 * パネルを覆う <canvas> に紙吹雪を噴き上げるフック。
 * 勝利演出（ルーレット当選・グループ分け完了・バトル勝者）で fire() を呼ぶ。
 */
export const useConfetti = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>();

  const fire = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !canvas.parentElement) return;

    const width = canvas.parentElement.clientWidth;
    const height = canvas.parentElement.clientHeight;
    if (!width || !height) return;

    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const particles: Particle[] = [];
    for (let i = 0; i < PARTICLE_COUNT; i += 1) {
      particles.push({
        x: width / 2 + (Math.random() - 0.5) * 140,
        y: height * 0.42 + (Math.random() - 0.5) * 50,
        vx: (Math.random() - 0.5) * 10,
        vy: Math.random() * -12 - 4,
        g: 0.3 + Math.random() * 0.14,
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.45,
        size: 6 + Math.random() * 8,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        shape: Math.random() < 0.5 ? 0 : 1,
      });
    }

    const start = performance.now();
    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    const draw = (now: number) => {
      const elapsed = now - start;
      ctx.clearRect(0, 0, width, height);
      const alpha = Math.max(0, 1 - elapsed / LIFETIME_MS);
      for (const p of particles) {
        p.vy += p.g;
        p.x += p.vx;
        p.y += p.vy;
        p.vx *= 0.992;
        p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.color;
        if (p.shape === 0) {
          ctx.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66);
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      if (elapsed < LIFETIME_MS) {
        rafRef.current = requestAnimationFrame(draw);
      } else {
        ctx.clearRect(0, 0, width, height);
      }
    };

    rafRef.current = requestAnimationFrame(draw);
  }, []);

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  return { canvasRef, fire };
};
