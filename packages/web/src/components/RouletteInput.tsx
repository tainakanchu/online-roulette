import { type ChangeEvent, type FC } from "react";
import { useTranslation } from "react-i18next";

interface RouletteInputProps {
  optionsText: string;
  onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  onShuffle: () => void;
  canShuffle: boolean;
  disabled?: boolean;
  shuffleCount: number;
  onShuffleCountChange: (e: ChangeEvent<HTMLInputElement>) => void;
}

export const RouletteInput: FC<RouletteInputProps> = ({
  optionsText,
  onChange,
  onShuffle,
  canShuffle,
  disabled = false,
  shuffleCount,
  onShuffleCountChange,
}) => {
  const { t } = useTranslation();

  return (
    <div className="input-section">
      <h2 className="section-title">{t("input.title")}</h2>
      <textarea
        value={optionsText}
        onChange={onChange}
        disabled={disabled}
        placeholder={t("input.placeholder")}
        rows={5}
        className="options-input"
      />
      <div className="input-actions">
        <div className="shuffle-controls">
          <label htmlFor="shuffle-count" className="shuffle-count-label">
            {t("input.shuffleCount")}
          </label>
          <input
            id="shuffle-count"
            type="number"
            min="1"
            value={shuffleCount}
            onChange={onShuffleCountChange}
            disabled={disabled}
            className="shuffle-count-input"
          />
        </div>
        <button
          type="button"
          onClick={onShuffle}
          disabled={!canShuffle}
          className="shuffle-button"
        >
          {t("input.shuffle")}
        </button>
      </div>
      <p className="help-text">
        {t("input.helpText")}
        <br />
        {t("input.helpExample")}
      </p>
    </div>
  );
};
