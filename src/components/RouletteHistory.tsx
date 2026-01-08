import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { RouletteHistory as RouletteHistoryType } from "../types/history";

interface RouletteHistoryProps {
  history: RouletteHistoryType;
  onClear: () => void;
}

export const RouletteHistory = ({ history, onClear }: RouletteHistoryProps) => {
  const { t, i18n } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString(i18n.language, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <>
      <button
        className="history-toggle-button"
        onClick={() => setIsOpen(!isOpen)}
        aria-label={t("history.showHistory")}
      >
        📜 {t("history.toggle")}{" "}
        {history.entries.length > 0 && `(${history.entries.length})`}
      </button>

      {isOpen && (
        <div className="history-modal-overlay" onClick={() => setIsOpen(false)}>
          <div className="history-modal" onClick={(e) => e.stopPropagation()}>
            <div className="history-header">
              <h2>🎯 {t("history.title")}</h2>
              <button
                className="history-close-button"
                onClick={() => setIsOpen(false)}
                aria-label={t("history.close")}
              >
                ✕
              </button>
            </div>

            <div className="history-content">
              {history.entries.length === 0 ? (
                <p className="history-empty">{t("history.empty")}</p>
              ) : (
                <>
                  <div className="history-actions">
                    <button
                      className="history-clear-button"
                      onClick={() => {
                        if (window.confirm(t("history.clearConfirm"))) {
                          onClear();
                        }
                      }}
                    >
                      {t("history.clearAll")}
                    </button>
                  </div>
                  <ul className="history-list">
                    {history.entries.map((entry, index) => (
                      <li
                        key={`${entry.timestamp}-${index}`}
                        className="history-item"
                      >
                        <span className="history-result">{entry.result}</span>
                        <span className="history-date">
                          {formatDate(entry.timestamp)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
