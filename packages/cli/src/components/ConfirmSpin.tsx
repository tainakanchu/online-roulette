import { useEffect } from "react";
import { Box, Text, useStdin } from "ink";
import { shuffleArray, COLORS } from "@tainakanchu/roulette-core";

interface ConfirmSpinProps {
  options: string[];
  onShuffle: (shuffled: string[]) => void;
  onSpin: () => void;
}

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

export const ConfirmSpin = ({ options, onShuffle, onSpin }: ConfirmSpinProps) => {
  const { stdin, setRawMode } = useStdin();

  useEffect(() => {
    setRawMode(true);

    const handleData = (data: Buffer) => {
      const input = data.toString();

      if (input === "\x03") {
        process.exit(0);
      }

      if (input === "s" || input === "S") {
        onShuffle(shuffleArray(options));
        return;
      }

      if (input === "\r" || input === "\n") {
        onSpin();
        return;
      }
    };

    stdin.on("data", handleData);
    return () => {
      stdin.off("data", handleData);
    };
  }, [stdin, setRawMode, options, onShuffle, onSpin]);

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="column">
        {options.map((option, i) => {
          const color = COLORS[i % COLORS.length];
          return (
            <Text key={i} color={hexToAnsiColor(color)}>
              {i + 1}. {option}
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>(Enter to spin, S to shuffle)</Text>
      </Box>
    </Box>
  );
};
