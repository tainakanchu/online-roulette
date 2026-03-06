import { useState } from "react";
import { Box, Text } from "ink";
import { OptionsInput } from "./components/OptionsInput.js";
import { RouletteSpinner } from "./components/RouletteSpinner.js";
import { Result } from "./components/Result.js";

type Phase = "input" | "spinning" | "result";

interface AppProps {
  options: string[];
  quickMode: boolean;
}

export const App = ({ options: initialOptions, quickMode }: AppProps) => {
  const [phase, setPhase] = useState<Phase>(
    initialOptions.length >= 2 ? "spinning" : "input"
  );
  const [options, setOptions] = useState<string[]>(initialOptions);
  const [result, setResult] = useState("");

  const handleOptionsSubmit = (submitted: string[]) => {
    setOptions(submitted);
    setPhase("spinning");
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
