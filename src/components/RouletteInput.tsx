import { type ChangeEvent, type FC } from "react";

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
  return (
    <div className="input-section">
      <h2 className="section-title">選択肢を入力してください</h2>
      <textarea
        value={optionsText}
        onChange={onChange}
        disabled={disabled}
        placeholder="選択肢を改行で区切って入力してください"
        rows={5}
        className="options-input"
      />
      <div className="input-actions">
        <div className="shuffle-controls">
          <label htmlFor="shuffle-count" className="shuffle-count-label">
            シャッフル回数:
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
          シャッフル
        </button>
      </div>
      <p className="help-text">
        ※
        URLのoptionsクエリパラメータでカンマ区切りの選択肢を指定することもできます
        <br />
        例: ?options=選択肢1,選択肢2,選択肢3
      </p>
    </div>
  );
};
