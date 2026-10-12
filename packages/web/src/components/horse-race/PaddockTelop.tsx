import { type FC } from "react";
import { useTranslation } from "react-i18next";
import { formatWeightChange } from "../../utils/paddock";

// パドック中継のテロップ。映している馬の馬番・馬名・馬体重（増減）・単勝オッズと人気を、画面の左下に出す。
// 新しい参加者の馬が入口から入ってきたときは「入場」の札を付ける。

interface PaddockTelopProps {
  entry:
    | {
        number: number;
        name: string;
        color: string;
        weight: number;
        change: number;
        odds: number;
        popularity: number;
      }
    | undefined;
  entering: boolean;
}

export const PaddockTelop: FC<PaddockTelopProps> = ({ entry, entering }) => {
  const { t } = useTranslation();
  if (!entry) return null;
  return (
    <div className="paddock-telop" aria-live="polite">
      <span className="paddock-telop-corner">{entering ? t("race.paddock.entering") : t("race.paddock.title")}</span>
      <span className="paddock-telop-number" style={{ background: entry.color }}>
        {entry.number}
      </span>
      <span className="paddock-telop-name">{entry.name}</span>
      <span className="paddock-telop-weight">
        {t("race.paddock.weight", { weight: entry.weight, change: formatWeightChange(entry.change) })}
      </span>
      <span className="paddock-telop-odds">{t("race.result.odds", { odds: entry.odds.toFixed(1), pop: entry.popularity })}</span>
    </div>
  );
};
