import { useCallback, useRef, useMemo } from "react";

// 1シャカ = 往復1回分（ジャラ・ジャラ）のパラメータ
const BURST_SEC = 0.07; // ノイズバースト1発分（70ms）
const INNER_GAP_SEC = 0.03; // 往路↔復路の間の短い隙間（30ms）
const TAIL_GAP_SEC = 0.08; // 1シャカ末尾の間（80ms）＝次のシャカとの区切り
const ATTACK_SEC = 0.004; // 立ち上がり（4ms）
const DECAY_SEC = 0.02; // 減衰（20ms）

/**
 * バッファ上にエンベロープ付きノイズバーストを1発書き込む。
 */
const writeBurst = (
  data: Float32Array,
  offset: number,
  burstSamples: number,
  attackSamples: number,
  decaySamples: number,
  amplitude: number
) => {
  for (let i = 0; i < burstSamples; i++) {
    let envelope = 1;
    if (i < attackSamples) {
      envelope = i / attackSamples;
    } else if (i > burstSamples - decaySamples) {
      envelope = (burstSamples - i) / decaySamples;
    }
    data[offset + i] = (Math.random() * 2 - 1) * envelope * amplitude;
  }
};

/**
 * 1シャカ分のバッファを生成する。
 * [burst1 → inner gap → burst2 → tail gap] の往復構造。
 * ループ再生で「ジャラジャラ・ジャラジャラ…」のリズムを形成する。
 */
const createShakaBuffer = (sampleRate: number): AudioBuffer => {
  const burstSamples = Math.floor(sampleRate * BURST_SEC);
  const innerGapSamples = Math.floor(sampleRate * INNER_GAP_SEC);
  const tailGapSamples = Math.floor(sampleRate * TAIL_GAP_SEC);
  const attackSamples = Math.floor(sampleRate * ATTACK_SEC);
  const decaySamples = Math.floor(sampleRate * DECAY_SEC);

  const totalSamples =
    burstSamples + innerGapSamples + burstSamples + tailGapSamples;

  const buffer = new AudioBuffer({
    numberOfChannels: 1,
    length: totalSamples,
    sampleRate,
  });
  const data = buffer.getChannelData(0);

  // 往路（ジャラ↑）
  writeBurst(data, 0, burstSamples, attackSamples, decaySamples, 1.0);

  // 復路（ジャラ↓）— わずかに音量を落として自然な往復感を出す
  const burst2Offset = burstSamples + innerGapSamples;
  writeBurst(data, burst2Offset, burstSamples, attackSamples, decaySamples, 0.8);

  // inner gap / tail gap は 0 のまま

  return buffer;
};

/**
 * 並列フィルタパスを作成するヘルパー。
 * 異なる周波数帯の共振を並列にミックスすることで
 * 複数の物体がぶつかり合う「じゃらじゃら」感を再現する。
 */
const createFilterPath = (
  ctx: AudioContext,
  freq: number,
  q: number,
  gain: number
): { input: BiquadFilterNode; output: GainNode } => {
  const bp = ctx.createBiquadFilter();
  bp.type = "bandpass";
  bp.frequency.value = freq;
  bp.Q.value = q;

  const pathGain = ctx.createGain();
  pathGain.gain.value = gain;

  bp.connect(pathGain);
  return { input: bp, output: pathGain };
};

/**
 * Web Audio API を用いて、おみくじを振るような「じゃらじゃら」音を生成するフック。
 *
 * - start(): シャカ音のループ再生を開始
 * - stop(): 再生中の1シャカが鳴り終わった後に自然停止
 */
export const useShakeSound = () => {
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);

  // シャカバッファはサンプルレート依存のため、初回生成してキャッシュ
  const bufferRef = useRef<AudioBuffer | null>(null);
  const sampleRate = useMemo(() => new AudioContext().sampleRate, []);

  const getBuffer = useCallback(() => {
    if (!bufferRef.current) {
      bufferRef.current = createShakaBuffer(sampleRate);
    }
    return bufferRef.current;
  }, [sampleRate]);

  const start = useCallback(() => {
    try {
      // 前回のコンテキストが残っている場合はクリーンアップ
      if (ctxRef.current) {
        try {
          sourceRef.current?.stop();
          ctxRef.current.close();
        } catch {
          // ignore
        }
      }

      const ctx = new AudioContext();
      ctxRef.current = ctx;

      if (ctx.state === "suspended") {
        ctx.resume();
      }

      const source = ctx.createBufferSource();
      source.buffer = getBuffer();
      source.loop = true;

      // ハイパスフィルタ：低音のこもりを除去
      const highpass = ctx.createBiquadFilter();
      highpass.type = "highpass";
      highpass.frequency.value = 400;

      // 並列フィルタパス：異なる周波数帯を個別にミックスし、じゃらじゃら感を生成
      const paths = [
        createFilterPath(ctx, 1000, 4, 0.3), // 低め：木箱の胴鳴り
        createFilterPath(ctx, 2200, 5, 0.4), // 中域：竹・木の棒がぶつかる音
        createFilterPath(ctx, 3800, 6, 0.35), // 高め：金属的な響き
        createFilterPath(ctx, 5500, 4, 0.2), // 超高域：シャリシャリした倍音
      ];

      // ミキサー（並列パスの合流点）
      const mixer = ctx.createGain();
      mixer.gain.value = 1;

      // マスターゲイン
      const masterGain = ctx.createGain();
      masterGain.gain.value = 0.5;

      // source → highpass → 各並列パス → mixer → masterGain → 出力
      source.connect(highpass);
      for (const path of paths) {
        highpass.connect(path.input);
        path.output.connect(mixer);
      }
      mixer.connect(masterGain);
      masterGain.connect(ctx.destination);

      source.start();
      sourceRef.current = source;

      // ループ解除後の自動クリーンアップ
      source.onended = () => {
        try {
          ctx.close();
        } catch {
          // ignore
        }
        if (ctxRef.current === ctx) {
          ctxRef.current = null;
        }
        sourceRef.current = null;
      };
    } catch {
      // Web Audio API が利用不可の場合は無視
    }
  }, [getBuffer]);

  const stop = useCallback(() => {
    if (sourceRef.current) {
      // ループを解除 → 現在再生中の1シャカが終わったら自然に停止
      sourceRef.current.loop = false;
    }
  }, []);

  return { start, stop };
};
