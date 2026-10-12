import { loadGoing, loadSurface, saveGoing, saveSurface } from "../raceCourse";

describe("コース（芝・ダート）と馬場状態の保存", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("未保存なら芝・良", () => {
    expect(loadSurface()).toBe("turf");
    expect(loadGoing()).toBe("firm");
  });

  it("保存した値を読み戻せる", () => {
    saveSurface("dirt");
    saveGoing("soft");
    expect(loadSurface()).toBe("dirt");
    expect(loadGoing()).toBe("soft");
  });

  it("知らない値が保存されていたら芝・良に戻す", () => {
    window.localStorage.setItem("roulette-horse-race-surface", "snow");
    window.localStorage.setItem("roulette-horse-race-going", "heavy");
    expect(loadSurface()).toBe("turf");
    expect(loadGoing()).toBe("firm");
  });
});
