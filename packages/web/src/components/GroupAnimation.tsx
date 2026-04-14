import { type FC } from "react";
import { useTranslation } from "react-i18next";
import { COLORS, getColorBrightness } from "@tainakanchu/roulette-core";

interface GroupAnimationProps {
  items: string[];
  step: number;
  totalSteps: number;
}

export const GroupAnimation: FC<GroupAnimationProps> = ({
  items,
  step,
  totalSteps,
}) => {
  const { t } = useTranslation();
  const progress = Math.min(step / totalSteps, 1);

  return (
    <div className="group-animation">
      <div className="group-animation-header">
        <span className="group-animation-label">
          {t("grouping.dividing")}
        </span>
        <div className="group-animation-progress">
          <div
            className="group-animation-progress-bar"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      </div>
      <div className="group-animation-items">
        {items.map((item, i) => {
          const color = COLORS[i % COLORS.length];
          const textColor =
            getColorBrightness(color) > 128 ? "#000000" : "#FFFFFF";
          return (
            <span
              key={i}
              className="group-animation-item"
              style={{ backgroundColor: color, color: textColor }}
            >
              {item}
            </span>
          );
        })}
      </div>
    </div>
  );
};
