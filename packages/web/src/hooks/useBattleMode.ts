import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cryptoRandom, drawBattleSequence } from "@tainakanchu/roulette-core";

const MS_PER_DRAW = 5;
const MAX_DURATION_MS = 5000;
const UI_UPDATE_INTERVAL_MS = 33;

// カウントダウン演出（3 → 2 → 1 → GO!）
const COUNTDOWN_INTERVAL_MS = 720;
const GO_HOLD_MS = 650;

// サドンデスは意図的にゆっくり見せる（一瞬で終わらないように）
const SUDDEN_DEATH_FIRST_DELAY_MS = 800;
const SUDDEN_DEATH_INTERVAL_MS = 650;
// 勝者が確定してから結果を出すまでの「タメ」
const SUDDEN_DEATH_HOLD_MS = 1200;

const calcDuration = (drawCount: number): number => {
  if (drawCount <= 0) return 0;
  return Math.min(MAX_DURATION_MS, drawCount * MS_PER_DRAW);
};

interface UseBattleModeProps {
  options: string[];
  drawCount: number;
  onFinish?: (winner: string) => void;
}

export interface BattleResult {
  winner: string;
  counts: number[];
}

export const useBattleMode = ({
  options,
  drawCount,
  onFinish,
}: UseBattleModeProps) => {
  const [counts, setCounts] = useState<number[]>(() =>
    new Array(options.length).fill(0)
  );
  const [processedCount, setProcessedCount] = useState(0);
  const [suddenDeathCount, setSuddenDeathCount] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [isSuddenDeath, setIsSuddenDeath] = useState(false);
  const [result, setResult] = useState<BattleResult | null>(null);
  // 3 | 2 | 1 | 0(=GO!) | null(=非カウントダウン)
  const [countdownValue, setCountdownValue] = useState<number | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const countdownRef = useRef<(() => void) | null>(null);

  const optionsKey = useMemo(() => options.join(",|,"), [options]);

  useEffect(() => {
    setCounts(new Array(options.length).fill(0));
    setProcessedCount(0);
    setSuddenDeathCount(0);
    setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionsKey]);

  const cancel = useCallback(() => {
    if (cancelRef.current !== null) {
      cancelRef.current();
      cancelRef.current = null;
    }
    if (countdownRef.current !== null) {
      countdownRef.current();
      countdownRef.current = null;
    }
  }, []);

  useEffect(() => () => cancel(), [cancel]);

  const reset = useCallback(() => {
    cancel();
    setIsRunning(false);
    setIsSuddenDeath(false);
    setCountdownValue(null);
    setCounts(new Array(options.length).fill(0));
    setProcessedCount(0);
    setSuddenDeathCount(0);
    setResult(null);
  }, [cancel, options.length]);

  const runRace = useCallback(() => {
    if (options.length === 0 || drawCount <= 0) return;

    const sequence = drawBattleSequence(options.length, drawCount);
    const duration = calcDuration(drawCount);
    const startTime = performance.now();
    const initialCounts = new Array(options.length).fill(0);
    setCounts(initialCounts);
    setProcessedCount(0);
    setSuddenDeathCount(0);
    setResult(null);
    setIsSuddenDeath(false);
    setIsRunning(true);

    const localCounts = [...initialCounts];
    let lastProcessed = 0;
    let lastUiUpdate = 0;

    const finishWith = (winnerIdx: number) => {
      setResult({
        winner: options[winnerIdx] ?? "",
        counts: [...localCounts],
      });
      setIsRunning(false);
      setIsSuddenDeath(false);
      cancelRef.current = null;
      onFinish?.(options[winnerIdx] ?? "");
    };

    const findUniqueTop = (): number | null => {
      let maxVal = -Infinity;
      let topIdx = 0;
      let tieCount = 0;
      for (let i = 0; i < localCounts.length; i += 1) {
        if (localCounts[i] > maxVal) {
          maxVal = localCounts[i];
          topIdx = i;
          tieCount = 1;
        } else if (localCounts[i] === maxVal) {
          tieCount += 1;
        }
      }
      return tieCount === 1 ? topIdx : null;
    };

    const runSuddenDeath = () => {
      setIsSuddenDeath(true);
      let sdCount = 0;

      const tick = () => {
        const pick = Math.floor(cryptoRandom() * options.length);
        localCounts[pick] += 1;
        sdCount += 1;
        setCounts([...localCounts]);
        setSuddenDeathCount(sdCount);

        const uniqueTop = findUniqueTop();
        if (uniqueTop !== null) {
          // 勝者が出ても一拍タメてから結果を出す
          const holdId = window.setTimeout(
            () => finishWith(uniqueTop),
            SUDDEN_DEATH_HOLD_MS
          );
          cancelRef.current = () => window.clearTimeout(holdId);
          return;
        }

        const timeoutId = window.setTimeout(tick, SUDDEN_DEATH_INTERVAL_MS);
        cancelRef.current = () => window.clearTimeout(timeoutId);
      };

      const timeoutId = window.setTimeout(tick, SUDDEN_DEATH_FIRST_DELAY_MS);
      cancelRef.current = () => window.clearTimeout(timeoutId);
    };

    const step = (now: number) => {
      const elapsed = now - startTime;
      const progress = duration === 0 ? 1 : Math.min(elapsed / duration, 1);
      const target = Math.floor(progress * sequence.length);

      if (target > lastProcessed) {
        for (let i = lastProcessed; i < target; i += 1) {
          localCounts[sequence[i]] += 1;
        }
        lastProcessed = target;
        if (now - lastUiUpdate >= UI_UPDATE_INTERVAL_MS) {
          setCounts(localCounts.slice());
          setProcessedCount(target);
          lastUiUpdate = now;
        }
      }

      if (progress < 1) {
        const rafId = requestAnimationFrame(step);
        cancelRef.current = () => cancelAnimationFrame(rafId);
        return;
      }

      for (let i = lastProcessed; i < sequence.length; i += 1) {
        localCounts[sequence[i]] += 1;
      }
      setCounts([...localCounts]);
      setProcessedCount(sequence.length);

      const uniqueTop = findUniqueTop();
      if (uniqueTop !== null) {
        finishWith(uniqueTop);
        return;
      }

      runSuddenDeath();
    };

    const rafId = requestAnimationFrame(step);
    cancelRef.current = () => cancelAnimationFrame(rafId);
  }, [options, drawCount, onFinish]);

  const start = useCallback(() => {
    if (isRunning || countdownValue !== null) return;
    if (options.length < 2 || drawCount <= 0) return;

    // レーサーをスタートラインに（全て0）並べてカウントダウン
    setCounts(new Array(options.length).fill(0));
    setProcessedCount(0);
    setSuddenDeathCount(0);
    setResult(null);
    setIsSuddenDeath(false);
    setCountdownValue(3);

    let value = 3;
    const tickCountdown = () => {
      value -= 1;
      if (value > 0) {
        setCountdownValue(value);
        const id = window.setTimeout(tickCountdown, COUNTDOWN_INTERVAL_MS);
        countdownRef.current = () => window.clearTimeout(id);
      } else {
        setCountdownValue(0); // GO!
        const id = window.setTimeout(() => {
          setCountdownValue(null);
          countdownRef.current = null;
          runRace();
        }, GO_HOLD_MS);
        countdownRef.current = () => window.clearTimeout(id);
      }
    };

    const id = window.setTimeout(tickCountdown, COUNTDOWN_INTERVAL_MS);
    countdownRef.current = () => window.clearTimeout(id);
  }, [isRunning, countdownValue, options.length, drawCount, runRace]);

  const isCountingDown = countdownValue !== null;

  return {
    counts,
    processedCount,
    suddenDeathCount,
    isRunning,
    isSuddenDeath,
    countdownValue,
    isCountingDown,
    result,
    start,
    reset,
  };
};
