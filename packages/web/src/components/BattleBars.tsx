import { type FC, useMemo } from "react";
import { COLORS } from "@tainakanchu/roulette-core";

const ROW_HEIGHT_PX = 40;

interface BattleBarsProps {
  options: string[];
  counts: number[];
  winner: string | null;
}

export const BattleBars: FC<BattleBarsProps> = ({ options, counts, winner }) => {
  const maxCount = Math.max(1, ...counts);

  const rankByIndex = useMemo(() => {
    const entries = options.map((_, i) => ({
      index: i,
      count: counts[i] ?? 0,
    }));
    entries.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.index - b.index;
    });
    const map = new Map<number, number>();
    entries.forEach((entry, rank) => map.set(entry.index, rank));
    return map;
  }, [options, counts]);

  return (
    <div
      className="battle-bars"
      style={{ height: `${options.length * ROW_HEIGHT_PX}px` }}
    >
      {options.map((option, index) => {
        const count = counts[index] ?? 0;
        const widthPct = (count / maxCount) * 100;
        const color = COLORS[index % COLORS.length];
        const isWinner = winner !== null && option === winner;
        const rank = rankByIndex.get(index) ?? 0;
        return (
          <div
            key={`${index}-${option}`}
            className={`battle-bar-row ${isWinner ? "is-winner" : ""}`}
            style={{ transform: `translateY(${rank * ROW_HEIGHT_PX}px)` }}
          >
            <div className="battle-bar-label" title={option}>
              {option}
            </div>
            <div className="battle-bar-track">
              <div
                className="battle-bar-fill"
                style={{
                  width: `${widthPct}%`,
                  backgroundColor: color,
                }}
              />
              <span className="battle-bar-count">{count}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
};
