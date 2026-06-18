import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RouletteCanvas, RouletteCanvasRef } from "./components/RouletteCanvas";
import { RouletteResult } from "./components/RouletteResult";
import { OptionEditor } from "./components/OptionEditor";
import { RouletteActions } from "./components/RouletteActions";
import { BattleMode } from "./components/BattleMode";
import { useRouletteOptions } from "./hooks/useRouletteOptions";
import { useRouletteAnimation } from "./hooks/useRouletteAnimation";
import { useSnackbar } from "./hooks/useSnackbar";
import { useConfetti } from "./hooks/useConfetti";
import { Snackbar } from "./components/Snackbar";
import { Footer } from "./components/Footer";
import { RouletteHistory } from "./components/RouletteHistory";
import { useRouletteHistory } from "./hooks/useRouletteHistory";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import { ModeSwitcher, type AppMode } from "./components/ModeSwitcher";
import { GroupControls } from "./components/GroupControls";
import { GroupAnimation } from "./components/GroupAnimation";
import { GroupResultDisplay } from "./components/GroupResultDisplay";
import { useGroupDivision } from "./hooks/useGroupDivision";
import { readLocalStorage, writeLocalStorage } from "./utils/localStorage";

// スタイルのインポート
import "./styles/base.css";
import "./styles/components/ModeSwitcher.css";
import "./styles/components/OptionEditor.css";
import "./styles/components/RouletteCanvas.css";
import "./styles/components/RouletteResult.css";
import "./styles/components/RouletteActions.css";
import "./styles/components/Snackbar.css";
import "./styles/components/RouletteHistory.css";
import "./styles/components/LanguageSwitcher.css";
import "./styles/components/GroupControls.css";
import "./styles/components/GroupResult.css";
import "./styles/components/BattleMode.css";
// レスポンシブは全コンポーネントCSSの後に読み込む
import "./styles/responsive.css";

const MODE_STORAGE_KEY = "roulette-mode";

const readInitialMode = (): AppMode => {
  const stored = readLocalStorage(MODE_STORAGE_KEY);
  if (stored === "grouping" || stored === "battle") return stored;
  return "roulette";
};

