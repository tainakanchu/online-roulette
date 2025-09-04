import { useState, useCallback, useRef, useMemo } from "react";
import { createDefaultRouletteLogic } from "../logic/roulette";

// 音を鳴らす最小間隔（ミリ秒）
const MIN_TICK_INTERVAL_MS = 30;

interface UseRouletteAnimationProps {
  options: string[];
  onFinish?: (result: string) => void;
}

export const useRouletteAnimation = ({
  options,
  onFinish,
}: UseRouletteAnimationProps) => {
  const [currentOption, setCurrentOption] = useState("");
  const [isSpinning, setIsSpinning] = useState(false);
  const [rotation, setRotation] = useState(0);
  const animationRef = useRef<number>();
  const lastTickRef = useRef<number>(0);
  const lastTickTimeRef = useRef<number>(0);
  const tickSound = useMemo(() => new Audio("/sounds/tick.mp3"), []);

  // ルーレットロジックのインスタンスを作成
  const rouletteLogic = useMemo(() => createDefaultRouletteLogic(), []);

  const playTickSound = useCallback(() => {
    const now = Date.now();
    // 前回の音から一定時間以上経過している場合のみ音を鳴らす
    if (now - lastTickTimeRef.current >= MIN_TICK_INTERVAL_MS) {
      tickSound.currentTime = 0;
      tickSound.play().catch(() => {
        // ユーザーインタラクションがない場合などでエラーが発生する可能性があるため、
        // エラーは無視します
      });
      lastTickTimeRef.current = now;
    }
  }, [tickSound]);

  const spin = useCallback(() => {
    if (!options.length || isSpinning) return;

    setIsSpinning(true);
    const startRotation = rotation;
    const { totalRotation, duration } = rouletteLogic.calculateRotation();
    const startTime = Date.now();
    const segmentAngle = 360 / options.length;

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = elapsed / duration;

      if (progress < 1) {
        const easeOut = 1 - Math.pow(1 - progress, 4);
        const currentRotation = startRotation + totalRotation * easeOut;
        setRotation(currentRotation);

        // 現在の回転角度を基に、境目を通過したかチェック
        const currentSegment = Math.floor(currentRotation / segmentAngle);
        if (currentSegment !== lastTickRef.current) {
          playTickSound();
          lastTickRef.current = currentSegment;
        }

        animationRef.current = requestAnimationFrame(animate);
      } else {
        const finalRotation = startRotation + totalRotation;
        setRotation(finalRotation);

        const selectedIndex = rouletteLogic.calculateSelectedIndex(
          options,
          finalRotation
        );
        const result = options[selectedIndex];
        setCurrentOption(result);
        setIsSpinning(false);
        onFinish?.(result);
      }
    };

    animationRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [options, isSpinning, rotation, rouletteLogic, playTickSound, onFinish]);

  return {
    currentOption,
    isSpinning,
    rotation,
    spin,
  };
};
