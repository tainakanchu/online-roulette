import type { RouletteHistoryEntry, RouletteHistory } from "../types/history";

const STORAGE_KEY = "roulette-history";
const MAX_HISTORY_SIZE = 100;

export const historyStorage = {
  getHistory(): RouletteHistory {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) {
        return { entries: [] };
      }
      const history = JSON.parse(stored) as RouletteHistory;
      return history;
    } catch {
      return { entries: [] };
    }
  },

  addEntry(result: string): void {
    const history = this.getHistory();
    const newEntry: RouletteHistoryEntry = {
      result,
      timestamp: Date.now(),
    };
    
    history.entries.unshift(newEntry);
    
    if (history.entries.length > MAX_HISTORY_SIZE) {
      history.entries = history.entries.slice(0, MAX_HISTORY_SIZE);
    }
    
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
    } catch (error) {
      console.error("Failed to save history:", error);
    }
  },

  clearHistory(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      console.error("Failed to clear history:", error);
    }
  },
};