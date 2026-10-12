// パドック中継のカメラマン（人が手で操作するカメラ）の動き。
// 自動追尾のように、被写体を毎フレーム画面の真ん中・同じ大きさ・ピントぴったりに保つのではなく、人がやるように
// 「ずれてきたら直す」。フレーミング・ズーム・ピントのどれも、許せる範囲を超えたら手で合わせ直し、合わせるときは少し行き過ぎる。
// 人の操作なので、気づくまでの間・直すまで我慢するずれ・行き過ぎる量・ズームとピントの見当は、毎回少しずつ違う（乱数）。
// Why not: 毎フレーム狙いへ合わせる（自動）と、動きが機械的で、人が操作している感じが出ない

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 被写体を向くときの高さ（馬の胸のあたり） */
const AIM_HEIGHT = 1.3;
/** 進む向きに空ける余白（ワールド単位。速さ 1 あたり） */
const LEAD_PER_SPEED = 0.35;
/** フレーミングのずれ（画面の幅に対する割合）がこの範囲のどこかを超えたら、振って直す（直すたびに選び直す） */
const FRAMING_TOLERANCE = [0.07, 0.15] as const;
/** 直すときに行き過ぎる割合（ずれに対して） */
const FRAMING_OVERSHOOT = [0.04, 0.2] as const;
/** 直してから次に直すまでの最短の間（秒） */
const FRAMING_COOLDOWN = 0.6;
/** ズームのずれ（画角の比の対数）がこれを超えたら、ズームレバーで合わせ直す */
const ZOOM_TOLERANCE = 0.14;
/** ズームレバーで画角を変える速さの上限（画角の比の対数 / 秒） */
export const ZOOM_MAX_RATE = 0.45;
/** 寄り直すときの大きさの見当違い（画角の比の対数）。ときどき大きく外して、もう一度合わせ直す */
const ZOOM_GUESS_ERROR = 0.09;
const ZOOM_BAD_GUESS_ERROR = 0.22;
const ZOOM_BAD_GUESS_CHANCE = 0.25;
/** ピントのずれ（距離に対する割合）がこれを超えたら、フォーカスを送り直す */
const FOCUS_TOLERANCE = 0.04;
/** 次の被写体へ振ると決めてから、振り出すまで（秒） */
export const OPERATOR_REACTION = [0.2, 0.5] as const;
/** 振り出してから、フォーカスを送り始めるまで（秒）。それまでは前の被写体の距離にピントが残る */
const REFOCUS_DELAY = 0.15;
/** 次の被写体へ振るときに、一度引く（ズームアウトする）割合 */
const SEARCH_ZOOM_OUT = [1.3, 1.8] as const;
/** 引いた後、寄り直し始めるまで（振り出してからの秒） */
const ZOOM_BACK_AFTER = [0.6, 1.2] as const;
/** ピントの探りの大きさ（被写体との距離に対するずれの割合） */
const FOCUS_HUNT = [0.25, 0.55] as const;

/**
 * 次の被写体へ振ったときのピントの探り（被写体との距離に対するずれの割合）。振り出しで一度外れ（amplitude が正なら奥、負なら手前）、
 * 送り戻すときに少し行き過ぎて反対へ外れ、また戻って合う（減衰する振動）
 * @param t 振り出してからの秒
 */
export const focusHunt = (t: number, amplitude: number) => {
  // まだ一度も振っていない（t が無限大）ときや、探り終えた後は 0（cos(∞) が NaN になるのを避ける）
  const isOutside = t < 0 || t > 4 || !Number.isFinite(t);
  if (isOutside) return 0;
  if (t < 0.45) {
    const p = t / 0.45;
    return amplitude * p * p * (3 - 2 * p);
  }
  const settle = t - 0.45;
  return amplitude * Math.exp(-settle * 3.2) * Math.cos(settle * 6.5);
};

const horizontalDistance = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

export interface OperatorFrame {
  /** 被写体の位置（足元） */
  subject: Vec3;
  /** 被写体の速さ（ワールド単位 / 秒） */
  subjectVelocity: Vec3;
  /** カメラの位置 */
  camera: Vec3;
  /** 被写体がちょうどよい大きさに見える画角（度） */
  idealFov: number;
  /** 画面の縦横比（幅 / 高さ） */
  aspect: number;
}

export class CameraOperator {
  /** カメラを向けたい所（実際にカメラを向ける動きは、RaceScene のバネが行き過ぎ気味に追う） */
  readonly aim: Vec3 = { x: 0, y: AIM_HEIGHT, z: 0 };
  /** 画角（度） */
  fov = 20;
  /** ピントを合わせている距離（探りのずれを含む） */
  focusDistance = 30;

