interface RouletteInputProps {
  optionsText: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
}

export const RouletteInput: React.FC<RouletteInputProps> = ({
  optionsText,
  onChange,
}) => {
  return (
    <div className="input-section">
      <h2 className="section-title">選択肢を入力してください</h2>
      <textarea
        value={optionsText}
        onChange={onChange}
        placeholder="選択肢を改行で区切って入力してください"
        rows={5}
        className="options-input"
      />
      <p className="help-text">
        ※
        URLのoptionsクエリパラメータでカンマ区切りの選択肢を指定することもできます
        <br />
        例: ?options=選択肢1,選択肢2,選択肢3
      </p>
    </div>
  );
};
