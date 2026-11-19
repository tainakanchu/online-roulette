import type { RaceTick } from "./scene/RaceScene";

// 実況（i18n キー + パラメータ）を位置情報から生成する

export interface CommentaryLine {
  key: string;
  params?: Record<string, string>;
}

const MIN_INTERVAL_MS = 1300;
/** 追い上げを判定する間隔。実際の速さでは順位がゆっくり入れ替わるので、数秒あけて比べる */
const SURGE_WINDOW_MS = 2500;
/** 「最後の直線」と言う、先頭からゴールまでの残り（m） */
const STRETCH_REMAINING_METERS = 450;
/** 「並んだ」と言う、先頭からゴールまでの残り（m） */
const CLOSE_REMAINING_METERS = 250;
/** 長いレースの道中で、残り距離と隊列を伝える地点（ゴールまでの残り m）。間が空きすぎないようにする */
const FURLONG_CALLS = [2400, 2000, 1600, 1200, 800];
/** 1・2着の見た目の差（単位）。「接戦」は約15m、「写真判定」は約7m（2〜3馬身） */
const CLOSE_GAP = 0.35;
const PHOTO_GAP = 0.15;

export class Commentator {
  private lastAt = 0;
  private leader = -1;
  private saidEarly = false;
  private saidHalf = false;
  private saidStretch = false;
  private saidClose = false;
  private readonly calledFurlongs = new Set<number>();
  private snapshot: { at: number; order: number[] } | null = null;
  private lastGap = Infinity;

  constructor(
    private readonly names: string[],
    private readonly now: () => number = () => Date.now()
  ) {}

  start(): CommentaryLine {
    this.lastAt = this.now();
    return { key: "race.commentary.start" };
  }

  feed(tick: RaceTick): CommentaryLine | null {
    const now = this.now();
    const [first, second, third] = tick.order;
    const name = (i: number | undefined) => (i === undefined ? "" : (this.names[i] ?? ""));
    this.lastGap = tick.gapTop2;
    const ready = now - this.lastAt >= MIN_INTERVAL_MS;

    // 追い上げ判定用に 1 秒ごとの順位スナップショットを取る
    let surger: number | null = null;
    if (!this.snapshot || now - this.snapshot.at > SURGE_WINDOW_MS) {
      if (this.snapshot && tick.leaderFraction > 0.55) {
        for (const horse of tick.order.slice(0, 3)) {
          const before = this.snapshot.order.indexOf(horse);
          const after = tick.order.indexOf(horse);
          if (before - after >= 3) {
            surger = horse;
            break;
          }
        }
      }
      this.snapshot = { at: now, order: [...tick.order] };
    }

    const say = (line: CommentaryLine): CommentaryLine => {
      this.lastAt = now;
      return line;
    };

    const leaderChanged = first !== this.leader;
    this.leader = first;

    if (!ready) return null;

    if (!this.saidClose && tick.remainingMeters < CLOSE_REMAINING_METERS && tick.gapTop2 < CLOSE_GAP) {
      this.saidClose = true;
      return say({ key: "race.commentary.close", params: { first: name(first), second: name(second) } });
    }
    if (surger !== null) {
      return say({ key: "race.commentary.surge", params: { name: name(surger) } });
    }
    if (!this.saidStretch && tick.remainingMeters <= STRETCH_REMAINING_METERS) {
      this.saidStretch = true;
      return say({ key: "race.commentary.stretch", params: { name: name(first) } });
    }
    if (!this.saidHalf && tick.leaderFraction >= 0.5) {
      this.saidHalf = true;
      return say({
        key: "race.commentary.halfway",
        params: { first: name(first), second: name(second), third: name(third) },
      });
    }
    const furlong = FURLONG_CALLS.find(
      (meters) =>
        !this.calledFurlongs.has(meters) &&
        tick.remainingMeters <= meters &&
        tick.remainingMeters > meters - 150 &&
        // スタートしてすぐ（隊列が決まる前）は言わない
        tick.leaderFraction > 0.15
    );
    if (furlong !== undefined && this.saidEarly) {
      this.calledFurlongs.add(furlong);
      return say({
        key: "race.commentary.furlong",
        params: { meters: String(furlong), first: name(first), second: name(second) },
      });
    }
    if (!this.saidEarly && tick.leaderFraction >= 0.08) {
      this.saidEarly = true;
      return say({ key: "race.commentary.early", params: { name: name(first) } });
    }
    if (leaderChanged && tick.leaderFraction > 0.15) {
      return say({ key: "race.commentary.takeLead", params: { name: name(first) } });
    }
    return null;
  }

  finish(winner: number): CommentaryLine {
    this.lastAt = this.now();
    const params = { name: this.names[winner] ?? "" };
    return this.lastGap < PHOTO_GAP
      ? { key: "race.commentary.photo", params }
      : { key: "race.commentary.finish", params };
  }
}
