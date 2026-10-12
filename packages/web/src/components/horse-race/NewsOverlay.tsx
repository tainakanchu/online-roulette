import { type CSSProperties, type FC, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NewsSegment } from "../../utils/raceNews";

// レース後のニュースの画面に重ねるもの（日本の夜のニュースの体裁）。
// 左上に番組ロゴと時刻、右上にコーナー名、下に大きなテロップと字幕。メインキャスターの寄りでは右上に肩のパネル（ゴールの写真）。

interface NewsOverlayProps {
  segment: NewsSegment;
  /** 何番目のカットか（切り替わるたびにテロップを出し直す） */
  index: number;
  /** ゴールの瞬間の写真（data URL） */
  shoulder: string | null;
  raceTitle: string;
  onSkip: () => void;
}

const formatClock = (date: Date) =>
  `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;

export const NewsOverlay: FC<NewsOverlayProps> = ({ segment, index, shoulder, raceTitle, onSkip }) => {
  const { t } = useTranslation();
  const [clock, setClock] = useState(() => formatClock(new Date()));
  useEffect(() => {
    const id = window.setInterval(() => setClock(formatClock(new Date())), 5000);
    return () => window.clearInterval(id);
  }, []);

  const isOpening = segment.shot === "opening";
  const isClosing = segment.id === "closing";
  const showCorner = !isOpening && !isClosing;
  // 締めのカットの長さ（エンドカードと溶暗の時刻を CSS で決める）
  const timing = { "--news-seconds": `${segment.seconds}s` } as CSSProperties;

  return (
    <div className={`news-overlay news-overlay--${segment.shot}`} style={timing}>
      <div className="news-bug" aria-hidden="true">
        <span className="news-bug-logo">
          NEWS <b>R</b>
        </span>
        <span className="news-bug-clock">{clock}</span>
      </div>

      {isOpening && (
        <div className="news-title" aria-hidden="true">
          NEWS <b>R</b>
        </div>
      )}

      {showCorner && <div className="news-corner">{t("race.news.corner")}</div>}

      {segment.shot === "vtr" && <div className="news-vtr-mark">{t("race.news.vtrMark")}</div>}

      {segment.shot === "mainSingle" && shoulder && (
        <figure className="news-shoulder" key={`shoulder-${index}`}>
          <img src={shoulder} alt="" />
          <figcaption>{raceTitle}</figcaption>
        </figure>
      )}

      {segment.telop && (
        <div className="news-telop" key={`telop-${index}`}>
          <span className="news-telop-text">{t(segment.telop.key, segment.telop.params)}</span>
        </div>
      )}

      {segment.script && (
        <p className={`news-caption ${isClosing ? "news-caption--closing" : ""}`} key={`caption-${index}`} aria-live="polite">
          {t(segment.script.key, segment.script.params)}
        </p>
      )}

      {/* 番組の終わり: お辞儀の後にエンドカードを出し、最後は黒に溶暗（競馬場へは溶明で戻る） */}
      {isClosing && (
        <>
          <div className="news-endcard" aria-hidden="true">
            <div className="news-endcard-logo">
              NEWS <b>R</b>
            </div>
            <div className="news-endcard-text">{t("race.news.endCard")}</div>
          </div>
          <div className="news-blackout news-blackout--closing" aria-hidden="true" />
        </>
      )}

      <button type="button" className="news-skip" onClick={onSkip}>
        {t("race.news.skip")} ▶▶
      </button>
    </div>
  );
};