function App() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<AppMode>(readInitialMode);
  const canvasRef = useRef<RouletteCanvasRef>(null);
  const { canvasRef: confettiRef, fire: fireConfetti } = useConfetti();

  useEffect(() => {
    writeLocalStorage(MODE_STORAGE_KEY, mode);
  }, [mode]);

  // 選択肢が変化したときに古い結果（ルーレット当選・グループ）をリセットする
  const resetResultsRef = useRef<() => void>(() => {});

  const {
    optionsText,
    options,
    hasOptions,
    newOption,
    showBulkEdit,
    handleOptionsChange,
    handleNewOptionChange,
    handleNewOptionKeyDown,
    addOption,
    removeOption,
    clearOptions,
    toggleBulkEdit,
    shuffleOptions,
    shuffleCount,
    handleShuffleCountChange,
    quickMode,
    handleQuickModeChange,
  } = useRouletteOptions({ onOptionsMutated: () => resetResultsRef.current() });

  const { history, addHistoryEntry, clearHistory } = useRouletteHistory();

  const handleRouletteFinish = useCallback(
    (result: string) => {
      addHistoryEntry(result);
      fireConfetti();
    },
    [addHistoryEntry, fireConfetti],
  );

  const {
    currentOption,
    isSpinning,
    rotation,
    spin,
    resetResult,
    displayOptions,
  } = useRouletteAnimation({
    options,
    onFinish: handleRouletteFinish,
    quickMode,
  });

  const { isVisible, message, showSnackbar, hideSnackbar } = useSnackbar();

  const {
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
    reset: resetGroups,
  } = useGroupDivision({ options, quickMode, onComplete: fireConfetti });

  useEffect(() => {
    resetResultsRef.current = () => {
      resetResult();
      resetGroups();
    };
  }, [resetResult, resetGroups]);

  const handleBattleFinish = useCallback(
    (winner: string) => {
      addHistoryEntry(winner);
      fireConfetti();
    },
    [addHistoryEntry, fireConfetti],
  );

  const handleModeChange = useCallback(
    (newMode: AppMode) => {
      setMode(newMode);
      resetGroups();
    },
    [resetGroups],
  );

  const isBusy = isSpinning || isDividing;
  const canSpin = hasOptions && !isSpinning;

  return (
    <>
      <div className="bg-blob bg-blob--purple" aria-hidden="true" />
      <div className="bg-blob bg-blob--pink" aria-hidden="true" />

      <LanguageSwitcher />
      {mode === "roulette" && (
        <RouletteHistory history={history} onClear={clearHistory} />
      )}

      <div className="container">
        <canvas ref={confettiRef} className="confetti-canvas" aria-hidden="true" />

        <h1 className="main-title">🎯 {t("app.title")}</h1>
        <p className="tagline">{t("ui.tagline")}</p>

        <ModeSwitcher mode={mode} onChange={handleModeChange} disabled={isBusy} />

        <OptionEditor
          optionsText={optionsText}
          options={options}
          newOption={newOption}
          showBulkEdit={showBulkEdit}
          disabled={isBusy}
          onNewOptionChange={handleNewOptionChange}
          onNewOptionKeyDown={handleNewOptionKeyDown}
          onAddOption={addOption}
          onRemoveOption={removeOption}
          onClearOptions={clearOptions}
          onToggleBulkEdit={toggleBulkEdit}
          onBulkChange={handleOptionsChange}
          shuffleCount={shuffleCount}
          onShuffleCountChange={handleShuffleCountChange}
          onShuffle={shuffleOptions}
          canShuffle={options.length > 1 && !isBusy}
        />

        {mode === "roulette" && (
          <div className="roulette-section">
            <div className="wheel-wrap">
              <div className="wheel-glow" aria-hidden="true" />
              <RouletteCanvas
                ref={canvasRef}
                options={displayOptions}
                rotation={rotation}
                onSpin={spin}
                canSpin={canSpin}
              />
              <RouletteActions
                canvasElement={canvasRef.current?.getCanvas() || null}
                isVisible={!!currentOption && !isSpinning}
                onSuccess={showSnackbar}
              />
            </div>
            <RouletteResult isSpinning={isSpinning} currentOption={currentOption} />
            <div className="spin-controls">
              <button onClick={spin} disabled={!canSpin} className="spin-button">
                {t("app.spin")} 🎲
              </button>
              <label className="quick-mode-label">
                <input
                  type="checkbox"
                  checked={quickMode}
                  onChange={handleQuickModeChange}
                  disabled={isSpinning}
                  className="quick-mode-checkbox"
                />
                ⚡ {t("app.quickMode")}
              </label>
            </div>
          </div>
        )}

        {mode === "grouping" && (
          <div className="grouping-section">
            <GroupControls
              groupCount={groupCount}
              onGroupCountChange={setGroupCount}
              groupingMethod={groupingMethod}
              onGroupingMethodChange={setGroupingMethod}
              maxGroups={Math.max(2, options.length)}
              disabled={isDividing}
            />

            <button
              onClick={divide}
              disabled={
                options.length < 2 || isDividing || groupCount > options.length
              }
              className="divide-button"
            >
              ✨ {t("grouping.divide")}
            </button>
            <label className="quick-mode-label">
              <input
                type="checkbox"
                checked={quickMode}
                onChange={handleQuickModeChange}
                disabled={isDividing}
                className="quick-mode-checkbox"
              />
              ⚡ {t("app.quickMode")}
            </label>

            {isDividing && (
              <GroupAnimation
                items={animationItems}
                step={animationStep}
                totalSteps={totalAnimationSteps}
              />
            )}

            {groups && !isDividing && <GroupResultDisplay groups={groups} />}
          </div>
        )}

        {mode === "battle" && (
          <BattleMode options={options} onFinish={handleBattleFinish} />
        )}

        <Footer />
      </div>

      <Snackbar message={message} isVisible={isVisible} onClose={hideSnackbar} />
    </>
  );
}

export default App;
