import { useState, useCallback, useRef, useMemo } from "react";
import { createDefaultRouletteLogic } from "../logic/roulette";

interface UseRouletteAnimationProps {
  options: string[];
}

export const useRouletteAnimation = ({
  options,
}: UseRouletteAnimationProps) => {
  const [currentOption, setCurrentOption] = useState("");
  const [isSpinning, setIsSpinning] = useState(false);
  const [rotation, setRotation] = useState(0);
  const animationRef = useRef<number>();

  // ルーレットロジックのインスタンスを作成
  const rouletteLogic = useMemo(() => createDefaultRouletteLogic(), []);

  const spin = useCallback(() => {
    if (!options.length || isSpinning) return;

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
  }, [options, isSpinning, rotation, rouletteLogic]);

  return {
    currentOption,
    isSpinning,
    rotation,
    spin,
  };
};
