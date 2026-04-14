import { type FC } from "react";
import { useTranslation } from "react-i18next";

export type AppMode = "roulette" | "grouping";

interface ModeSwitcherProps {
  mode: AppMode;
  onChange: (mode: AppMode) => void;
  disabled?: boolean;
}

export const ModeSwitcher: FC<ModeSwitcherProps> = ({
  mode,
  onChange,
  disabled = false,
}) => {
  const { t } = useTranslation();

  return (
    <div className="mode-switcher">
      <button
        type="button"
        className={`mode-switcher-tab ${mode === "roulette" ? "active" : ""}`}
        onClick={() => onChange("roulette")}
        disabled={disabled}
      >
        🎯 {t("mode.roulette")}
      </button>
      <button
        type="button"
        className={`mode-switcher-tab ${mode === "grouping" ? "active" : ""}`}
        onClick={() => onChange("grouping")}
        disabled={disabled}
      >
        👥 {t("mode.grouping")}
      </button>
    </div>
  );
};
