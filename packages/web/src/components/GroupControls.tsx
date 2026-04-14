import { type ChangeEvent, type FC } from "react";
import { useTranslation } from "react-i18next";
import { GROUPING_METHODS, type GroupingMethod } from "@tainakanchu/roulette-core";

interface GroupControlsProps {
  groupCount: number;
  onGroupCountChange: (count: number) => void;
  groupingMethod: GroupingMethod;
  onGroupingMethodChange: (method: GroupingMethod) => void;
  maxGroups: number;
  disabled?: boolean;
}

export const GroupControls: FC<GroupControlsProps> = ({
  groupCount,
  onGroupCountChange,
  groupingMethod,
  onGroupingMethodChange,
  maxGroups,
  disabled = false,
}) => {
  const { t } = useTranslation();

  const handleCountChange = (e: ChangeEvent<HTMLInputElement>) => {
    const value = Number.parseInt(e.target.value, 10);
    if (!Number.isNaN(value) && value >= 2 && value <= maxGroups) {
      onGroupCountChange(value);
    }
  };

  const handleMethodChange = (e: ChangeEvent<HTMLSelectElement>) => {
    onGroupingMethodChange(e.target.value as GroupingMethod);
  };

  return (
    <div className="group-controls">
      <div className="group-control-row">
        <label htmlFor="group-count" className="group-control-label">
          {t("grouping.groupCount")}
        </label>
        <input
          id="group-count"
          type="number"
          min={2}
          max={maxGroups}
          value={groupCount}
          onChange={handleCountChange}
          disabled={disabled}
          className="group-count-input"
        />
      </div>
      <div className="group-control-row">
        <label htmlFor="group-theme" className="group-control-label">
          {t("grouping.theme")}
        </label>
        <select
          id="group-theme"
          value={groupingMethod}
          onChange={handleMethodChange}
          disabled={disabled}
          className="group-theme-select"
        >
          {GROUPING_METHODS.map((method) => (
            <option key={method} value={method}>
              {t(`grouping.themes.${method}`)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
};
