import type { FC } from "react";
import { useTranslation } from "react-i18next";
import {
  TRACK_GOINGS,
  TRACK_SURFACES,
  type TrackGoing,
  type TrackSurface,
} from "../../utils/raceCourse";

interface CoursePickerProps {
  surface: TrackSurface;
  going: TrackGoing;
  onSurfaceChange: (surface: TrackSurface) => void;
  onGoingChange: (going: TrackGoing) => void;
  disabled: boolean;
}

/** コース（芝・ダート）と馬場状態（良〜不良）の選択 */
export const CoursePicker: FC<CoursePickerProps> = ({
  surface,
  going,
  onSurfaceChange,
  onGoingChange,
  disabled,
}) => {
  const { t } = useTranslation();

  return (
    <div className="race-course">
      <div className="race-course-group" role="group" aria-label={t("race.course.surface")}>
        <span className="race-course-label">{t("race.course.surface")}</span>
        {TRACK_SURFACES.map((value) => (
          <button
            key={value}
            type="button"
            className={`race-course-option race-course-option--${value} ${surface === value ? "is-active" : ""}`}
            onClick={() => onSurfaceChange(value)}
            disabled={disabled}
            aria-pressed={surface === value}
          >
            {t(`race.course.surfaces.${value}`)}
          </button>
        ))}
      </div>
      <div className="race-course-group" role="group" aria-label={t("race.course.going")}>
        <span className="race-course-label">{t("race.course.going")}</span>
        {TRACK_GOINGS.map((value) => (
          <button
            key={value}
            type="button"
            className={`race-course-option race-course-option--going ${going === value ? "is-active" : ""}`}
            onClick={() => onGoingChange(value)}
            disabled={disabled}
            aria-pressed={going === value}
          >
            {t(`race.course.goings.${surface}.${value}`)}
          </button>
        ))}
      </div>
    </div>
  );
};
