import { type FC, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { distanceCategory, raceTarget, simulateHorseRace } from "@tainakanchu/roulette-core";
import { useRaceCard, type RaceEntry } from "../../hooks/useRaceCard";
import { buildFilename, downloadImage, generateHorseRaceResultImage } from "../../utils/imageUtils";
import { ImageActions } from "../ImageActions";
import { DistancePicker } from "./DistancePicker";
import { RaceCard } from "./RaceCard";
import { Commentator, type CommentaryLine } from "./commentary";
import { isRaceRecordingSupported, RaceRecorder, type RaceVideo } from "./raceRecorder";
import type { RaceScene, RaceTick } from "./scene/RaceScene";

const COUNTDOWN_INTERVAL_MS = 720;
const GO_HOLD_MS = 650;
/** 確定表示まで映すため、onComplete 後も少し録画を続ける */
const RECORD_TAIL_MS = 2500;
/** 勝ち馬がゴールするまでの実時間（スローモーション分は別途伸びる）。長い距離ほど少し速く流す */
const raceSeconds = (meters: number) => 15 * Math.pow(meters / 1600, 0.85);

type Phase = "idle" | "countdown" | "racing" | "finished";

interface RaceOutcome {
  order: number[];
  winner: number;
  /** 出走時点の出走表（オッズは確定後の再計算に影響されない） */
  field: RaceEntry[];
}

interface HorseRaceModeProps {
  options: string[];
  onFinish?: (winner: string) => void;
  onNotify?: (message: string) => void;
}

export const HorseRaceMode: FC<HorseRaceModeProps> = ({ options, onFinish, onNotify }) => {
  const { t, i18n } = useTranslation();
  const card = useRaceCard(options);
  const { entries, distance } = card;

  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<RaceScene | null>(null);
  const timersRef = useRef<number[]>([]);
  const recorderRef = useRef<RaceRecorder | null>(null);
  const canRecord = useMemo(() => isRaceRecordingSupported(), []);
  const [video, setVideo] = useState<RaceVideo | null>(null);
  const [sceneError, setSceneError] = useState(false);
  const [sceneReady, setSceneReady] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [countdown, setCountdown] = useState<number | null>(null);
  const [commentary, setCommentary] = useState<CommentaryLine | null>(null);
  const [liveOrder, setLiveOrder] = useState<number[]>([]);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [slowMotion, setSlowMotion] = useState(false);
  const [photoFlash, setPhotoFlash] = useState(false);
  const [outcome, setOutcome] = useState<RaceOutcome | null>(null);
  const [bet, setBet] = useState<number | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const locked = phase === "countdown" || phase === "racing";
  const canStart = entries.length >= 2 && !locked && sceneReady;

  const clearTimers = useCallback(() => {
    timersRef.current.forEach((id) => window.clearTimeout(id));
    timersRef.current = [];
  }, []);

  const later = useCallback((fn: () => void, ms: number) => {
    timersRef.current.push(window.setTimeout(fn, ms));
  }, []);

  const discardRecording = useCallback(() => {
    sceneRef.current?.setFrameListener(null);
    recorderRef.current?.dispose();
    recorderRef.current = null;
    setVideo(null);
  }, []);

  // ----- three.js シーンの生成（遅延ロード） -----
  useEffect(() => {
    let disposed = false;
    let scene: RaceScene | null = null;
    import("./scene/RaceScene")
      .then(({ RaceScene }) => {
        if (disposed || !stageRef.current) return;
        try {
          scene = new RaceScene(stageRef.current);
          sceneRef.current = scene;
          setSceneReady(true);
        } catch (error) {
          console.error("Failed to initialize 3D scene", error);
          setSceneError(true);
        }
      })
      .catch((error) => {
        console.error("Failed to load 3D scene", error);
        setSceneError(true);
      });
    return () => {
      disposed = true;
      clearTimers();
      recorderRef.current?.dispose();
      recorderRef.current = null;
      scene?.dispose();
      sceneRef.current = null;
    };
  }, [clearTimers]);

  // ----- 出走馬・距離が変わったらゲートに並べ直す -----
  const fieldKey = useMemo(
    () => entries.map((e) => `${e.name}\u0000${e.color}`).join("\u0001") + `|${distance}`,
    [entries, distance]
  );
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    clearTimers();
    discardRecording();
    scene.setField(
      entries.map((e) => ({ number: e.number, name: e.name, color: e.color, seed: e.seed })),
      distance
    );
    setPhase("idle");
    setCountdown(null);
    setOutcome(null);
    setCommentary(null);
    setLiveOrder([]);
    setRemaining(null);
    setSlowMotion(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldKey, sceneReady]);

  // 選択肢が変わったら予想をリセット
  const namesKey = entries.map((e) => e.name).join("\u0000");
  useEffect(() => {
    setBet(null);
  }, [namesKey]);

  const distanceLabel = `${t("race.meters", { meters: distance })} ${t(
    `race.categories.${distanceCategory(distance)}`
  )}`;

  // ----- ターフビジョン -----
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const rowsFor = (indices: number[]) =>
      indices
        .map((i) => entries[i])
        .filter(Boolean)
        .map((e) => ({ number: e.number, name: e.name, color: e.color }));
    if (phase === "finished" && outcome) {
      scene.setVision({
        title: t("race.vision.result"),
        subtitle: distanceLabel,
        rows: rowsFor(outcome.order),
      });
    } else {
      const byPopularity = [...entries].sort((a, b) => a.popularity - b.popularity);
      scene.setVision({
        title: t("race.vision.title"),
        subtitle: distanceLabel,
        rows:
          phase === "idle"
            ? byPopularity.map((e) => ({ number: e.number, name: `${e.name}  ${e.odds.toFixed(1)}`, color: e.color }))
            : rowsFor(entries.map((e) => e.index)),
      });
    }
  }, [entries, phase, outcome, distanceLabel, t, sceneReady]);

  // ----- レース進行 -----
  const start = useCallback(() => {
    const scene = sceneRef.current;
    if (!scene || !canStart) return;
    clearTimers();

    const race = simulateHorseRace({
      strengths: entries.map((e) => e.strength),
      styles: entries.map((e) => e.style),
      target: raceTarget(distance),
    });
    const field = entries;
    const names = field.map((e) => e.name);
    const commentator = new Commentator(names);

    discardRecording();
    const recorder = canRecord ? new RaceRecorder() : null;
    if (recorder) {
      recorderRef.current = recorder;
      scene.setFrameListener((canvas) => recorder.captureFrame(canvas));
    }

    scene.resetToGate();
    scene.showGate();
    setOutcome(null);
    setLiveOrder([]);
    setRemaining(distance);
    setSlowMotion(false);
    setCommentary({ key: "race.commentary.gate" });
    setPhase("countdown");
    setCountdown(3);

    const tickCountdown = (value: number) => {
      if (value > 0) {
        setCountdown(value);
        later(() => tickCountdown(value - 1), COUNTDOWN_INTERVAL_MS);
        return;
      }
      setCountdown(0);
      scene.openGate();
      later(() => {
        setCountdown(null);
        setPhase("racing");
        setCommentary(commentator.start());
        scene.startRace(race, raceSeconds(distance), {
          onTick: (tick: RaceTick) => {
            setLiveOrder(tick.order);
            setRemaining(tick.remainingMeters);
            setSlowMotion(tick.slowMotion);
            const line = commentator.feed(tick);
            if (line) setCommentary(line);
          },
          onWinnerCross: () => {
            setCommentary(commentator.finish(race.winner));
            setSlowMotion(false);
            setRemaining(0);
            setPhotoFlash(true);
            later(() => setPhotoFlash(false), 700);
          },
          onComplete: () => {
            setPhase("finished");
            setOutcome({ order: race.order, winner: race.winner, field });
            card.recordRace({
              timestamp: Date.now(),
              distance,
              order: race.order.map((i) => names[i]),
            });
            onFinish?.(names[race.winner] ?? "");
            if (recorder) {
              later(() => {
                scene.setFrameListener(null);
                void recorder.stop().then((result) => {
                  if (recorderRef.current !== recorder) return;
                  recorderRef.current = null;
                  setVideo(result);
                });
              }, RECORD_TAIL_MS);
            }
          },
        });
      }, GO_HOLD_MS);
    };
    later(() => tickCountdown(2), COUNTDOWN_INTERVAL_MS);
  }, [canRecord, canStart, card, clearTimers, discardRecording, distance, entries, later, onFinish]);

  const reset = useCallback(() => {
    clearTimers();
    discardRecording();
    sceneRef.current?.resetToGate();
    setPhase("idle");
    setCountdown(null);
    setOutcome(null);
    setCommentary(null);
    setLiveOrder([]);
    setRemaining(null);
    setSlowMotion(false);
  }, [clearTimers, discardRecording]);

  // ----- 全画面 -----
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === wrapRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void wrapRef.current?.requestFullscreen?.();
    }
  }, []);

  const winnerEntry = outcome ? outcome.field[outcome.winner] : undefined;
  const betEntry = bet !== null ? (outcome?.field ?? entries)[bet] : undefined;
  const betHit = outcome !== null && bet !== null && bet === outcome.winner;
  const betResult = betEntry
    ? betHit
      ? t("race.bet.hit", { odds: betEntry.odds.toFixed(1), payout: Math.round(betEntry.odds * 100) })
      : t("race.bet.miss", { name: betEntry.name })
    : undefined;

  const getResultBlob = useCallback(async () => {
    const scene = sceneRef.current;
    if (!scene || !outcome) throw new Error("No race result");
    return generateHorseRaceResultImage({
      photo: scene.getFinishPhoto(),
      rows: outcome.order
        .map((i) => outcome.field[i])
        .filter(Boolean)
        .map((e) => ({
          number: e.number,
          name: e.name,
          color: e.color,
          detail: t("race.result.odds", { odds: e.odds.toFixed(1), pop: e.popularity }),
        })),
      betResult,
      betHit,
      labels: {
        title: `${t("mode.horseRace")} ・ ${distanceLabel}`,
        winnerLabel: t("race.result.winner"),
        rank: (rank) => t("race.result.rank", { rank }),
      },
      language: i18n.language,
    });
  }, [betHit, betResult, distanceLabel, i18n.language, outcome, t]);

  const countdownLabel = countdown === 0 ? t("ui.go") : countdown !== null ? String(countdown) : "";

  // 録画に焼き込む HUD（毎フレームは recorder 側が ref から読む）
  useEffect(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    const status =
      countdown !== null
        ? countdownLabel
        : phase === "racing" && remaining !== null
          ? remaining > 0
            ? t("race.remaining", { meters: remaining })
            : t("race.goal")
          : "";
    recorder.overlay = {
      commentary: commentary && phase !== "idle" ? t(commentary.key, commentary.params) : "",
      status,
      order:
        phase === "racing"
          ? liveOrder
              .map((i) => entries[i])
              .filter(Boolean)
              .map((e) => ({ number: e.number, color: e.color }))
          : [],
      result:
        phase === "finished" && outcome
          ? {
              title: t("race.result.title"),
              rows: outcome.order
                .slice(0, 3)
                .map((i, rank) => ({ rank, e: outcome.field[i] }))
                .filter(({ e }) => Boolean(e))
                .map(({ rank, e }) => ({
                  rank: t("race.result.rank", { rank: rank + 1 }),
                  number: e.number,
                  color: e.color,
                  name: e.name,
                })),
            }
          : null,
    };
  }, [commentary, countdown, countdownLabel, entries, liveOrder, outcome, phase, remaining, t]);

  const downloadVideo = useCallback(() => {
    if (!video) return;
    downloadImage(video.blob, buildFilename("horse-race", video.extension));
    onNotify?.(t("race.video.downloaded"));
  }, [onNotify, t, video]);

  return (
    <div className="horse-race">
      <div className="race-controls">
        <DistancePicker value={distance} onChange={card.setDistance} disabled={locked} />
        <div className="race-actions">
          <button type="button" className="race-start-button" onClick={start} disabled={!canStart}>
            🏇 {t("race.start")}
          </button>
          <button
            type="button"
            className="race-reset-button"
            onClick={reset}
            disabled={locked || phase === "idle"}
          >
            {t("race.reset")}
          </button>
        </div>
      </div>

      {card.overflow > 0 && (
        <p className="race-notice">{t("race.overflow", { max: entries.length, count: card.overflow })}</p>
      )}

      <div ref={wrapRef} className={`race-stage-wrap ${isFullscreen ? "is-fullscreen" : ""}`}>
        <div ref={stageRef} className="race-stage" />

        {sceneError && <div className="race-stage-error">{t("race.webglError")}</div>}
        {!sceneReady && !sceneError && <div className="race-stage-loading">{t("race.loading")}</div>}

        {entries.length < 2 && sceneReady && (
          <div className="race-stage-message">{t("race.needTwo")}</div>
        )}

        {liveOrder.length > 0 && phase === "racing" && (
          <div className="race-hud-order" aria-hidden="true">
            {liveOrder.map((i) => {
              const e = entries[i];
              if (!e) return null;
              return (
                <span key={i} className="race-hud-chip" style={{ background: e.color }} title={e.name}>
                  {e.number}
                </span>
              );
            })}
          </div>
        )}

        {remaining !== null && phase === "racing" && (
          <div className="race-hud-remaining">
            {remaining > 0 ? t("race.remaining", { meters: remaining }) : t("race.goal")}
          </div>
        )}

        <button
          type="button"
          className="race-fullscreen-button"
          onClick={toggleFullscreen}
          title={isFullscreen ? t("race.exitFullscreen") : t("race.fullscreen")}
          aria-label={isFullscreen ? t("race.exitFullscreen") : t("race.fullscreen")}
        >
          {isFullscreen ? "🗗" : "⛶"}
        </button>

        {countdown !== null && (
          <div className="race-countdown" key={countdown}>
            {countdownLabel}
          </div>
        )}

        {slowMotion && <div className="race-slowmo">{t("race.slowMotion")}</div>}
        {photoFlash && <div className="race-photo-flash" aria-hidden="true" />}

        {commentary && phase !== "idle" && (
          <div className="race-commentary" aria-live="polite">
            <span className="race-commentary-mic">🎙</span>
            <span key={`${commentary.key}-${JSON.stringify(commentary.params)}`} className="race-commentary-text">
              {t(commentary.key, commentary.params)}
            </span>
          </div>
        )}

        {phase === "finished" && outcome && winnerEntry && (
          <div className="race-result-overlay">
            <div className="race-result-title">{t("race.result.title")}</div>
            <ol className="race-result-list">
              {outcome.order.slice(0, 3).map((i, rank) => {
                const e = outcome.field[i];
                if (!e) return null;
                return (
                  <li key={i} className={`race-result-row race-result-row--${rank + 1}`}>
                    <span className="race-result-rank">{t("race.result.rank", { rank: rank + 1 })}</span>
                    <span className="race-card-number" style={{ background: e.color }}>
                      {e.number}
                    </span>
                    <span className="race-result-name">{e.name}</span>
                    <span className="race-result-odds">{t("race.result.odds", { odds: e.odds.toFixed(1), pop: e.popularity })}</span>
                  </li>
                );
              })}
            </ol>
            {betResult && (
              <div className={`race-result-bet ${betHit ? "is-hit" : "is-miss"}`}>{betResult}</div>
            )}
          </div>
        )}
      </div>

      {phase === "finished" && outcome && winnerEntry && (
        <div className="battle-winner race-winner">
          {onNotify && (
            <ImageActions
              getBlob={getResultBlob}
              isVisible
              onSuccess={onNotify}
              filenamePrefix="horse-race-result"
              className="image-actions--card"
            />
          )}
          <div className="battle-winner-label">{t("race.result.winner")}</div>
          <div className="battle-winner-value">{winnerEntry.name}</div>
          {video && (
            <button type="button" className="race-video-button" onClick={downloadVideo}>
              🎬 {t("race.video.save")}
            </button>
          )}
        </div>
      )}

      <div className="race-bet-summary">
        {betEntry
          ? t("race.bet.current", { name: betEntry.name, odds: betEntry.odds.toFixed(1) })
          : t("race.bet.none")}
      </div>

      <RaceCard
        entries={entries}
        distance={distance}
        bet={bet}
        onBet={setBet}
        locked={locked}
        logins={card.logins}
        onLoginChange={card.setLogin}
        githubStatus={card.githubStatus}
        onFetchGitHub={card.fetchActivities}
        raceCount={card.history.length}
        onClearHistory={card.clearHistory}
      />
    </div>
  );
};
