import { useState, useEffect, useRef } from "react";
import { Box, Text } from "ink";
import { createDefaultRouletteLogic } from "@tainakanchu/roulette-core";
import { COLORS, getColorBrightness } from "@tainakanchu/roulette-core";

interface RouletteSpinnerProps {
  options: string[];
  quickMode: boolean;
  onComplete: (result: string) => void;
}

const hexToAnsi256 = (hex: string): string => {
  const rgb = hex.replace("#", "").match(/.{2}/g);
  if (!rgb) return "white";
  const r = parseInt(rgb[0], 16);
  const g = parseInt(rgb[1], 16);
  const b = parseInt(rgb[2], 16);
  const brightness = getColorBrightness(hex);
  if (brightness > 200) return "yellow";
  if (r > g && r > b) return "red";
  if (g > r && g > b) return "green";
  if (b > r && b > g) return "blue";
  return "cyan";
};

export const RouletteSpinner = ({
  options,
  quickMode,
  onComplete,
}: RouletteSpinnerProps) => {
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [isComplete, setIsComplete] = useState(false);
  const completeCalled = useRef(false);

  useEffect(() => {
    const logic = createDefaultRouletteLogic();
    const { totalRotation, duration: baseDuration } = logic.calculateRotation();
    const duration = quickMode ? baseDuration * 0.4 : baseDuration;
    const finalRotation = quickMode ? totalRotation * 0.4 : totalRotation;
    const selectedIndex = logic.calculateSelectedIndex(options, finalRotation);

    const startTime = Date.now();
    let frame: ReturnType<typeof setTimeout>;

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const easeOut = 1 - Math.pow(1 - progress, 4);
      const currentRotation = finalRotation * easeOut;
      const sliceAngle = 360 / options.length;
      const normalizedRotation = (360 - (currentRotation % 360)) % 360;
      const currentIndex = Math.floor(normalizedRotation / sliceAngle) % options.length;

      setHighlightIndex(currentIndex);

      if (progress < 1) {
        const speed = Math.max(16, 200 * progress);
        frame = setTimeout(animate, speed);
      } else {
        setHighlightIndex(selectedIndex);
        setIsComplete(true);
      }
    };

    animate();

    return () => {
      if (frame) clearTimeout(frame);
    };
  }, [options, quickMode]);

  useEffect(() => {
    if (isComplete && !completeCalled.current) {
      completeCalled.current = true;
      const timer = setTimeout(() => {
        onComplete(options[highlightIndex]);
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [isComplete, highlightIndex, options, onComplete]);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{isComplete ? "🎉 Result:" : "🎰 Spinning..."}</Text>
      <Box marginTop={1} flexDirection="column">
        {options.map((option, i) => {
          const isHighlighted = i === highlightIndex;
          const color = COLORS[i % COLORS.length];
          const ansiColor = hexToAnsi256(color);

          return (
            <Box key={i}>
              <Text color={isHighlighted ? "white" : "gray"}>
                {isHighlighted ? " ▶ " : "   "}
              </Text>
              <Text
                bold={isHighlighted}
                color={isHighlighted ? ansiColor : "gray"}
                inverse={isHighlighted && isComplete}
              >
                {option}
              </Text>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
};
