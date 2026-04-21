import { type ChangeEvent, type FC } from "react";
import { useTranslation } from "react-i18next";

interface BattleControlsProps {
  drawCount: number;
  onDrawCountChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onStart: () => void;
  onReset: () => void;
  isRunning: boolean;
  canStart: boolean;
  processedCount: number;
  hasResult: boolean;
}

export const BattleControls: FC<BattleControlsProps> = ({
  drawCount,
  onDrawCountChange,
  onStart,
  onReset,
  isRunning,
  canStart,
  processedCount,
  hasResult,
}) => {
  const { t } = useTranslation();

  return (
    <div className="battle-controls">
      <div className="battle-draw-count">
        <label htmlFor="battle-draw-count" className="battle-draw-count-label">
          {t("battle.drawCount")}
        </label>
        <input
          id="battle-draw-count"
          type="number"
          min="1"
          max="100000"
          step="1"
          value={drawCount}
          onChange={onDrawCountChange}
          disabled={isRunning}
          className="battle-draw-count-input"
        />
      </div>
      <div className="battle-actions">
        <button
          type="button"
          onClick={onStart}
          disabled={!canStart || isRunning}
          className="battle-start-button"
        >
          {t("battle.start")}
        </button>
        <button
          type="button"
          onClick={onReset}
          disabled={isRunning || (!hasResult && processedCount === 0)}
          className="battle-reset-button"
        >
          {t("battle.reset")}
        </button>
      </div>
      <div className="battle-progress">
        {t("battle.progress", { current: processedCount, total: drawCount })}
      </div>
    </div>
  );
};