  private time = 0;
  private retargetAt = -Infinity;
  /** 今回、気づいてから振り出すまで（秒） */
  private reaction = 0.3;
  private lastCorrectionAt = -Infinity;
  /** 今、どれだけずれたら直すか（直すたびに選び直す） */
  private framingTolerance = 0.1;
  /** 今回、寄り直し始めるまで（振り出してからの秒） */
  private zoomBackAfter = 0.9;
  /** 今回のピントの探り（正なら奥から、負なら手前から） */
  private huntAmplitude = 0;
  /** 歩く被写体に合わせて振る速さの割合。人は少し遅れ気味に振るので 1 より小さいことが多く、ときどき変わる */
  private panSpeed = 0.9;
  private nextPanSpeedAt = 0;
  private lnFov = Math.log(20);
  private lnFovVelocity = 0;
  private zoomTarget = Math.log(20);
  private isZooming = false;
  private hasZoomedBack = true;
  private focus = 30;
  private focusVelocity = 0;
  private focusTarget = 30;
  private isFocusing = false;

  constructor(private readonly random: () => number = Math.random) {}

  /** 振り始めてからの秒（振っていなければ Infinity） */
  get timeSinceRetarget() {
    return this.time - this.retargetAt;
  }

  /** 振り出してからの秒（振り出す前は負） */
  private get swingTime() {
    return this.timeSinceRetarget - this.reaction;
  }

  /** [min, max] の範囲の乱数 */
  private pick([min, max]: readonly [number, number]) {
    return min + this.random() * (max - min);
  }

  /** ちょうどよい大きさの見当（たいていは少しずれ、ときどき大きく外す） */
  private guessZoom(ideal: number) {
    const isBadGuess = this.random() < ZOOM_BAD_GUESS_CHANCE;
    const error = isBadGuess ? ZOOM_BAD_GUESS_ERROR : ZOOM_GUESS_ERROR;
    return ideal + (this.random() * 2 - 1) * error;
  }

  /** カットで入ったとき。今の被写体にフレーミング・ズーム・ピントを合わせた所から始める */
  snap(frame: OperatorFrame) {
    this.retargetAt = -Infinity;
    this.lastCorrectionAt = this.time;
    this.framingTolerance = this.pick(FRAMING_TOLERANCE);
    this.setAim(frame.subject, frame.subjectVelocity, 0);
    this.lnFov = Math.log(frame.idealFov);
    this.lnFovVelocity = 0;
    this.zoomTarget = this.lnFov;
    this.isZooming = false;
    this.hasZoomedBack = true;
    this.fov = frame.idealFov;
    this.focus = horizontalDistance(frame.camera, frame.subject);
    this.focusVelocity = 0;
    this.focusTarget = this.focus;
    this.isFocusing = false;
    this.focusDistance = this.focus;
  }

  /** 同じカメラのまま、次の被写体へ振る（気づいてから振り出すまで、前の被写体を向いたまま） */
  retarget() {
    this.retargetAt = this.time;
    this.reaction = this.pick(OPERATOR_REACTION);
    this.zoomBackAfter = this.pick(ZOOM_BACK_AFTER);
    this.huntAmplitude = this.pick(FOCUS_HUNT) * (this.random() < 0.7 ? 1 : -1);
    this.hasZoomedBack = false;
    // 次の被写体を画面に入れるため、一度引く
    this.zoomTarget = this.lnFov + Math.log(this.pick(SEARCH_ZOOM_OUT));
    this.isZooming = true;
  }

  update(dt: number, frame: OperatorFrame) {
    this.time += dt;
    this.updateFraming(dt, frame);
    this.updateZoom(dt, frame);
    this.updateFocus(dt, frame);
  }

  private setAim(subject: Vec3, velocity: Vec3, overshoot: number) {
    const lead = this.lead(velocity);
    const x = subject.x + lead.x;
    const z = subject.z + lead.z;
    this.aim.x = x + (x - this.aim.x) * overshoot;
    this.aim.z = z + (z - this.aim.z) * overshoot;
    this.aim.y = AIM_HEIGHT;
  }

  /** 進む向きに空ける余白 */
  private lead(velocity: Vec3) {
    const speed = Math.hypot(velocity.x, velocity.z);
    if (speed < 1e-3) return { x: 0, z: 0 };
    const amount = Math.min(speed, 2) * LEAD_PER_SPEED;
    return { x: (velocity.x / speed) * amount, z: (velocity.z / speed) * amount };
  }

