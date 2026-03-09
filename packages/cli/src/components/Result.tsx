import { useEffect } from "react";
import { Box, Text, useApp } from "ink";
import { COLORS, getColorBrightness } from "@tainakanchu/roulette-core";

interface ResultProps {
  result: string;
  options: string[];
}

const hexToAnsiColor = (hex: string): string => {
  const brightness = getColorBrightness(hex);
  if (brightness > 200) return "yellow";
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

export const Result = ({ result, options }: ResultProps) => {
  const { exit } = useApp();

  useEffect(() => {
    const timer = setTimeout(() => {
      exit();
      process.exit(0);
    }, 100);
    return () => clearTimeout(timer);
  }, [exit]);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>🎉 Result:</Text>
      <Box marginTop={1} flexDirection="column">
        {options.map((option, i) => {
          const isWinner = option === result;
          const color = COLORS[i % COLORS.length];
          const ansiColor = hexToAnsiColor(color);

          return (
            <Box key={i}>
              <Text color={isWinner ? "white" : "gray"}>
                {isWinner ? " ▶ " : "   "}
              </Text>
              <Text
                bold={isWinner}
                color={isWinner ? ansiColor : "gray"}
                inverse={isWinner}
              >
                {option}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Selected: <Text bold color="white">{result}</Text>
        </Text>
      </Box>
    </Box>
  );
};
