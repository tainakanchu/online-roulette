import { type ChangeEvent, type FC } from "react";

interface RouletteInputProps {
  optionsText: string;
  onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
  onShuffle: () => void;
  canShuffle: boolean;
  disabled?: boolean;
}

export const RouletteInput: FC<RouletteInputProps> = ({
  optionsText,
  onChange,
  onShuffle,
  canShuffle,
  disabled = false,
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
