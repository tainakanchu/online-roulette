import { historyStorage } from "../historyStorage";

beforeEach(() => localStorage.clear());

describe("historyStorage", () => {
  it.each(["null", "{}", '{"entries":null}', '{"entries":{}}', "invalid JSON"])(
    "returns empty history and allows adding a result for %s",
    (stored) => {
      localStorage.setItem("roulette-history", stored);
      expect(historyStorage.getHistory()).toEqual({ entries: [] });
      historyStorage.addEntry("winner");
      expect(historyStorage.getHistory().entries).toEqual([
        { result: "winner", timestamp: expect.any(Number) },
      ]);
    }
  );

  it("drops malformed entries while preserving valid entries and their order", () => {
    const entries = [{ result: "first", timestamp: 123 }, { result: "", timestamp: 0 }];
    localStorage.setItem("roulette-history", JSON.stringify({ entries: [
      entries[0], null, {}, { result: 1, timestamp: 123 },
      { result: "bad", timestamp: "123" }, { result: "bad", timestamp: null }, entries[1],
    ] }));
    expect(historyStorage.getHistory()).toEqual({ entries });
  });
});