  private updateFraming(dt: number, frame: OperatorFrame) {
    const isReacting = this.swingTime < 0;
    if (isReacting) return;
    const isFirstSwing = this.swingTime - dt < 0;
    if (isFirstSwing) {
      // 振り出し: 次の被写体へ向けて大きく振る
      this.setAim(frame.subject, frame.subjectVelocity, this.pick(FRAMING_OVERSHOOT));
      this.lastCorrectionAt = this.time;
      return;
    }
    // 歩く被写体に合わせて振り続ける。速さは目分量なので、少し遅れ気味（ときどき変える）
    if (this.time >= this.nextPanSpeedAt) {
      this.panSpeed = 0.7 + this.random() * 0.35;
      this.nextPanSpeedAt = this.time + 1 + this.random() * 1.5;
    }
    this.aim.x += frame.subjectVelocity.x * this.panSpeed * dt;
    this.aim.z += frame.subjectVelocity.z * this.panSpeed * dt;
    // ずれが許せる範囲を超えたら、振って直す（少し行き過ぎる）
    const lead = this.lead(frame.subjectVelocity);
    const intended = { x: frame.subject.x + lead.x, y: AIM_HEIGHT, z: frame.subject.z + lead.z };
    const distance = Math.max(1, horizontalDistance(frame.camera, frame.subject));
    const frameWidth = 2 * distance * Math.tan(((this.fov / 2) * Math.PI) / 180) * frame.aspect;
    const drift = horizontalDistance(intended, this.aim) / frameWidth;
    const canCorrect = this.time - this.lastCorrectionAt >= FRAMING_COOLDOWN;
    if (drift > this.framingTolerance && canCorrect) {
      this.setAim(frame.subject, frame.subjectVelocity, this.pick(FRAMING_OVERSHOOT));
      this.lastCorrectionAt = this.time;
      this.framingTolerance = this.pick(FRAMING_TOLERANCE);
    }
  }

  private updateZoom(dt: number, frame: OperatorFrame) {
    const ideal = Math.log(frame.idealFov);
    // 振って次の被写体を画面に入れたら、寄り直す（ちょうどよい大きさは目分量なので少しずれる）
    if (!this.hasZoomedBack && this.swingTime >= this.zoomBackAfter) {
      this.hasZoomedBack = true;
      this.zoomTarget = this.guessZoom(ideal);
      this.isZooming = true;
    }
    // 大きさが許せる範囲を超えてずれたら、ズームレバーで合わせ直す
    const isOff = Math.abs(this.lnFov - ideal) > ZOOM_TOLERANCE;
    if (this.hasZoomedBack && !this.isZooming && isOff) {
      this.zoomTarget = this.guessZoom(ideal);
      this.isZooming = true;
    }
    if (!this.isZooming) return;
    // ズームレバーは押し始めと離しぎわがなめらかで、少し行き過ぎて戻す（減衰比 0.6 のバネ）。速さには上限がある
    const omega = 2.4;
    const accel = (this.zoomTarget - this.lnFov) * omega * omega - 2 * 0.6 * omega * this.lnFovVelocity;
    this.lnFovVelocity = Math.max(-ZOOM_MAX_RATE, Math.min(ZOOM_MAX_RATE, this.lnFovVelocity + accel * dt));
    this.lnFov += this.lnFovVelocity * dt;
    const isSettled = Math.abs(this.lnFov - this.zoomTarget) < 0.01 && Math.abs(this.lnFovVelocity) < 0.02;
    if (isSettled) {
      this.isZooming = false;
      this.lnFovVelocity = 0;
    }
    this.fov = Math.exp(this.lnFov);
  }

  private updateFocus(dt: number, frame: OperatorFrame) {
    const distance = horizontalDistance(frame.camera, frame.subject);
    const swingTime = this.swingTime;
    const isHolding = swingTime < REFOCUS_DELAY;
    if (!isHolding) {
      const isSoft = Math.abs(this.focus - distance) / distance > FOCUS_TOLERANCE;
      const isNewSubject = swingTime - dt < REFOCUS_DELAY;
      if ((isSoft || isNewSubject) && !this.isFocusing) {
        this.focusTarget = distance * (1 + (this.random() - 0.5) * 0.03);
        this.isFocusing = true;
      }
      if (this.isFocusing) {
        // 追っている間に被写体が動いた分は、送りながら合わせ直す
        this.focusTarget += (distance - this.focusTarget) * Math.min(1, dt * 2);
        // フォーカスリングを回しすぎて少し戻す（減衰比 0.5 のバネ）
        const omega = 2.8;
        const accel = (this.focusTarget - this.focus) * omega * omega - 2 * 0.5 * omega * this.focusVelocity;
        this.focusVelocity += accel * dt;
        this.focus += this.focusVelocity * dt;
        const isSettled = Math.abs(this.focus - this.focusTarget) / distance < 0.005 && Math.abs(this.focusVelocity) < 0.05;
        if (isSettled) {
          this.isFocusing = false;
          this.focusVelocity = 0;
        }
      }
    }
    this.focusDistance = this.focus * (1 + focusHunt(swingTime, this.huntAmplitude));
  }
}
