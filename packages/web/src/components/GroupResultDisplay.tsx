import { type FC, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { getColorBrightness, type GroupResult } from "@tainakanchu/roulette-core";
import { generateGroupResultImage } from "../utils/imageUtils";
import { ImageActions } from "./ImageActions";

interface GroupResultDisplayProps {
  groups: GroupResult[];
  /** 画像コピー/ダウンロードの結果を通知する */
  onNotify?: (message: string) => void;
}

export const GroupResultDisplay: FC<GroupResultDisplayProps> = ({
  groups,
  onNotify,
}) => {
  const { t, i18n } = useTranslation();

  const getResultBlob = useCallback(
    () =>
      generateGroupResultImage({
        groups,
        labels: {
          title: t("grouping.resultTitle"),
          membersLabel: (count: number) => t("grouping.members", { count }),
        },
        language: i18n.language,
      }),
    [groups, i18n.language, t]
  );

  return (
    <div className="group-result">
      {onNotify && (
        <ImageActions
          getBlob={getResultBlob}
          isVisible
          onSuccess={onNotify}
          filenamePrefix="group-result"
          className="image-actions--card"
        />
      )}
      <h3 className="group-result-title">🎊 {t("grouping.resultTitle")}</h3>
      <div className="group-result-grid">
        {groups.map((group, index) => {
          const textColor =
            getColorBrightness(group.color) > 128 ? "#1a1330" : "#ffffff";
          return (
            <div
              key={index}
              className="group-card"
              style={{ animationDelay: `${index * 0.05}s` }}
            >
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
