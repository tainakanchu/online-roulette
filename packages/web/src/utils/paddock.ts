// パドック（下見所）の計算。周回路の道筋（陸上トラックのような、2 つの半円を直線でつないだ形）と、
// 掲示板とテロップに出す馬体重。

export interface StadiumShape {
  /** 直線の半分の長さ（直線は x = −straightHalf〜+straightHalf） */
  straightHalf: number;
  /** 両端の半円の半径 */
  radius: number;
}

export interface PathPoint {
  x: number;
  z: number;
  /** 進む向き（y 軸まわりの回転。0 で +X を向く。three.js の rotation.y と同じ向き） */
  heading: number;
}

/** 周回路の 1 周の長さ */
export const lapLength = ({ straightHalf, radius }: StadiumShape) => 4 * straightHalf + 2 * Math.PI * radius;

/**
 * 周回路の上の点。左回り（上から見て反時計回り）に s だけ進んだ所。s = 0 は +Z 側の直線の中央で、そこでは +X へ進む。
 * @param offset 中心線から外側へずらす量（負なら内側）
 */
export const stadiumPoint = (shape: StadiumShape, s: number, offset = 0): PathPoint => {
  const { straightHalf: h, radius: r } = shape;
  const length = lapLength(shape);
  let d = ((s % length) + length) % length;
  const arc = Math.PI * r;
  const out = r + offset;
  // +Z 側の直線（中央から +X の端まで）
  if (d < h) return { x: d, z: out, heading: 0 };
  d -= h;
  // +X 側の半円（+Z 側から −Z 側へ回る）
  if (d < arc) {
    const a = d / r;
    return { x: h + Math.sin(a) * out, z: Math.cos(a) * out, heading: a };
  }
  d -= arc;
  // −Z 側の直線（+X の端から −X の端へ）
  if (d < 2 * h) return { x: h - d, z: -out, heading: Math.PI };
  d -= 2 * h;
  // −X 側の半円（−Z 側から +Z 側へ回る）
  if (d < arc) {
    const a = d / r;
    return { x: -h - Math.sin(a) * out, z: -Math.cos(a) * out, heading: Math.PI + a };
  }
  d -= arc;
  // +Z 側の直線（−X の端から中央まで）
  return { x: -h + d, z: out, heading: 0 };
};

/** x 座標が +Z 側の直線の上にあるとき、その点の s（入口から周回路に入る所） */
export const sOnUpperStraight = (shape: StadiumShape, x: number) => {
  const length = lapLength(shape);
  return x >= 0 ? x : length + x;
};

/** 名前などから作った seed から決める、0 以上 1 未満の値（同じ seed なら同じ値） */
const unit = (seed: number, salt: number) => {
  let t = (seed ^ Math.imul(salt, 0x9e3779b1)) >>> 0;
  t = Math.imul(t ^ (t >>> 16), 0x85ebca6b) >>> 0;
  t = Math.imul(t ^ (t >>> 13), 0xc2b2ae35) >>> 0;
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
};

/** 馬体重（kg）。サラブレッドの出走馬らしい 420〜540kg を、馬ごとに決める（2kg 刻み） */
export const horseWeight = (seed: number, raceCount: number) => {
  const base = 420 + Math.floor(unit(seed, 1) * 61) * 2;
  // レースごとに前走から増えたり減ったりする
  return base + weightChange(seed, raceCount);
};

/** 前走からの増減（kg）。−12〜+12 の 2kg 刻みで、0 前後が多い */
export const weightChange = (seed: number, raceCount: number) => {
  const a = unit(seed, 10 + raceCount);
  const b = unit(seed, 100 + raceCount);
  // −0 にならないよう 0 にそろえる
  return Math.round(((a + b - 1) * 12) / 2) * 2 || 0;
};

/** 増減の表示（+4・−6・0。JRA の表示と同じく、増えたら +、変わらなければ 0） */
export const formatWeightChange = (change: number) => (change > 0 ? `+${change}` : change < 0 ? `−${-change}` : "0");

/**
 * 周回の間隔。馬番の順に 1 列で歩く。頭数が少なければ詰めて歩き、多ければ 1 周に均等に並ぶ
 * @param maxGap 間隔の上限（ワールド単位）
 */
export const paddockGap = (shape: StadiumShape, count: number, maxGap = 14) =>
  count <= 0 ? maxGap : Math.min(maxGap, lapLength(shape) / count);

export interface RingOptions {
  /** 1 周の長さ */
  lap: number;
  /** 列の馬どうしの間隔（ふだん保つ間隔） */
  gap: number;
  /** これより近づかない間隔（馬 1 頭の長さと、前を歩く引き手の分） */
  minGap: number;
  /** 引かれて歩く速さ */
  walkSpeed: number;
}

/** 周回路の上で、from から前へ to まで進む距離（0 以上 lap 未満） */
export const aheadDistance = (from: number, to: number, lap: number) => (((to - from) % lap) + lap) % lap;

/** それぞれの馬の、すぐ前を歩く馬までの距離（1 頭だけなら Infinity） */
const gapsAhead = (positions: number[], lap: number) => {
  if (positions.length < 2) return positions.map(() => Infinity);
  const order = positions.map((_, i) => i).sort((a, b) => aheadDistance(0, positions[a], lap) - aheadDistance(0, positions[b], lap));
  const gaps = new Array<number>(positions.length);
  order.forEach((index, k) => {
    const next = order[(k + 1) % order.length];
    // 同じ位置に重なっていたら、前は 1 周先とみなさず 0 にする
    gaps[index] = aheadDistance(positions[index], positions[next], lap);
  });
  return gaps;
};

/**
 * 前の馬との間隔で歩く速さを決める（追従）。列の先頭（すぐ前が一番空いている馬）はふだんの速さで歩き、
 * 後ろの馬は前との間隔を gap に保つよう速さを変え、minGap まで近づいたら止まる。
 * Why not: 馬番の順の決まった位置へ向かわせると、遅れた馬が前の馬を追い越して重なる
 */
export const followSpeeds = (positions: number[], options: RingOptions): number[] => {
  const gaps = gapsAhead(positions, options.lap);
  const leader = gaps.indexOf(Math.max(...gaps));
  return gaps.map((ahead, i) => {
    if (i === leader) return options.walkSpeed;
    const room = (ahead - options.minGap) / Math.max(1e-3, options.gap - options.minGap);
    return options.walkSpeed * Math.min(1.3, Math.max(0, room));
  });
};

/** 1 ステップ進める。どの馬も、すぐ前の馬の minGap 手前より先へは進まない（追い越さない・重ならない） */
export const stepRing = (positions: number[], speeds: number[], dt: number, options: RingOptions): number[] => {
  const gaps = gapsAhead(positions, options.lap);
  return positions.map((s, i) => s + Math.min(speeds[i] * dt, Math.max(0, gaps[i] - options.minGap)));
};

/**
 * 入口から周回路に入ってよいか。入る所のすぐ後ろから来る馬が behind 以上、すぐ前を行く馬が front 以上離れていれば入る
 */
export const canMerge = (positions: number[], entry: number, lap: number, behind: number, front: number) =>
  positions.every((s) => aheadDistance(s, entry, lap) >= behind && aheadDistance(entry, s, lap) >= front);
