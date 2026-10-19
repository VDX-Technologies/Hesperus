// Column recognition: headers, values, known subjects and what earlier uploads taught.
import { describe, expect, it } from "vitest";
import { emptyMemory, learn, profile, recognize, signature } from "../../lib/packages/records/recognize";

const fields = (r: ReturnType<typeof recognize>) => r.columns.map((c) => c.field);

describe("column recognition", () => {
  it("profiles values: dates, numbers and their range, known subjects", () => {
    const p = profile(["03/09/2026", "2026-09-04", "10.09.26", ""]);
    expect(p.date).toBe(1);
    expect(p.filled).toBe(0.75);
    const n = profile(["1.250,5", "980", "12"]);
    expect(n).toMatchObject({ number: 1, min: 12, max: 1250.5, date: 0 });
    expect(profile(["Vigna nord", "Uliveto"], new Set(["vigna nord"])).known).toBe(0.5);
  });

  it("maps a file by its headers, sure of every column", () => {
    const r = recognize({
      headers: ["Data", "Campo", "Prodotto", "Dose (l/ha)", "Superficie ha", "Operatore"],
      rows: [
        ["03/09/2026", "Vigna nord", "Rame", "2,5", "1,2", "Mario Rossi"],
        ["10/09/2026", "Vigna sud", "Zolfo", "3", "0,8", "Luca Bianchi"],
      ],
    });
    expect(fields(r)).toEqual(["date", "subject", "product", "dose", "area", "operator"]);
    expect(r.missing).toEqual([]);
    expect(r.columns.every((c) => c.confidence >= 0.8)).toBe(true);
  });

  it("maps columns with no name from their values", () => {
    const r = recognize(
      {
        headers: ["#1", "#2", "#3"],
        rows: [
          ["2026-09-03", "Vigna nord", "1250"],
          ["2026-09-04", "Uliveto", "980"],
          ["2026-09-05", "Vigna nord", "1100"],
        ],
      },
      { subjects: new Set(["vigna nord", "uliveto"]) },
    );
    expect(fields(r).slice(0, 2)).toEqual(["date", "subject"]);
    expect(r.missing).toEqual([]);
  });

  it("does not take a column of numbers for a date because of its name", () => {
    const r = recognize({ headers: ["Data", "Giorno", "Campo"], rows: [["03/09/2026", "12", "A"], ["04/09/2026", "13", "B"]] });
    expect(fields(r)).toEqual(["date", "", "subject"]);
  });

  it("learns a supplier's own words and recognises its next file", () => {
    const first = { headers: ["Dt", "Cod. app", "Qli"], rows: [["03/09/2026", "VN-01", "12,5"], ["04/09/2026", "VS-02", "9"]] };
    // the dates are found from the values alone
    expect(fields(recognize(first))[0]).toBe("date");
    const mem = learn(emptyMemory(), first, { Dt: "date", "Cod. app": "subject", Qli: "quantity" });
    // the same columns again: mapped from memory, fully sure
    const again = recognize({ ...first, headers: ["Qli", "Dt", "Cod. app"] }, { memory: mem });
    expect(again.known).toBe(true);
    expect(again.signature).toBe(signature(first.headers));
    // a new file with the same words, plus a column never seen
    const next = recognize(
      { headers: ["Dt", "Cod. app", "Qli", "Autista"], rows: [["05/09/2026", "VN-01", "14", "Gino"], ["06/09/2026", "VN-03", "11", "Pino"]] },
      { memory: mem },
    );
    expect(next.known).toBe(false);
    expect(fields(next).slice(0, 3)).toEqual(["date", "subject", "quantity"]);
    expect(next.columns[1].by).toBe("learned");
  });

  it("maps a file seen before exactly as it was confirmed", () => {
    const t = { headers: ["A", "B"], rows: [["x", "y"]] };
    const mem = learn(emptyMemory(), t, { A: "subject", B: "note" });
    const r = recognize(t, { memory: mem });
    expect(r.known).toBe(true);
    expect(r.columns).toEqual([
      { header: "A", field: "subject", confidence: 1, by: "memory" },
      { header: "B", field: "note", confidence: 1, by: "memory" },
    ]);
  });
});
