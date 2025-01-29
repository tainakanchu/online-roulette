import { RouletteCanvas } from "./components/RouletteCanvas";
import { RouletteResult } from "./components/RouletteResult";
import { RouletteInput } from "./components/RouletteInput";
import { useRouletteOptions } from "./hooks/useRouletteOptions";
import { useRouletteAnimation } from "./hooks/useRouletteAnimation";
import "./styles/Roulette.css";

function App() {
  const { optionsText, options, hasOptions, handleOptionsChange } =
    useRouletteOptions();
  const { currentOption, isSpinning, rotation, spin } = useRouletteAnimation({
    options,
  });

  return (
    <div className="container">
      <h1 className="main-title">🎯 Lucky Roulette</h1>

      <RouletteInput
        optionsText={optionsText}
        onChange={handleOptionsChange}
        disabled={isSpinning}
      />

      <div className="roulette-section">
        <RouletteCanvas options={options} rotation={rotation} />
        <RouletteResult isSpinning={isSpinning} currentOption={currentOption} />
        <button
          onClick={spin}
          disabled={!hasOptions || isSpinning}
          className="spin-button"
        >
          回す
        </button>
      </div>
    </div>
  );
}

export default App;
