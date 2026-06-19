import { type FC, useMemo } from "react";
import { COLORS } from "@tainakanchu/roulette-core";

const ROW_HEIGHT_PX = 40;

interface BattleBarsProps {
  options: string[];
  counts: number[];
  winner: string | null;
  /** レース中（カウント進行 or サドンデス）かどうか */
  racing: boolean;
}

const medalFor = (rank: number): string => {
  if (rank === 0) return "🥇";
  if (rank === 1) return "🥈";
  if (rank === 2) return "🥉";
  return "";
};

export const BattleBars: FC<BattleBarsProps> = ({
  options,
  counts,
  winner,
  racing,
}) => {
  const maxCount = Math.max(1, ...counts);
  const anyCount = counts.some((c) => c > 0);

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
        const isLeader = anyCount && rank === 0;
        const medal = anyCount ? medalFor(rank) : "";
        const crown = racing && isLeader ? "👑 " : "";
        const hot = isWinner || (racing && isLeader);
        const filter = isWinner
          ? "drop-shadow(0 0 9px rgba(255,210,63,.7))"
          : racing && isLeader
            ? "drop-shadow(0 0 8px rgba(255,210,63,.55))"
            : "none";

        return (
          <div
            key={`${index}-${option}`}
            className={`battle-bar-row ${isWinner ? "is-winner" : ""}`}
            style={{ transform: `translateY(${rank * ROW_HEIGHT_PX}px)`, filter }}
          >
            <div
              className="battle-bar-label"
              title={option}
              style={{
                color: hot ? "#FFD23F" : "rgba(255,255,255,.85)",
                fontWeight: hot ? 700 : 500,
              }}
            >
              {medal ? `${medal} ` : ""}
              {crown}
              {option}
            </div>
            <div className="battle-bar-track">
              <div
                className="battle-bar-fill"
                style={{ width: `${widthPct}%`, backgroundColor: color }}
              />
              <span className="battle-bar-count">{count}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
};
