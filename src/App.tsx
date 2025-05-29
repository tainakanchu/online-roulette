import { useRef } from "react";
import { RouletteCanvas, RouletteCanvasRef } from "./components/RouletteCanvas";
import { RouletteResult } from "./components/RouletteResult";
import { RouletteInput } from "./components/RouletteInput";
import { RouletteActions } from "./components/RouletteActions";
import { useRouletteOptions } from "./hooks/useRouletteOptions";
import { useRouletteAnimation } from "./hooks/useRouletteAnimation";
import { Footer } from "./components/Footer";

// スタイルのインポート
import "./styles/base.css";
import "./styles/components/RouletteInput.css";
import "./styles/components/RouletteCanvas.css";
import "./styles/components/RouletteResult.css";
import "./styles/components/RouletteActions.css";
import "./styles/themes/dark.css";
import "./styles/responsive.css";

function App() {
  const canvasRef = useRef<RouletteCanvasRef>(null);
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
        <div className="canvas-container">
          <RouletteCanvas
            ref={canvasRef}
            options={options}
            rotation={rotation}
          />
          <RouletteActions
            canvasElement={canvasRef.current?.getCanvas() || null}
            currentOption={currentOption}
            isVisible={!!currentOption && !isSpinning}
          />
        </div>
        <RouletteResult isSpinning={isSpinning} currentOption={currentOption} />
        <button
          onClick={spin}
          disabled={!hasOptions || isSpinning}
          className="spin-button"
        >
          回す
        </button>
      </div>

      <Footer />
    </div>
  );
}

export default App;
