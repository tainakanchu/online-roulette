import { type ChangeEvent, type FC, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { readLocalStorage, writeLocalStorage } from "../utils/localStorage";
import { useBattleMode } from "../hooks/useBattleMode";
import { BattleBars } from "./BattleBars";
import { BattleControls } from "./BattleControls";

const DRAW_COUNT_STORAGE_KEY = "roulette-battle-draw-count";
const DEFAULT_DRAW_COUNT = 1000;

interface BattleModeProps {
  options: string[];
  onFinish?: (winner: string) => void;
}

export const BattleMode: FC<BattleModeProps> = ({ options, onFinish }) => {
  const { t } = useTranslation();

  const [drawCount, setDrawCount] = useState(() => {
    const stored = readLocalStorage(DRAW_COUNT_STORAGE_KEY);
    const parsed = stored ? Number.parseInt(stored, 10) : NaN;
    if (!Number.isNaN(parsed) && parsed >= 1) return parsed;
    return DEFAULT_DRAW_COUNT;
  });

  useEffect(() => {
    writeLocalStorage(DRAW_COUNT_STORAGE_KEY, drawCount.toString());
  }, [drawCount]);

  const handleDrawCountChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const value = Number.parseInt(e.target.value, 10);
    if (!Number.isNaN(value) && value >= 1) {
      setDrawCount(value);
    }
  }, []);

  const {
    counts,
    processedCount,
    suddenDeathCount,
    isRunning,
    isSuddenDeath,
    result,
    start,
    reset,
  } = useBattleMode({
    options,
    drawCount,
    onFinish,
  });

  const canStart = options.length >= 2 && drawCount >= 1;
  const winner = result?.winner ?? null;

  return (
    <div className="battle-mode">
      <BattleControls
        drawCount={drawCount}
        onDrawCountChange={handleDrawCountChange}
        onStart={start}
        onReset={reset}
        isRunning={isRunning}
        canStart={canStart}
        processedCount={processedCount}
        hasResult={result !== null}
      />

      {isSuddenDeath && (
        <div className="battle-sudden-death">
          ⚡ {t("battle.suddenDeath", { count: suddenDeathCount })}
        </div>
      )}

      {options.length === 0 ? (
        <p className="battle-empty">{t("battle.empty")}</p>
      ) : (
        <BattleBars options={options} counts={counts} winner={winner} />
      )}

      {result && (
        <div className="battle-winner">
          <div className="battle-winner-label">{t("battle.winner")}</div>
          <div className="battle-winner-value">{result.winner}</div>
        </div>
      )}
    </div>
  );
};
