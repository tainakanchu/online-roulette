export interface RouletteHistoryEntry {
  result: string;
  timestamp: number;
}

export interface RouletteHistory {
  entries: RouletteHistoryEntry[];
}