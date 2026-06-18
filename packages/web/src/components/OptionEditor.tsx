import { type ChangeEvent, type FC, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { COLORS, getColorBrightness } from "@tainakanchu/roulette-core";

interface OptionEditorProps {
  optionsText: string;
  options: string[];
  newOption: string;
  showBulkEdit: boolean;
  disabled?: boolean;
  onNewOptionChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onNewOptionKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
  onAddOption: () => void;
  onRemoveOption: (index: number) => void;
  onClearOptions: () => void;
  onToggleBulkEdit: () => void;
  onBulkChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  shuffleCount: number;
  onShuffleCountChange: (e: ChangeEvent<HTMLInputElement>) => void;
  onShuffle: () => void;
  canShuffle: boolean;
}

export const OptionEditor: FC<OptionEditorProps> = ({
  optionsText,
  options,
  newOption,
  showBulkEdit,
  disabled = false,
  onNewOptionChange,
  onNewOptionKeyDown,
  onAddOption,
  onRemoveOption,
  onClearOptions,
  onToggleBulkEdit,
  onBulkChange,
  shuffleCount,
  onShuffleCountChange,
  onShuffle,
  canShuffle,
}) => {
  const { t } = useTranslation();
  const hasOptions = options.length > 0;

  return (
    <div className="option-editor">
      <div className="option-editor-header">
        <h2 className="section-title">✏️ {t("input.title")}</h2>
        <div className="option-editor-tools">
          <button
            type="button"
            className="option-tool-button"
            onClick={onToggleBulkEdit}
          >
            ✎ {t("ui.bulk")}
          </button>
          <button
            type="button"
            className="option-tool-button option-tool-button--danger"
            onClick={onClearOptions}
            disabled={!hasOptions}
          >
            🗑 {t("ui.clear")}
          </button>
        </div>
      </div>

      <div className="chip-tray">
        {options.map((label, index) => {
          const color = COLORS[index % COLORS.length];
          const textColor =
            getColorBrightness(color) > 128 ? "#1a1330" : "#ffffff";
          return (
            <span
              key={`${index}-${label}`}
              className="chip"
              style={{ background: color, color: textColor }}
            >
              {label}
              <button
                type="button"
                className="chip-remove"
                onClick={() => onRemoveOption(index)}
                aria-label={`remove ${label}`}
              >
                ×
              </button>
            </span>
          );
        })}
        {!hasOptions && (
          <span className="chip-tray-empty">{t("ui.empty")}</span>
        )}
      </div>

      <div className="option-add-row">
        <input
          type="text"
          className="option-add-input"
          value={newOption}
          onChange={onNewOptionChange}
          onKeyDown={onNewOptionKeyDown}
          disabled={disabled}
          placeholder={t("ui.add")}
        />
        <button
          type="button"
          className="option-add-button"
          onClick={onAddOption}
          disabled={disabled}
          aria-label={t("ui.add")}
        >
          ＋
        </button>
      </div>

      {showBulkEdit && (
        <textarea
          className="options-input"
          value={optionsText}
          onChange={onBulkChange}
          disabled={disabled}
          placeholder={t("input.placeholder")}
          rows={5}
        />
      )}

      <div className="shuffle-row">
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
        <button
          type="button"
          className="shuffle-button"
          onClick={onShuffle}
          disabled={!canShuffle}
        >
          🔀 {t("input.shuffle")}
        </button>
      </div>
    </div>
  );
};
