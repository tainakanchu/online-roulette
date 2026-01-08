import { useTranslation } from "react-i18next";

interface RouletteResultProps {
  isSpinning: boolean;
  currentOption: string;
}

export const RouletteResult: React.FC<RouletteResultProps> = ({
  isSpinning,
  currentOption,
}) => {
  const { t } = useTranslation();

  return (
    <div
      className={`result ${isSpinning ? "spinning" : ""} ${
        currentOption ? "has-result" : ""
      }`}
    >
      <div className="result-content">
        {isSpinning ? (
          <div className="loading-text">{t("result.selecting")}</div>
        ) : currentOption ? (
          <>
            <div className="result-label">{t("result.label")}</div>
            <div className="result-value">{currentOption}</div>
          </>
        ) : (
          <div className="default-text">{t("result.default")}</div>
        )}
      </div>
    </div>
  );
};
