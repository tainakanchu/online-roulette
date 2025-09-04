import { useState } from "react";
import type { RouletteHistory as RouletteHistoryType } from "../types/history";

interface RouletteHistoryProps {
  history: RouletteHistoryType;
  onClear: () => void;
}

export const RouletteHistory = ({ history, onClear }: RouletteHistoryProps) => {
  const [isOpen, setIsOpen] = useState(false);

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString("ja-JP", {
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
        aria-label="履歴を表示"
      >
        📜 履歴 {history.entries.length > 0 && `(${history.entries.length})`}
      </button>

      {isOpen && (
        <div className="history-modal-overlay" onClick={() => setIsOpen(false)}>
          <div 
            className="history-modal" 
            onClick={(e) => e.stopPropagation()}
          >
            <div className="history-header">
              <h2>🎯 当選履歴</h2>
              <button
                className="history-close-button"
                onClick={() => setIsOpen(false)}
                aria-label="閉じる"
              >
                ✕
              </button>
            </div>

            <div className="history-content">
              {history.entries.length === 0 ? (
                <p className="history-empty">まだ履歴がありません</p>
              ) : (
                <>
                  <div className="history-actions">
                    <button
                      className="history-clear-button"
                      onClick={() => {
                        if (window.confirm("履歴をすべて削除しますか？")) {
                          onClear();
                        }
                      }}
                    >
                      すべて削除
                    </button>
                  </div>
                  <ul className="history-list">
                    {history.entries.map((entry, index) => (
                      <li key={`${entry.timestamp}-${index}`} className="history-item">
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