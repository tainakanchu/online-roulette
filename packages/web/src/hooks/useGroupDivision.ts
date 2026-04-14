import { useState, useCallback, useRef } from "react";
import {
  divideIntoGroups,
  shuffleArray,
  type GroupResult,
  type GroupingMethod,
} from "@tainakanchu/roulette-core";
import { useShakeSound } from "./useShakeSound";

interface UseGroupDivisionProps {
  options: string[];
  quickMode?: boolean;
}

export const useGroupDivision = ({
  options,
  quickMode = false,
}: UseGroupDivisionProps) => {
  const [groupCount, setGroupCount] = useState(2);
  const [groupingMethod, setGroupingMethod] = useState<GroupingMethod>("random");
  const [groups, setGroups] = useState<GroupResult[] | null>(null);
  const [isDividing, setIsDividing] = useState(false);
  const [animationStep, setAnimationStep] = useState(0);
  const [animationItems, setAnimationItems] = useState<string[]>([]);
  const animationRef = useRef<ReturnType<typeof setTimeout>>();
  const shakeSound = useShakeSound();

  const totalAnimationSteps = quickMode ? 8 : 20;

  const divide = useCallback(() => {
    if (options.length < 2 || groupCount < 2 || groupCount > options.length) {
      return;
    }

    setIsDividing(true);
    setGroups(null);
    setAnimationStep(0);
    setAnimationItems(options);

    // 最終結果を先に計算
    const finalGroups = divideIntoGroups(options, groupCount, groupingMethod);

    // シャッフルアニメーション
    shakeSound.start();
    let step = 0;

    const animate = () => {
      step += 1;
      setAnimationStep(step);
      setAnimationItems((prev) => shuffleArray(prev));

      if (step < totalAnimationSteps) {
        // 徐々にゆっくりに
        const delay = quickMode ? 30 + step * 5 : 50 + step * 15;
        animationRef.current = setTimeout(animate, delay);
      } else {
        // アニメーション完了 → 結果表示
        shakeSound.stop();
        setIsDividing(false);
        setGroups(finalGroups);
      }
    };

    animationRef.current = setTimeout(animate, 50);
  }, [options, groupCount, groupingMethod, quickMode, shakeSound, totalAnimationSteps]);

  const reset = useCallback(() => {
    if (animationRef.current) {
      clearTimeout(animationRef.current);
    }
    shakeSound.stop();
    setGroups(null);
    setIsDividing(false);
    setAnimationStep(0);
  }, [shakeSound]);

  return {
    groupCount,
    setGroupCount,
    groupingMethod,
    setGroupingMethod,
    groups,
    isDividing,
    animationStep,
    animationItems,
    totalAnimationSteps,
    divide,
    reset,
  };
};
