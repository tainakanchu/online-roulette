import { type FC, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { distanceCategory, raceTarget, simulateHorseRace } from "@tainakanchu/roulette-core";
import { useRaceCard, type RaceEntry } from "../../hooks/useRaceCard";
import { buildFilename, downloadImage, generateHorseRaceResultImage } from "../../utils/imageUtils";
import { ImageActions } from "../ImageActions";
import { CoursePicker } from "./CoursePicker";
import { DistancePicker } from "./DistancePicker";
import { RaceCard } from "./RaceCard";
import { Commentator, type CommentaryLine } from "./commentary";
import { isRaceRecordingSupported, RaceRecorder, type RaceVideo } from "./raceRecorder";
import { BLACKOUT_MS } from "./recorderNews";
import { NewsOverlay } from "./NewsOverlay";
import { PaddockTelop } from "./PaddockTelop";
import { horseWeight, weightChange } from "../../utils/paddock";
import { isValidLogin } from "../../utils/githubLogin";
import { buildRaceNews, cueCardAt, type NewsSegment } from "../../utils/raceNews";
import type { NewsWallInfo, PaddockFocus, RaceScene, RaceTick } from "./scene/RaceScene";

const COUNTDOWN_INTERVAL_MS = 720;
const GO_HOLD_MS = 650;
/** ニュースが終わって競馬場に戻ってから、確定の表示を映すために録画を続ける時間 */
const RECORD_TAIL_MS = 2500;
/** 確定からレース後のニュースに切り替えるまで（確定の後に電光掲示板を映す時間） */
const NEWS_DELAY_MS = 3600;
/** 騎乗合図（止まーれー）から、騎手が乗ってゲートへ移るまで */
const MOUNT_CALL_MS = 1800;
/** 競馬場とスタジオの切り替えで黒を挟む時間（CSS の news-blackout と合わせる） */
const NEWS_FADE_MS = BLACKOUT_MS;
/** 着差がこれより大きいと「大差」と読む（馬身） */
const BIG_MARGIN_LENGTHS = 10.5;
/** 勝ち馬がゴールするまでの実時間（スローモーション分は別途伸びる）。長い距離ほど少し速く流す */
const raceSeconds = (meters: number) => 15 * Math.pow(meters / 1600, 0.85);

type Phase = "idle" | "countdown" | "racing" | "finished";

interface RaceOutcome {
  order: number[];
  winner: number;
  /** その日の何レース目か（ターフビジョンの「第 N レース」） */
  raceNumber: number;
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
  const { entries, distance, raceName, raceGrade, surface, going } = card;

  const stageRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<RaceScene | null>(null);
  const timersRef = useRef<number[]>([]);
  const recorderRef = useRef<RaceRecorder | null>(null);
  const canRecord = useMemo(() => isRaceRecordingSupported(), []);
  const [video, setVideo] = useState<RaceVideo | null>(null);
  // レースからニュースの終わりまで録画している間（動画の保存ボタンの代わりに「録画中」を出す）
  const [isRecording, setIsRecording] = useState(false);
  const [sceneError, setSceneError] = useState(false);
  // シーンを作るたびに増える番号（0 = まだない）。開発中のホットリロードなどでシーンだけが作り直されても、
  // 番号が変わるので出走馬・コース・ターフビジョンの設定を新しいシーンにやり直せる（真偽値だと true のまま変わらず、
  // 馬のいないシーンが残っていた）
  const [sceneVersion, setSceneVersion] = useState(0);
  const sceneReady = sceneVersion > 0;
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
  // レース後のニュース。index は今のカット
  const [news, setNews] = useState<{ segments: NewsSegment[]; index: number; shoulder: string | null; title: string } | null>(
    null
  );
  // 競馬場とスタジオの切り替えに挟む黒（in: 黒くなっていく / out: 黒から明けていく）
  const [blackout, setBlackout] = useState<"none" | "in" | "out">("none");
  // パドック中継で映している馬（テロップ）と、騎乗合図の最中か
  const [paddockFocus, setPaddockFocus] = useState<PaddockFocus | null>(null);
  const [mountCall, setMountCall] = useState(false);

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
    setIsRecording(false);
    setVideo(null);
  }, []);

  /** 録画を止めて、動画を保存できるようにする（ニュースが終わって競馬場に戻った後に呼ぶ） */
  const finishRecording = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    sceneRef.current?.setFrameListener(null);
    void recorder.stop().then((result) => {
      if (recorderRef.current !== recorder) return;
      recorderRef.current = null;
      setIsRecording(false);
      setVideo(result);
    });
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
          setSceneVersion((version) => version + 1);
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
    () => entries.map((e) => `${e.name}\u0000${e.color}\u0000${e.login}`).join("\u0001") + `|${distance}`,
    [entries, distance]
  );
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    clearTimers();
    discardRecording();
    scene.setField(
      entries.map((e) => ({
        number: e.number,
        name: e.name,
        color: e.color,
        seed: e.seed,
        login: isValidLogin(e.login) ? e.login : undefined,
      })),
      distance
    );
    setPhase("idle");
    setCountdown(null);
    setOutcome(null);
    setCommentary(null);
    setLiveOrder([]);
    setRemaining(null);
    setSlowMotion(false);
    setNews(null);
    setBlackout("none");
    setMountCall(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldKey, sceneVersion]);

  // 選択肢が変わったら予想をリセット
  const namesKey = entries.map((e) => e.name).join("\u0000");
  useEffect(() => {
    setBet(null);
  }, [namesKey]);

  const courseLabel = t("race.courseLabel", {
    surface: t(`race.course.surfaces.${surface}`),
    meters: distance,
    category: t(`race.categories.${distanceCategory(distance)}`),
    going: t(`race.course.goings.${surface}.${going}`),
  });

  // ----- パドック（掲示板の馬体重と、中継のテロップ） -----
  // 馬体重はレースごとに変わる（前走からの増減）。戦績の数をレースの回数として使う
  const raceCount = card.history.length;
  const paddockEntries = useMemo(
    () =>
      entries.map((e) => ({
        number: e.number,
        name: e.name,
        color: e.color,
        weight: horseWeight(e.seed, raceCount),
        change: weightChange(e.seed, raceCount),
        odds: e.odds,
        popularity: e.popularity,
      })),
    [entries, raceCount]
  );
  useEffect(() => {
    sceneRef.current?.setPaddockEntries(paddockEntries, { odds: (odds) => odds.toFixed(1) });
  }, [paddockEntries, sceneVersion]);
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.setPaddockListener(setPaddockFocus);
    return () => scene.setPaddockListener(null);
  }, [sceneVersion]);

  // ----- 芝・ダートと馬場状態（見た目だけでレース展開には影響しない） -----
  useEffect(() => {
    sceneRef.current?.setCourse(surface, going);
  }, [surface, going, sceneVersion]);

  // ----- 会場の風（旗のなびき・尻尾の流れ・芝と木の揺れ） -----
  useEffect(() => {
    sceneRef.current?.setWind(card.wind);
  }, [card.wind, sceneVersion]);

  // ----- ターフビジョン -----
  // 1 日 12 レースの何レース目か。戦績の数から決め、確定後は走ったレースの番号のまま表示する
  const nextRaceNumber = (card.history.length % 12) + 1;
  const raceNumber = outcome?.raceNumber ?? nextRaceNumber;
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    // 着順・着差・時計はシーンがレースの進み具合から決めるので、ここではレースの情報と表示の言葉だけ渡す
    scene.setVision({
      raceNumber,
      title: `${raceName || t("race.vision.title")}${raceGrade ? ` (${raceGrade})` : ""}`,
      surface: t(`race.course.surfaces.${surface}`),
      going: t(`race.course.goings.${surface}.${going}`),
      labels: {
        racePrefix: t("race.vision.racePrefix"),
        raceSuffix: t("race.vision.raceSuffix"),
        time: t("race.vision.time"),
        going: t("race.vision.going"),
        official: t("race.vision.official"),
        photo: t("race.vision.photo"),
        photoFinish: t("race.vision.photoFinish"),
        live: t("race.vision.live"),
        nose: t("race.vision.nose"),
        head: t("race.vision.head"),
        neck: t("race.vision.neck"),
        distance: t("race.vision.distance"),
      },
      entries: (outcome?.field ?? entries).map((e) => ({ number: e.number, name: e.name, color: e.color })),
    });
  }, [entries, outcome, raceNumber, raceName, raceGrade, surface, going, t, sceneVersion]);

  // ----- レース後のニュース -----
  const raceTitle = `${raceName || t("race.vision.title")}${raceGrade ? ` (${raceGrade})` : ""}`;
  const beginNews = useCallback(
    (scene: RaceScene, field: RaceEntry[]) => {
      const summary = scene.getRaceSummary();
      const winner = summary ? field[summary.order[0]] : undefined;
      if (!summary || !winner) {
        finishRecording();
        return;
      }
      const margin =
        summary.marginLengths > BIG_MARGIN_LENGTHS
          ? t("race.news.bigMargin")
          : t("race.news.lengths", { margin: summary.margins[0] ?? "" });
      const segments = buildRaceNews({
        raceName: raceTitle,
        courseLabel,
        field: field.map((e) => ({ name: e.name, popularity: e.popularity, style: e.style })),
        order: summary.order,
        marginLengths: summary.marginLengths,
        margin,
        photo: summary.photo,
        finalTime: summary.finalTime,
      });
      const photo = scene.getFinishPhoto();
      const info: NewsWallInfo = {
        photo,
        race: raceTitle,
        winner: winner.name,
        course: courseLabel,
        time: `${t("race.vision.time")} ${summary.finalTime}`,
        resultTitle: t("race.news.resultTitle"),
        corner: t("race.news.corner"),
        rows: summary.order
          .map((i, rank) => ({ e: field[i], rank }))
          .filter(({ e }) => Boolean(e))
          .map(({ e, rank }) => ({
            rank: t("race.result.rank", { rank: rank + 1 }),
            number: e.number,
            color: e.color,
            name: e.name,
            margin: rank === 0 ? "" : (summary.margins[rank - 1] ?? ""),
          })),
        cueCard: (remaining) => {
          const card = cueCardAt(remaining);
          return { lines: card.lines.map((line) => t(line.key, line.params)), accent: card.accent };
        },
      };
      // 肩のパネルに出すゴールの写真（JPEG にして軽くする）
      let shoulder: string | null = null;
      try {
        shoulder = photo.toDataURL("image/jpeg", 0.85);
      } catch {
        shoulder = null;
      }
      // レースの実況はここで終わり（ニュースの後に競馬場へ戻ったとき、ゴールの実況が残らないように）
      setCommentary(null);
      // 競馬場を黒に落としてからスタジオへ切り替え、スタジオは黒から明ける
      const fadeFromBlack = () => {
        setBlackout("out");
        later(() => setBlackout("none"), NEWS_FADE_MS);
      };
      setBlackout("in");
      later(() => {
        scene.startNews(segments, info, {
          onSegment: (index) => {
            setNews({ segments, index, shoulder, title: raceTitle });
            if (index === 0) fadeFromBlack();
          },
          // 締めのカットの最後は黒に溶暗しているので、競馬場は黒から明ける。録画は競馬場に戻った所まで
          onEnd: () => {
            setNews(null);
            fadeFromBlack();
            later(finishRecording, RECORD_TAIL_MS);
          },
        });
      }, NEWS_FADE_MS);
    },
    [courseLabel, finishRecording, later, raceTitle, t]
  );

  const skipNews = useCallback(() => {
    sceneRef.current?.stopNews();
    setNews(null);
    setBlackout("out");
    later(() => setBlackout("none"), NEWS_FADE_MS);
    later(finishRecording, RECORD_TAIL_MS);
  }, [finishRecording, later]);

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
    const thisRaceNumber = nextRaceNumber;
    const commentator = new Commentator(names);

    discardRecording();
    // 前のレースのニュースを止め、次のニュースのスタジオを今のうちに読み込んでおく
    scene.stopNews();
    setNews(null);
    setBlackout("none");
    void scene.prepareNews();

    // パドックにいたら、騎乗合図（止まーれー）→ 騎手が乗る → 黒を挟んでゲートへ
    if (scene.isInPaddock()) {
      setPhase("countdown");
      setMountCall(true);
      scene.callToMount();
      later(() => setBlackout("in"), MOUNT_CALL_MS);
      later(() => {
        setMountCall(false);
        runRace();
        setBlackout("out");
        later(() => setBlackout("none"), NEWS_FADE_MS);
      }, MOUNT_CALL_MS + NEWS_FADE_MS);
      return;
    }
    runRace();

    function runRace() {
      if (!scene) return;
      const recorder = canRecord ? new RaceRecorder() : null;
      if (recorder) {
        recorderRef.current = recorder;
        setIsRecording(true);
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
              setOutcome({ order: race.order, winner: race.winner, raceNumber: thisRaceNumber, field });
              card.recordRace({
                timestamp: Date.now(),
                distance,
                order: race.order.map((i) => names[i]),
              });
              onFinish?.(names[race.winner] ?? "");
              // 録画はニュースの終わりまで続ける（止めるのは beginNews の後）
              later(() => beginNews(scene, field), NEWS_DELAY_MS);
            },
          });
        }, GO_HOLD_MS);
      };
      later(() => tickCountdown(2), COUNTDOWN_INTERVAL_MS);
    }
  }, [
    beginNews,
    canRecord,
    canStart,
    card,
    clearTimers,
    discardRecording,
    distance,
    entries,
    later,
    nextRaceNumber,
    onFinish,
  ]);

  const reset = useCallback(() => {
    clearTimers();
    discardRecording();
    setNews(null);
    setBlackout("none");
    setMountCall(false);
    // レース前の状態（パドックで周回）に戻す
    sceneRef.current?.showPaddock();
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
        title: `${t("mode.horseRace")} ・ ${courseLabel}`,
        winnerLabel: t("race.result.winner"),
        rank: (rank) => t("race.result.rank", { rank }),
      },
      language: i18n.language,
    });
  }, [betHit, betResult, courseLabel, i18n.language, outcome, t]);

  const countdownLabel = countdown === 0 ? t("ui.go") : countdown !== null ? String(countdown) : "";

  // 録画に焼き込むニュースのテロップの出方と、黒の濃さは、切り替わった時刻からの経過で決める
  const blackoutSinceRef = useRef(0);
  useEffect(() => {
    blackoutSinceRef.current = performance.now();
  }, [blackout]);
  const newsStartedAtRef = useRef(0);
  useEffect(() => {
    newsStartedAtRef.current = performance.now();
  }, [news]);
  const shoulderImage = useMemo(() => {
    if (!news?.shoulder) return null;
    const image = new Image();
    image.src = news.shoulder;
    return image;
  }, [news?.shoulder]);

  // 録画に焼き込む HUD（毎フレームは recorder 側が ref から読む）
  useEffect(() => {
    const recorder = recorderRef.current;
    if (!recorder) return;
    const segment = news?.segments[news.index];
    const status =
      countdown !== null
        ? countdownLabel
        : phase === "racing" && remaining !== null
          ? remaining > 0
            ? t("race.remaining", { meters: remaining })
            : t("race.goal")
          : "";
    recorder.overlay = {
      news:
        news && segment
          ? {
              startedAt: newsStartedAtRef.current,
              seconds: segment.seconds,
              shot: segment.shot,
              isClosing: segment.id === "closing",
              corner: t("race.news.corner"),
              vtrMark: t("race.news.vtrMark"),
              telop: segment.telop ? t(segment.telop.key, segment.telop.params) : "",
              caption: segment.script ? t(segment.script.key, segment.script.params) : "",
              shoulder: shoulderImage,
              raceTitle: news.title,
              endCard: t("race.news.endCard"),
            }
          : null,
      blackout: { kind: blackout, since: blackoutSinceRef.current },
      commentary: commentary && phase !== "idle" ? t(commentary.key, commentary.params) : "",
      status,
      order:
        phase === "racing"
          ? liveOrder
              .map((i) => entries[i])
              .filter(Boolean)
              .map((e) => ({ number: e.number, color: e.color }))
          : [],
      // 画面と同じく、ニュースの間は確定の表を出さない
      result:
        phase === "finished" && outcome && !news
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
  }, [
    blackout,
    commentary,
    countdown,
    countdownLabel,
    entries,
    liveOrder,
    news,
    outcome,
    phase,
    remaining,
    shoulderImage,
    t,
  ]);

  const downloadVideo = useCallback(() => {
    if (!video) return;
    downloadImage(video.blob, buildFilename("horse-race", video.extension));
    onNotify?.(t("race.video.downloaded"));
  }, [onNotify, t, video]);

  return (
    <div className="horse-race">
      <div className="race-controls">
        <DistancePicker value={distance} onChange={card.setDistance} disabled={locked} />
        <CoursePicker
          surface={surface}
          going={going}
          onSurfaceChange={card.setSurface}
          onGoingChange={card.setGoing}
          disabled={locked}
        />
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
        {/* 映画のようなシネマスコープの黒帯。レースの間だけ上下から差し込む（文字や操作のボタンは帯の上に重なる） */}
        <div className={`race-letterbox ${phase !== "idle" && !news ? "is-active" : ""}`} aria-hidden="true" />

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

        {/* 全画面ではステージの外の操作パネルが見えないので、出走とゲートに戻すをステージの上に出す（走っている間は映像の邪魔なので隠す） */}
        {isFullscreen && !locked && (
          <div className="race-stage-actions">
            {phase !== "idle" && (
              <button type="button" className="race-reset-button" onClick={reset}>
                {t("race.reset")}
              </button>
            )}
            <button type="button" className="race-start-button" onClick={start} disabled={!canStart}>
              🏇 {t("race.start")}
            </button>
          </div>
        )}

        {countdown !== null && (
          <div className="race-countdown" key={countdown}>
            {countdownLabel}
          </div>
        )}

        {slowMotion && <div className="race-slowmo">{t("race.slowMotion")}</div>}
        {photoFlash && <div className="race-photo-flash" aria-hidden="true" />}

        {news && news.segments[news.index] && (
          <NewsOverlay
            segment={news.segments[news.index]}
            index={news.index}
            shoulder={news.shoulder}
            raceTitle={news.title}
            onSkip={skipNews}
          />
        )}

        {/* パドック中継のテロップ（馬番・馬名・馬体重）と、騎乗合図 */}
        {phase === "idle" && !news && paddockFocus && (
          <PaddockTelop
            key={`${paddockFocus.number}-${paddockFocus.entering}`}
            entry={paddockEntries.find((e) => e.number === paddockFocus.number)}
            entering={paddockFocus.entering}
          />
        )}
        {mountCall && <div className="paddock-call">{t("race.paddock.call")}</div>}

        {blackout !== "none" && <div className={`news-blackout news-blackout--${blackout}`} aria-hidden="true" />}

        {commentary && phase !== "idle" && !news && (
          <div className="race-commentary" aria-live="polite">
            <span className="race-commentary-mic">🎙</span>
            <span key={`${commentary.key}-${JSON.stringify(commentary.params)}`} className="race-commentary-text">
              {t(commentary.key, commentary.params)}
            </span>
          </div>
        )}

        {phase === "finished" && outcome && winnerEntry && !news && (
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
          {!video && isRecording && (
            <button type="button" className="race-video-button" disabled>
              🎬 {t("race.video.recording")}
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
        surface={surface}
        going={going}
        wind={card.wind}
        raceName={raceName}
        onRaceNameChange={card.setRaceName}
        raceGrade={raceGrade}
        onRaceGradeChange={card.setRaceGrade}
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
