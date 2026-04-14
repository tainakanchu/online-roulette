import { type FC } from "react";
import { useTranslation } from "react-i18next";
import { getColorBrightness, type GroupResult } from "@tainakanchu/roulette-core";

interface GroupResultDisplayProps {
  groups: GroupResult[];
}

export const GroupResultDisplay: FC<GroupResultDisplayProps> = ({ groups }) => {
  const { t } = useTranslation();

  return (
    <div className="group-result">
      <h3 className="group-result-title">{t("grouping.resultTitle")}</h3>
      <div className="group-result-grid">
        {groups.map((group, index) => {
          const textColor =
            getColorBrightness(group.color) > 128 ? "#000000" : "#FFFFFF";
          return (
            <div key={index} className="group-card">
              <div
                className="group-card-header"
                style={{ backgroundColor: group.color, color: textColor }}
              >
                <span className="group-card-label">{group.label}</span>
                <span className="group-card-count">
                  {t("grouping.members", { count: group.items.length })}
                </span>
              </div>
              <ul className="group-card-members">
                {group.items.map((item, i) => (
                  <li key={i} className="group-card-member">
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>
  );
};
