import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RouletteCanvas, RouletteCanvasRef } from "./components/RouletteCanvas";
import { RouletteResult } from "./components/RouletteResult";
import { RouletteInput } from "./components/RouletteInput";
import { RouletteActions } from "./components/RouletteActions";
import { BattleMode } from "./components/BattleMode";
import { useRouletteOptions } from "./hooks/useRouletteOptions";
import { useRouletteAnimation } from "./hooks/useRouletteAnimation";
import { useSnackbar } from "./hooks/useSnackbar";
import { Snackbar } from "./components/Snackbar";
import { Footer } from "./components/Footer";
import { RouletteHistory } from "./components/RouletteHistory";
import { useRouletteHistory } from "./hooks/useRouletteHistory";
import { LanguageSwitcher } from "./components/LanguageSwitcher";
import { ModeSwitcher, type AppMode } from "./components/ModeSwitcher";
import { GroupControls } from "./components/GroupControls";
import { GroupAnimation } from "./components/GroupAnimation";
import { GroupResultDisplay } from "./components/GroupResultDisplay";
import { GroupActions } from "./components/GroupActions";
import { useGroupDivision } from "./hooks/useGroupDivision";
import { readLocalStorage, writeLocalStorage } from "./utils/localStorage";

// スタイルのインポート
import "./styles/base.css";
import "./styles/components/RouletteInput.css";
import "./styles/components/RouletteCanvas.css";
import "./styles/components/RouletteResult.css";
import "./styles/components/RouletteActions.css";
import "./styles/components/Snackbar.css";
import "./styles/components/RouletteHistory.css";
import "./styles/components/LanguageSwitcher.css";
import "./styles/components/ModeSwitcher.css";
import "./styles/components/GroupControls.css";
import "./styles/components/GroupResult.css";
import "./styles/components/BattleMode.css";
// テーマ・レスポンシブは全コンポーネントCSSの後に読み込む
import "./styles/themes/dark.css";
import "./styles/responsive.css";

const MODE_STORAGE_KEY = "roulette-mode";
const MODE_QUERY_KEY = "mode";

const isAppMode = (value: string | null): value is AppMode =>
  value === "roulette" || value === "grouping" || value === "battle";

const readInitialMode = (): AppMode => {
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get(MODE_QUERY_KEY);
  if (isAppMode(fromQuery)) return fromQuery;
  const stored = readLocalStorage(MODE_STORAGE_KEY);
  if (isAppMode(stored)) return stored;
  return "roulette";
};

const writeModeToURL = (mode: AppMode) => {
  const url = new URL(window.location.href);
  url.searchParams.set(MODE_QUERY_KEY, mode);
  window.history.replaceState({}, "", url.toString());
};

function App() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<AppMode>(readInitialMode);
  const canvasRef = useRef<RouletteCanvasRef>(null);

  useEffect(() => {
    writeLocalStorage(MODE_STORAGE_KEY, mode);
    writeModeToURL(mode);
  }, [mode]);

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
  } = useGroupDivision({ options, quickMode });

  const handleShuffle = useCallback(() => {
    shuffleOptions();
  }, [shuffleOptions]);

  const handleModeChange = useCallback(
    (newMode: AppMode) => {
      setMode(newMode);
      resetGroups();
    },
    [resetGroups],
  );

  const isBusy = isSpinning || isDividing;

  return (
    <div className="container">
      <LanguageSwitcher />
      {mode === "roulette" && (
        <RouletteHistory history={history} onClear={clearHistory} />
      )}
      <h1 className="main-title">🎯 Lucky Roulette</h1>

      <ModeSwitcher mode={mode} onChange={handleModeChange} disabled={isBusy} />

      <RouletteInput
        optionsText={optionsText}
        onChange={handleOptionsChange}
        onShuffle={handleShuffle}
        canShuffle={options.length > 1 && !isBusy}
        disabled={isBusy}
        shuffleCount={shuffleCount}
        onShuffleCountChange={handleShuffleCountChange}
      />

      {mode === "roulette" && (
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

          <div className="spin-controls">
            <button
              onClick={divide}
              disabled={options.length < 2 || isDividing || groupCount > options.length}
              className="divide-button"
            >
              {t("grouping.divide")}
            </button>
            <label className="quick-mode-label">
              <input
                type="checkbox"
                checked={quickMode}
                onChange={handleQuickModeChange}
                disabled={isDividing}
                className="quick-mode-checkbox"
              />
              {t("app.quickMode")}
            </label>
          </div>

          {isDividing && (
            <GroupAnimation
              items={animationItems}
              step={animationStep}
              totalSteps={totalAnimationSteps}
            />
          )}

          {groups && !isDividing && (
            <GroupResultDisplay
              groups={groups}
              actions={<GroupActions groups={groups} onSuccess={showSnackbar} />}
            />
          )}
        </div>
      )}

      {mode === "battle" && (
        <BattleMode
          options={options}
          onFinish={addHistoryEntry}
          onSuccess={showSnackbar}
        />
      )}

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
