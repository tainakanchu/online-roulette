import { type ChangeEvent, type FC, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { readLocalStorage, writeLocalStorage } from "../utils/localStorage";
import { useBattleMode } from "../hooks/useBattleMode";
import { generateBattleResultImage } from "../utils/imageUtils";
import { BattleBars } from "./BattleBars";
import { BattleControls } from "./BattleControls";
import { ImageActions } from "./ImageActions";

const DRAW_COUNT_STORAGE_KEY = "roulette-battle-draw-count";
const DEFAULT_DRAW_COUNT = 1000;

interface BattleModeProps {
  options: string[];
  onFinish?: (winner: string) => void;
  /** 画像コピー/ダウンロードの結果を通知する */
  onNotify?: (message: string) => void;
}

export const BattleMode: FC<BattleModeProps> = ({
  options,
  onFinish,
  onNotify,
}) => {
  const { t, i18n } = useTranslation();

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
    countdownValue,
    isCountingDown,
    result,
    start,
    reset,
  } = useBattleMode({
    options,
    drawCount,
    onFinish,
  });

  const canStart = options.length >= 2 && drawCount >= 1;
  const locked = isRunning || isCountingDown;
  const winner = result?.winner ?? null;
  const racing = isRunning || isSuddenDeath;

  // 現在の首位（同数の場合は先に登場した方）
  const anyCount = counts.some((c) => c > 0);
  let leaderIdx = -1;
  let leaderMax = -1;
  counts.forEach((count, i) => {
    if (count > leaderMax) {
      leaderMax = count;
      leaderIdx = i;
    }
  });
  const leaderActive = racing && anyCount && leaderIdx >= 0;
  const leaderName = leaderIdx >= 0 ? options[leaderIdx] : "";

  const getResultBlob = useCallback(async () => {
    if (!result) throw new Error("No battle result");
    return generateBattleResultImage({
      options,
      counts: result.counts,
      winner: result.winner,
      drawCount: result.counts.reduce((sum, count) => sum + count, 0),
      labels: {
        title: t("mode.battle"),
        winnerLabel: t("battle.winner"),
        drawsLabel: t("battle.drawCount"),
      },
      language: i18n.language,
    });
  }, [i18n.language, options, result, t]);

  const countdownDisplay =
    countdownValue === 0
      ? t("ui.go")
      : countdownValue != null
        ? String(countdownValue)
        : "";

  return (
    <div className="battle-mode">
      <BattleControls
        drawCount={drawCount}
        onDrawCountChange={handleDrawCountChange}
        onStart={start}
        onReset={reset}
        locked={locked}
        canStart={canStart}
        processedCount={processedCount}
        hasResult={result !== null}
      />

      {isCountingDown && (
        <div className="battle-countdown">
          <div className="battle-countdown-flag">🏁</div>
          <div className="battle-countdown-value">{countdownDisplay}</div>
        </div>
      )}

      {leaderActive && (
        <div className="battle-leader">
          🔥 {t("ui.leading")}: <span className="battle-leader-name">{leaderName}</span>
        </div>
      )}

      {isSuddenDeath && (
        <div className="battle-sudden-death">
          ⚡ {t("battle.suddenDeath", { count: suddenDeathCount })}
        </div>
      )}

      {options.length === 0 ? (
        <p className="battle-empty">{t("battle.empty")}</p>
      ) : (
        <BattleBars
          options={options}
          counts={counts}
          winner={winner}
          racing={racing}
        />
      )}

      {result && (
        <div className="battle-winner">
          {onNotify && (
            <ImageActions
              getBlob={getResultBlob}
              isVisible
              onSuccess={onNotify}
              filenamePrefix="battle-result"
              className="image-actions--card"
            />
          )}
          <div className="battle-winner-label">{t("battle.winner")}</div>
          <div className="battle-winner-value">{result.winner}</div>
        </div>
      )}
    </div>
  );
};
