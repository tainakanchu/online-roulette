import { useState, useCallback, useEffect } from "react";
import { historyStorage } from "../utils/historyStorage";
import type { RouletteHistory } from "../types/history";

export const useRouletteHistory = () => {
  const [history, setHistory] = useState<RouletteHistory>({ entries: [] });

  useEffect(() => {
    setHistory(historyStorage.getHistory());
  }, []);

  const addHistoryEntry = useCallback((result: string) => {
    historyStorage.addEntry(result);
    setHistory(historyStorage.getHistory());
  }, []);

  const clearHistory = useCallback(() => {
    historyStorage.clearHistory();
    setHistory({ entries: [] });
  }, []);

  return {
    history,
    addHistoryEntry,
    clearHistory,
  };
};