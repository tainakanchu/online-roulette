import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { RouletteCanvas, RouletteCanvasRef } from "./components/RouletteCanvas";
import { RouletteResult } from "./components/RouletteResult";
import { RouletteInput } from "./components/RouletteInput";
import { RouletteActions } from "./components/RouletteActions";
import { useRouletteOptions } from "./hooks/useRouletteOptions";
import { useRouletteAnimation } from "./hooks/useRouletteAnimation";
import { useSnackbar } from "./hooks/useSnackbar";
import { Snackbar } from "./components/Snackbar";
import { Footer } from "./components/Footer";
import { RouletteHistory } from "./components/RouletteHistory";
import { useRouletteHistory } from "./hooks/useRouletteHistory";
import { LanguageSwitcher } from "./components/LanguageSwitcher";

// スタイルのインポート
import "./styles/base.css";
import "./styles/components/RouletteInput.css";
import "./styles/components/RouletteCanvas.css";
import "./styles/components/RouletteResult.css";
import "./styles/components/RouletteActions.css";
import "./styles/components/Snackbar.css";
import "./styles/themes/dark.css";
import "./styles/responsive.css";
import "./styles/components/RouletteHistory.css";
import "./styles/components/LanguageSwitcher.css";

function App() {
  const { t } = useTranslation();
  const canvasRef = useRef<RouletteCanvasRef>(null);
  const {
    optionsText,
    options,
    hasOptions,
    handleOptionsChange,
    shuffleOptions,
    shuffleCount,
    handleShuffleCountChange,
    quickMode,
    handleQuickModeChange,
  } = useRouletteOptions();
  const { history, addHistoryEntry, clearHistory } = useRouletteHistory();
  const { currentOption, isSpinning, rotation, spin, displayOptions } =
    useRouletteAnimation({
      options,
      onFinish: addHistoryEntry,
      quickMode,
    });
  const { isVisible, message, showSnackbar, hideSnackbar } = useSnackbar();

  const handleShuffle = useCallback(() => {
    shuffleOptions();
  }, [shuffleOptions]);

  return (
    <div className="container">
      <LanguageSwitcher />
      <RouletteHistory history={history} onClear={clearHistory} />
      <h1 className="main-title">🎯 Lucky Roulette</h1>

      <RouletteInput
        optionsText={optionsText}
        onChange={handleOptionsChange}
        onShuffle={handleShuffle}
        canShuffle={options.length > 1 && !isSpinning}
        disabled={isSpinning}
        shuffleCount={shuffleCount}
        onShuffleCountChange={handleShuffleCountChange}
      />

      <div className="roulette-section">
        <div className="canvas-container">
          <RouletteCanvas
            ref={canvasRef}
            options={displayOptions}
            rotation={rotation}
          />
          <RouletteActions
            canvasElement={canvasRef.current?.getCanvas() || null}
            currentOption={currentOption}
            isVisible={!!currentOption && !isSpinning}
            onSuccess={showSnackbar}
          />
        </div>
        <RouletteResult isSpinning={isSpinning} currentOption={currentOption} />
        <div className="spin-controls">
          <button
            onClick={spin}
            disabled={!hasOptions || isSpinning}
            className="spin-button"
          >
            {t("app.spin")}
          </button>
          <label className="quick-mode-label">
            <input
              type="checkbox"
              checked={quickMode}
              onChange={handleQuickModeChange}
              disabled={isSpinning}
              className="quick-mode-checkbox"
            />
            {t("app.quickMode")}
          </label>
        </div>
      </div>

      <Footer />
      <Snackbar
        message={message}
        isVisible={isVisible}
        onClose={hideSnackbar}
      />
    </div>
  );
}

export default App;
