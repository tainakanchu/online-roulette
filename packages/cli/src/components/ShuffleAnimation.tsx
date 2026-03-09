import { useState, useEffect, useRef } from "react";
import { Box, Text } from "ink";
import { shuffleArray, COLORS } from "@tainakanchu/roulette-core";

interface ShuffleAnimationProps {
  options: string[];
  shuffleCount: number;
  onComplete: (shuffled: string[]) => void;
}

export const ShuffleAnimation = ({
  options,
  shuffleCount,
  onComplete,
}: ShuffleAnimationProps) => {
  const [current, setCurrent] = useState<string[]>(options);
  const [step, setStep] = useState(0);
  const completeCalled = useRef(false);
  const totalSteps = shuffleCount * 5;

  useEffect(() => {
    if (step >= totalSteps) {
      if (!completeCalled.current) {
        completeCalled.current = true;
        setTimeout(() => onComplete(current), 300);
      }
      return;
    }

    const timer = setTimeout(
      () => {
        setCurrent((prev) => {
          const next = shuffleArray(prev);
          setStep((s) => s + 1);
          return next;
        });
      },
      50 + step * 10
    );

    return () => clearTimeout(timer);
  }, [step, totalSteps, onComplete, current]);

  const hexToAnsiColor = (hex: string): string => {
    const rgb = hex.replace("#", "").match(/.{2}/g);
    if (!rgb) return "white";
    const r = parseInt(rgb[0], 16);
    const g = parseInt(rgb[1], 16);
    const b = parseInt(rgb[2], 16);
    if (r > g && r > b) return "red";
    if (g > r && g > b) return "green";
    if (b > r && b > g) return "blue";
    return "cyan";
  };

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>🔀 Shuffling... ({step}/{totalSteps})</Text>
      <Box marginTop={1} flexDirection="column">
        {current.map((option, i) => {
          const color = COLORS[i % COLORS.length];
          return (
            <Text key={i} color={hexToAnsiColor(color)}>
              {i + 1}. {option}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
};
