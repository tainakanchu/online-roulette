import { buildRaceNews, cueCardAt, newsTone, rundownSeconds, type RaceNewsInput } from "../raceNews";

const input = (overrides: Partial<RaceNewsInput> = {}): RaceNewsInput => ({
  raceName: "ルーレット記念",
  courseLabel: "芝 1600m・良",
  field: [
    { name: "アカ", popularity: 2, style: "front" },
    { name: "アオ", popularity: 1, style: "closer" },
    { name: "キイロ", popularity: 6, style: "deep" },
  ],
  order: [1, 0, 2],
  marginLengths: 1.5,
  margin: "1 1/2",
  photo: false,
  finalTime: "1:33.5",
  ...overrides,
});

describe("勝ち方の種類", () => {
  it("写真判定は着差や人気より優先する", () => {
    expect(newsTone(input({ photo: true, marginLengths: 0.02, order: [2, 0, 1] }))).toBe("photo");
  });

  it("3 馬身以上離せば圧勝", () => {
    expect(newsTone(input({ marginLengths: 3.2 }))).toBe("rout");
  });

  it("5 番人気以下の勝利は波乱、1 番人気の勝利は人気に応えた勝利", () => {
    expect(newsTone(input({ order: [2, 0, 1] }))).toBe("upset");
    expect(newsTone(input())).toBe("favorite");
    expect(newsTone(input({ order: [0, 1, 2] }))).toBe("standard");
  });
});

describe("ニュースの構成", () => {
  it("オープニング・結果・VTR・着順と時計・カンペの映り込み・ひとこと・エンディングの順に並ぶ", () => {
    const segments = buildRaceNews(input());
    expect(segments.map((s) => s.id)).toEqual(["opening", "headline", "vtr", "result", "cue", "comment", "closing"]);
    expect(segments.find((s) => s.id === "vtr")?.shot).toBe("vtr");
  });

  it("見出しのテロップと原稿に、勝ち馬とレース名が入る", () => {
    const headline = buildRaceNews(input()).find((s) => s.id === "headline");
    expect(headline?.telop?.params).toMatchObject({ race: "ルーレット記念", winner: "アオ" });
    expect(headline?.script?.key).toBe("race.news.headline.favorite");
  });

  it("VTR の原稿は勝ち馬の脚質で変わる", () => {
    expect(buildRaceNews(input()).find((s) => s.id === "vtr")?.script?.key).toBe("race.news.vtr.closer");
    expect(buildRaceNews(input({ order: [0, 1, 2] })).find((s) => s.id === "vtr")?.script?.key).toBe("race.news.vtr.front");
  });

  it("2 頭立てでは 3 着を読まない", () => {
    const result = buildRaceNews(input({ field: input().field.slice(0, 2), order: [1, 0] })).find((s) => s.id === "result");
    expect(result?.script).toEqual({ key: "race.news.result.second", params: { second: "アカ", time: "1:33.5" } });
  });

  it("AD のカンペが映るのは番組の残りが 10 秒になったところ", () => {
    const segments = buildRaceNews(input());
    const cue = segments.findIndex((s) => s.id === "cue");
    const remaining = rundownSeconds(segments.slice(cue));
    expect(cueCardAt(remaining).lines[0].key).toBe("race.news.cue.ten");
  });

  it("全体で 30 秒ほどに収まる", () => {
    const seconds = rundownSeconds(buildRaceNews(input()));
    expect(seconds).toBeGreaterThan(25);
    expect(seconds).toBeLessThan(36);
  });
});

describe("カンペ", () => {
  it("残り時間で「巻きで」→「10秒前」→「5秒前」→「CM」と変わり、秒数は赤で書く", () => {
    expect(cueCardAt(14.2)).toEqual({
      lines: [{ key: "race.news.cue.hurry" }, { key: "race.news.cue.left", params: { seconds: 15 } }],
      accent: [1],
    });
    expect(cueCardAt(9.8)).toEqual({ lines: [{ key: "race.news.cue.ten" }], accent: [0] });
    expect(cueCardAt(4.6)).toEqual({ lines: [{ key: "race.news.cue.five" }], accent: [0] });
    expect(cueCardAt(1).lines[0].key).toBe("race.news.cue.break");
  });
});
