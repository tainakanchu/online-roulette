import { readQueryParam, writeQueryParams } from "../urlQuery";

describe("urlQuery", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/?options=a,b");
  });

  it("sets and removes params while keeping others", () => {
    writeQueryParams({ mode: "horseRace", distance: "2000" });
    expect(readQueryParam("mode")).toBe("horseRace");
    expect(readQueryParam("distance")).toBe("2000");
    expect(readQueryParam("options")).toBe("a,b");

    writeQueryParams({ distance: null });
    expect(readQueryParam("distance")).toBeNull();
    expect(readQueryParam("mode")).toBe("horseRace");
  });
});
