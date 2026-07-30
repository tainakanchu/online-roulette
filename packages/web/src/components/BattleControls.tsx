import { type ChangeEvent, type FC } from "react";
import { useTranslation } from "react-i18next";

// 抽選自体は Worker でチャンク集計するため UI は固まらない。計算時間由来の実用上限
export const MAX_DRAW_COUNT = 1_000_000_000;

interface BattleControlsProps {
  drawCount: number;
  onDrawCountChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onStart: () => void;
  onReset: () => void;
  locked: boolean;
  canStart: boolean;
  processedCount: number;
  hasResult: boolean;
}

export const BattleControls: FC<BattleControlsProps> = ({
  drawCount,
  onDrawCountChange,
  onStart,
  onReset,
  locked,
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
          max={MAX_DRAW_COUNT}
          step="1"
          value={drawCount}
          onChange={onDrawCountChange}
          disabled={locked}
          className="battle-draw-count-input"
        />
      </div>
      <div className="battle-actions">
        <button
          type="button"
          onClick={onStart}
          disabled={!canStart || locked}
          className="battle-start-button"
        >
          ⚔️ {t("battle.start")}
        </button>
        <button
          type="button"
          onClick={onReset}
          disabled={!locked && !hasResult && processedCount === 0}
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
