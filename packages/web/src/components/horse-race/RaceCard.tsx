import { type FC, memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { activityScore, distanceCategory } from "@tainakanchu/roulette-core";
import type { GitHubStatus, RaceEntry } from "../../hooks/useRaceCard";
import { MAX_RACE_NAME_LENGTH, RACE_GRADES, type RaceGrade } from "../../utils/horseRaceStorage";
import { frameNumber } from "../../utils/raceFrame";

// JRA の枠色（1 白 2 黒 3 赤 4 青 5 黄 6 緑 7 橙 8 桃）
const FRAME_COLORS = [
  { bg: "#ffffff", fg: "#111" },
  { bg: "#111111", fg: "#fff" },
  { bg: "#e53935", fg: "#fff" },
  { bg: "#1e63d6", fg: "#fff" },
  { bg: "#fdd835", fg: "#111" },
  { bg: "#2e9d47", fg: "#fff" },
  { bg: "#fb8c00", fg: "#111" },
  { bg: "#f48fb1", fg: "#111" },
];

const trainingGrade = (entry: RaceEntry): string | null => {
  if (!entry.activity) return null;
  const score = activityScore(entry.activity);
  if (score >= 0.85) return "S";
  if (score >= 0.65) return "A";
  if (score >= 0.4) return "B";
  if (score >= 0.15) return "C";
  return "D";
};

interface RaceCardProps {
  entries: RaceEntry[];
  /** 距離（m） */
  distance: number;
  /** ユーザー入力のレース名（未入力なら空文字） */
  raceName: string;
  onRaceNameChange: (name: string) => void;
  raceGrade: RaceGrade;
  onRaceGradeChange: (grade: RaceGrade) => void;
  bet: number | null;
  onBet: (index: number | null) => void;
  locked: boolean;
  logins: Record<string, string>;
  onLoginChange: (name: string, login: string) => void;
  githubStatus: Record<string, GitHubStatus>;
  onFetchGitHub: () => void | Promise<void>;
  raceCount: number;
  onClearHistory: () => void;
}

// レース中は実況・位置順の更新で親が頻繁に再描画されるので、出走表はメモ化しておく
export const RaceCard: FC<RaceCardProps> = memo(function RaceCard({
  entries,
  distance,
  raceName,
  onRaceNameChange,
  raceGrade,
  onRaceGradeChange,
  bet,
  onBet,
  locked,
  logins,
  onLoginChange,
  githubStatus,
  onFetchGitHub,
  raceCount,
  onClearHistory,
}) {
  const { t } = useTranslation();
  const [showGitHub, setShowGitHub] = useState(false);
  const defaultRaceName = t("race.vision.title");
  const [draftName, setDraftName] = useState(raceName);
  useEffect(() => setDraftName(raceName), [raceName]);
  const favorite = entries.find((e) => e.mark === "◎");
  const fieldSize = entries.length;
  const category = t(`race.categories.${distanceCategory(distance)}`);
  const loadingAny = Object.values(githubStatus).includes("loading");

  return (
    <section className="race-card" aria-label={t("race.card.title")}>
      <header className="race-card-masthead">
        <div className="race-card-masthead-title">{t("race.card.title")}</div>
        <div className="race-card-masthead-meta">
          <span className="race-card-racename">
            {t("race.card.raceNamePrefix")}
            <label className="race-card-racename-field" title={t("race.card.raceNameLabel")}>
              <input
                type="text"
                className="race-card-racename-input"
                value={draftName}
                placeholder={defaultRaceName}
                maxLength={MAX_RACE_NAME_LENGTH}
                disabled={locked}
                aria-label={t("race.card.raceNameLabel")}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={() => onRaceNameChange(draftName)}
                onKeyDown={(e) => {
                  // IME の変換確定の Enter では確定しない（Safari は keyCode 229）
                  if (e.key !== "Enter" || e.nativeEvent.isComposing || e.keyCode === 229) return;
                  e.currentTarget.blur();
                }}
                autoComplete="off"
                spellCheck={false}
              />
              <span className="race-card-racename-icon" aria-hidden="true">
                ✎
              </span>
            </label>
            <span className="race-card-grade-wrap">
              <select
                className={`race-card-grade race-card-grade--${raceGrade || "none"}`}
                value={raceGrade}
                disabled={locked}
                aria-label={t("race.card.gradeLabel")}
                onChange={(e) => onRaceGradeChange(e.target.value as RaceGrade)}
              >
                {RACE_GRADES.map((grade) => (
                  <option key={grade || "none"} value={grade}>
                    {grade || t("race.card.gradeNone")}
                  </option>
                ))}
              </select>
            </span>
          </span>
          <span>
            {t("race.card.course", { meters: distance, category })} · {t("race.card.field", { count: fieldSize })}
          </span>
        </div>
      </header>

      {favorite && (
        <p className="race-card-headline">
          {t(`race.card.headlines.${favorite.style}`, { name: favorite.name })}
        </p>
      )}

      <div className="race-card-table-wrap">
        <table className="race-card-table">
          <thead>
            <tr>
              <th>{t("race.card.frame")}</th>
              <th>{t("race.card.number")}</th>
              <th>{t("race.card.mark")}</th>
              <th className="race-card-col-name">{t("race.card.name")}</th>
              <th>{t("race.card.style")}</th>
              <th>{t("race.card.form")}</th>
              <th>{t("race.card.training")}</th>
              <th>{t("race.card.rating")}</th>
              <th>{t("race.card.odds")}</th>
              <th>{t("race.card.bet")}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const frame = frameNumber(entry.number, fieldSize);
              const frameColor = FRAME_COLORS[frame - 1];
              const grade = trainingGrade(entry);
              const selected = bet === entry.index;
              return (
                <tr key={`${entry.index}-${entry.name}`} className={selected ? "is-bet" : ""}>
                  <td>
                    <span
                      className="race-card-frame"
                      style={{ background: frameColor.bg, color: frameColor.fg }}
                    >
                      {frame}
                    </span>
                  </td>
                  <td>
                    <span className="race-card-number" style={{ background: entry.color }}>
                      {entry.number}
                    </span>
                  </td>
                  <td className="race-card-mark">{entry.mark}</td>
                  <td className="race-card-col-name">
                    <div className="race-card-name" title={entry.name}>
                      {entry.name}
                    </div>
                    <div className="race-card-pop">
                      {t("race.card.popularity", { rank: entry.popularity })}
                    </div>
                  </td>
                  <td className="race-card-style">{t(`race.styles.${entry.style}`)}</td>
                  <td>
                    {entry.finishes.length === 0 ? (
                      <span className="race-card-debut">{t("race.card.debut")}</span>
                    ) : (
                      <span className="race-card-form">
                        {entry.finishes.map((f, i) => (
                          <span
                            key={i}
                            className={`race-card-finish race-card-finish--${Math.min(f.position, 4)}`}
                            title={`${f.position}/${f.fieldSize}`}
                          >
                            {f.position}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td>
                    {grade ? (
                      <span
                        className={`race-card-grade race-card-grade--${grade}`}
                        title={t("race.github.summary", {
                          commits: entry.activity?.commits ?? 0,
                          prs: entry.activity?.pullRequests ?? 0,
                          reviews: entry.activity?.reviews ?? 0,
                          issues: entry.activity?.issues ?? 0,
                        })}
                      >
                        {grade}
                      </span>
                    ) : (
                      <span className="race-card-muted">—</span>
                    )}
                  </td>
                  <td className="race-card-rating">{entry.rating}</td>
                  <td className="race-card-odds">{entry.odds.toFixed(1)}</td>
                  <td>
                    <button
                      type="button"
                      className={`race-card-bet ${selected ? "is-selected" : ""}`}
                      onClick={() => onBet(selected ? null : entry.index)}
                      disabled={locked}
                      aria-pressed={selected}
                      aria-label={t("race.bet.pick", { name: entry.name })}
                    >
                      {selected ? "🎫" : "＋"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="race-card-note">{t("race.card.note")}</p>

      <div className="race-card-footer">
        <button
          type="button"
          className="race-card-link"
          onClick={() => setShowGitHub((v) => !v)}
          aria-expanded={showGitHub}
        >
          🐙 {t("race.github.title")} {showGitHub ? "▲" : "▼"}
        </button>
        {raceCount > 0 && (
          <button
            type="button"
            className="race-card-link"
            disabled={locked}
            onClick={() => {
              if (window.confirm(t("race.card.clearConfirm"))) onClearHistory();
            }}
          >
            {t("race.card.clearHistory", { count: raceCount })}
          </button>
        )}
      </div>

      {showGitHub && (
        <div className="race-github">
          <p className="race-github-desc">{t("race.github.description")}</p>
          <div className="race-github-list">
            {entries.map((entry) => {
              const login = logins[entry.name] ?? "";
              const status = login ? githubStatus[login.toLowerCase()] : undefined;
              return (
                <label key={`${entry.index}-${entry.name}`} className="race-github-row">
                  <span className="race-github-name">
                    <span className="race-card-number" style={{ background: entry.color }}>
                      {entry.number}
                    </span>
                    {entry.name}
                  </span>
                  <input
                    type="text"
                    className="race-github-input"
                    placeholder={t("race.github.placeholder")}
                    defaultValue={login}
                    disabled={locked}
                    onBlur={(e) => onLoginChange(entry.name, e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <span className="race-github-status">
                    {status && status !== "idle"
                      ? t(`race.github.status.${status}`)
                      : entry.activity
                        ? t("race.github.summary", {
                            commits: entry.activity.commits,
                            prs: entry.activity.pullRequests,
                            reviews: entry.activity.reviews,
                            issues: entry.activity.issues,
                          })
                        : ""}
                  </span>
                </label>
              );
            })}
          </div>
          <button
            type="button"
            className="race-github-fetch"
            onClick={() => void onFetchGitHub()}
            disabled={locked || loadingAny}
          >
            {loadingAny ? t("race.github.fetching") : t("race.github.fetch")}
          </button>
        </div>
      )}
    </section>
  );
});
