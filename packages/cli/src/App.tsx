import { useState, useCallback } from "react";
import { Box, Text } from "ink";
import { OptionsInput } from "./components/OptionsInput.js";
import { ConfirmSpin } from "./components/ConfirmSpin.js";
import { ShuffleAnimation } from "./components/ShuffleAnimation.js";
import { RouletteSpinner } from "./components/RouletteSpinner.js";
import { Result } from "./components/Result.js";

type Phase = "input" | "confirm" | "shuffling" | "spinning" | "result";

interface AppProps {
  options: string[];
  quickMode: boolean;
  shuffle: boolean;
  shuffleCount: number;
}

export const App = ({
  options: initialOptions,
  quickMode,
  shuffle,
  shuffleCount,
}: AppProps) => {
  const needsInput = initialOptions.length < 2;
  const initialPhase: Phase = needsInput
    ? "input"
    : shuffle
      ? "shuffling"
      : "confirm";
  const [phase, setPhase] = useState<Phase>(initialPhase);
  const [options, setOptions] = useState<string[]>(initialOptions);
  const [result, setResult] = useState("");

  const handleOptionsSubmit = (submitted: string[]) => {
    setOptions(submitted);
    setPhase(shuffle ? "shuffling" : "confirm");
  };

  const handleConfirmShuffle = useCallback((shuffled: string[]) => {
    setOptions(shuffled);
  }, []);

  const handleConfirmSpin = useCallback(() => {
    setPhase("spinning");
  }, []);

  const handleShuffleComplete = (shuffled: string[]) => {
    setOptions(shuffled);
    setPhase("confirm");
  };

  const handleSpinComplete = (selected: string) => {
    setResult(selected);
    setPhase("result");
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold color="cyan">
        🎯 Lucky Roulette
      </Text>
      <Text dimColor>─────────────────</Text>

      {phase === "input" && <OptionsInput onSubmit={handleOptionsSubmit} />}

      {phase === "confirm" && (
        <ConfirmSpin
          options={options}
          onShuffle={handleConfirmShuffle}
          onSpin={handleConfirmSpin}
        />
      )}

      {phase === "shuffling" && (
        <ShuffleAnimation
          options={options}
          shuffleCount={shuffleCount}
          onComplete={handleShuffleComplete}
        />
      )}

      {phase === "spinning" && (
        <RouletteSpinner
          options={options}
          quickMode={quickMode}
          onComplete={handleSpinComplete}
        />
      )}

      {phase === "result" && <Result result={result} options={options} />}
    </Box>
  );
};
