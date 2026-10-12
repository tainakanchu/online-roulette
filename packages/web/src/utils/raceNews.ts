// レースの後に流すニュース番組の構成（どのカットで、誰が、何を伝えるか）。
// 原稿は翻訳のキーと差し込む値で持ち、文はレースの中身（写真判定・着差・人気・脚質）で選ぶ。

/** ニュースのカット（カメラの撮り方） */
export type NewsShot =
  /** 番組の頭。スタジオの全景をクレーンで降りてくる */
  | "opening"
  /** メインキャスターの胸から上 */
  | "mainSingle"
  /** サブキャスターの胸から上 */
  | "subSingle"
  /** 2 人を正面から */
  | "twoShot"
  /** 斜めからのツーショット（背後の大型ビジョンが見える） */
  | "sideTwoShot"
  /** 大型ビジョンの寄り（結果の表） */
  | "wall"
  /** レースの VTR（競馬場の映像を全画面で） */
  | "vtr"
  /**
   * 切り替えの手違い。デスクの後ろから、スタジオカメラとカンペを掲げた AD が映ってしまう
   * （番組の残り時間をカンペで知らせている所）
   */
  | "blooper"
  /** 番組の終わり。スタジオの全景へ引いていく */
  | "closing";

/** 大型ビジョンに映すもの */
export type NewsWall = "logo" | "photo" | "result";

export interface NewsLine {
  key: string;
  params?: Record<string, string | number>;
}

export interface NewsSegment {
  id: "opening" | "headline" | "vtr" | "result" | "cue" | "comment" | "closing";
  /** このカットの長さ（秒） */
  seconds: number;
  shot: NewsShot;
  /** 話しているキャスター（VTR の間は声だけなので口は映らない） */
  speaker: "main" | "sub" | null;
  /** 画面下の大きなテロップ */
  telop: NewsLine | null;
  /** 読み上げる原稿（字幕で出す） */
  script: NewsLine | null;
  wall: NewsWall;
}

/** 勝ち方の種類。原稿の言い回しを選ぶ */
export type NewsTone = "photo" | "rout" | "upset" | "favorite" | "standard";

/**
 * 脚質（@tainakanchu/roulette-core の RunningStyle と同じ値）。
 * Why not: core から import すると、jest（ts-jest）がビルド前の core を解決できずテストが動かない
 */
export type NewsRunningStyle = "front" | "stalker" | "closer" | "deep";

export interface RaceNewsHorse {
  name: string;
  popularity: number;
  style: NewsRunningStyle;
}

export interface RaceNewsInput {
  /** レース名（グレードを含めた表示用） */
  raceName: string;
  /** コースの説明（例: 芝 1600m・良） */
  courseLabel: string;
  /** 出走表の順（着順は order で引く） */
  field: RaceNewsHorse[];
  /** 着順（field の index） */
  order: number[];
  /** 1・2 着の着差（馬身） */
  marginLengths: number;
  /** 着差の表示（例: クビ、1 1/2） */
  margin: string;
  /** 写真判定になったか */
  photo: boolean;
  /** 勝ち時計の表示（例: 1:33.5） */
  finalTime: string;
}

/** 圧勝とみなす着差（馬身） */
const ROUT_LENGTHS = 3;
/** 波乱とみなす勝ち馬の人気 */
const UPSET_POPULARITY = 5;

export const newsTone = (input: Pick<RaceNewsInput, "photo" | "marginLengths" | "field" | "order">): NewsTone => {
  const winner = input.field[input.order[0]];
  if (input.photo) return "photo";
  if (input.marginLengths >= ROUT_LENGTHS) return "rout";
  if (winner && winner.popularity >= UPSET_POPULARITY) return "upset";
  if (winner && winner.popularity === 1) return "favorite";
  return "standard";
};

/** ニュースの長さの合計（秒） */
export const rundownSeconds = (segments: NewsSegment[]) => segments.reduce((sum, s) => sum + s.seconds, 0);

/** カンペの内容（行と、赤で書く行の番号） */
export interface CueCard {
  lines: NewsLine[];
  accent: number[];
}

/**
 * AD が掲げるカンペ。番組の残り時間（秒）で書いてあることが変わる
 */
export const cueCardAt = (remainingSeconds: number): CueCard => {
  if (remainingSeconds > 20) return { lines: [{ key: "race.news.cue.next" }], accent: [] };
  if (remainingSeconds > 10.5) {
    return {
      lines: [{ key: "race.news.cue.hurry" }, { key: "race.news.cue.left", params: { seconds: Math.ceil(remainingSeconds) } }],
      accent: [1],
    };
  }
  if (remainingSeconds > 5.5) return { lines: [{ key: "race.news.cue.ten" }], accent: [0] };
  if (remainingSeconds > 2) return { lines: [{ key: "race.news.cue.five" }], accent: [0] };
  return { lines: [{ key: "race.news.cue.break" }], accent: [] };
};

/**
 * ニュースの構成を決める。オープニング → メインキャスターが結果を伝える → レースの VTR → サブキャスターが着順と時計 →
 * （手違いで AD のカンペ「10秒前」が映る）→ ひとこと → エンディングの順
 */
export const buildRaceNews = (input: RaceNewsInput): NewsSegment[] => {
  const tone = newsTone(input);
  const [first, second, third] = input.order.map((i) => input.field[i]);
  const winner = first?.name ?? "";
  const race = input.raceName;
  const hasThird = third !== undefined;

  return [
    { id: "opening", seconds: 3, shot: "opening", speaker: null, telop: null, script: null, wall: "logo" },
    {
      id: "headline",
      seconds: 6,
      shot: "mainSingle",
      speaker: "main",
      telop: { key: "race.news.telop.headline", params: { race, winner } },
      script: {
        key: `race.news.headline.${tone}`,
        params: { race, winner, margin: input.margin, popularity: first?.popularity ?? 1 },
      },
      // 写真は肩のパネルに出すので、背後のビジョンは番組の画面のまま（寄りでは一部しか映らず、文字が切れて見える）
      wall: "logo",
    },
    {
      id: "vtr",
      seconds: 9.5,
      shot: "vtr",
      speaker: "sub",
      telop: { key: "race.news.telop.vtr", params: { race, course: input.courseLabel } },
      script: { key: `race.news.vtr.${first?.style ?? "stalker"}`, params: { winner } },
      wall: "photo",
    },
    {
      id: "result",
      seconds: 6,
      shot: "wall",
      speaker: "sub",
      telop: { key: "race.news.telop.time", params: { time: input.finalTime, course: input.courseLabel } },
      script: hasThird
        ? { key: "race.news.result.placings", params: { second: second.name, third: third.name, time: input.finalTime } }
        : { key: "race.news.result.second", params: { second: second?.name ?? "", time: input.finalTime } },
      wall: "result",
    },
    // 残り 10 秒ちょうどで AD のカンペが映るよう、この後の長さの合計を 10.3 秒にする
    { id: "cue", seconds: 2.1, shot: "blooper", speaker: null, telop: null, script: null, wall: "result" },
    {
      id: "comment",
      seconds: 3.2,
      shot: "twoShot",
      speaker: "main",
      telop: null,
      script: { key: `race.news.comment.${tone}`, params: { winner } },
      wall: "photo",
    },
    // 締めの言葉 → 2 人でお辞儀 → 引きの画にエンドカード → 溶暗（いきなり競馬場に戻らないように）
    {
      id: "closing",
      seconds: 5,
      shot: "closing",
      speaker: "sub",
      telop: null,
      script: { key: "race.news.closing" },
      wall: "logo",
    },
  ];
};
