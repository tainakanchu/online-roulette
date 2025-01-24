interface RouletteResultProps {
  isSpinning: boolean;
  currentOption: string;
}

export const RouletteResult: React.FC<RouletteResultProps> = ({
  isSpinning,
  currentOption,
}) => {
  return (
    <div
      className={`result ${isSpinning ? "spinning" : ""} ${
        currentOption ? "has-result" : ""
      }`}
    >
      <div className="result-content">
        {isSpinning ? (
          <div className="loading-text">選択中...</div>
        ) : currentOption ? (
          <>
            <div className="result-label">結果</div>
            <div className="result-value">{currentOption}</div>
          </>
        ) : (
          <div className="default-text">結果がここに表示されます</div>
        )}
      </div>
    </div>
  );
};
