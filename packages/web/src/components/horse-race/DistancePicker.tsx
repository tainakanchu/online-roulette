import { type ChangeEvent, type FC, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  DISTANCE_PRESETS,
  DISTANCE_STEP,
  MAX_DISTANCE,
  MIN_DISTANCE,
  distanceCategory,
} from "@tainakanchu/roulette-core";

// スライダーを動かしている間はオッズを再計算しないよう、少し待ってから確定する
const COMMIT_DELAY_MS = 250;

interface DistancePickerProps {
  value: number;
  onChange: (meters: number) => void;
  disabled: boolean;
}

export const DistancePicker: FC<DistancePickerProps> = ({ value, onChange, disabled }) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    []
  );

  const commit = (meters: number, immediate: boolean) => {
    setDraft(meters);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    if (immediate) {
      onChange(meters);
      return;
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      onChange(meters);
    }, COMMIT_DELAY_MS);
  };

  const handleSlider = (e: ChangeEvent<HTMLInputElement>) => {
    const meters = Number(e.target.value);
    if (Number.isFinite(meters)) commit(meters, false);
  };

  const category = distanceCategory(draft);
  const label = t("race.meters", { meters: draft });

  return (
    <div className="race-distance">
      <div className="race-distance-head">
        <span className="race-distance-label">{t("race.distance")}</span>
        <span className="race-distance-value">{label}</span>
        <span className={`race-distance-category race-distance-category--${category}`}>
          {t(`race.categories.${category}`)}
        </span>
      </div>
      <input
        type="range"
        className="race-distance-slider"
        min={MIN_DISTANCE}
        max={MAX_DISTANCE}
        step={DISTANCE_STEP}
        value={draft}
        onChange={handleSlider}
        disabled={disabled}
        aria-label={t("race.distance")}
        aria-valuetext={`${label} ${t(`race.categories.${category}`)}`}
      />
      <div className="race-distance-presets">
        {DISTANCE_PRESETS.map((meters) => (
          <button
            key={meters}
            type="button"
            className={`race-distance-preset ${draft === meters ? "is-active" : ""}`}
            onClick={() => commit(meters, true)}
            disabled={disabled}
            aria-pressed={draft === meters}
          >
            {meters}
          </button>
        ))}
      </div>
    </div>
  );
};
