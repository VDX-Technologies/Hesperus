// File reading: tables out of spreadsheets, delimited and laid out text and PDFs, text for the rest.
import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extract, fileFormat } from "../../lib/engine/extract";

const enc = (s: string) => new TextEncoder().encode(s);

describe("file reading", () => {
  it("names the format from the extension or the type", () => {
    expect(fileFormat("a.CSV")).toBe("csv");
    expect(fileFormat("raccolta.xlsx")).toBe("sheet");
    expect(fileFormat("vecchio.xls")).toBe("sheet");
    expect(fileFormat("x", "application/pdf")).toBe("pdf");
    expect(fileFormat("nota.docx")).toBe("word");
    expect(fileFormat("foto.JPG")).toBe("image");
    expect(fileFormat("appunti.txt")).toBe("text");
    expect(fileFormat("boh.bin")).toBe("other");
  });

  it("finds the table of a spreadsheet under its title, with dates and numbers", async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["Registro raccolta 2026"],
      [],
      ["Data", "Appezzamento", "Quantità kg", ""],
      [new Date(Date.UTC(2026, 8, 3)), "Vigna nord", 1250.5],
      [new Date(Date.UTC(2026, 8, 4, 7, 30)), "Vigna sud", 980],
      [],
    ], { cellDates: true, UTC: true });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["note"]]), "Note");
    XLSX.utils.book_append_sheet(wb, ws, "Raccolta");
    for (const bookType of ["xlsx", "xls", "ods"] as const) {
      const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType }));
      const r = await extract(`f.${bookType}`, "", bytes);
      expect(r.format).toBe("sheet");
      expect(r.table?.headers).toEqual(["Data", "Appezzamento", "Quantità kg"]);
      expect(r.table?.rows).toEqual([
        ["2026-09-03", "Vigna nord", "1250.5"],
        ["2026-09-04 07:30", "Vigna sud", "980"],
      ]);
      // an xlsx with a wrong name is still read
      if (bookType === "xlsx") expect((await extract("export.bin", "", bytes)).table?.rows.length).toBe(2);
    }
  });

  it("reads csv, and tables in plain text laid out with spaces", async () => {
    expect((await extract("a.csv", "", enc("data;kg\n03/09/2026;12\n"))).table).toEqual({ headers: ["data", "kg"], rows: [["03/09/2026", "12"]] });
    const txt = "Trattamenti settembre\n\nData        Prodotto        Dose\n03/09/2026  Rame ossicloruro  2,5\n10/09/2026  Zolfo           3\n\nFirmato\n";
    const t = await extract("note.txt", "text/plain", enc(txt));
    expect(t.table?.headers).toEqual(["Data", "Prodotto", "Dose"]);
    expect(t.table?.rows).toEqual([["03/09/2026", "Rame ossicloruro", "2,5"], ["10/09/2026", "Zolfo", "3"]]);
    // prose is text, not a table
    const prose = await extract("lettera.txt", "", enc("Gentile cliente, le scriviamo per conto dell'azienda.\nCordiali saluti, la direzione.\n"));
    expect(prose.table).toBeNull();
    expect(prose.text).toContain("Gentile cliente");
  });

  it("rebuilds a PDF table from where the words are", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([595, 842]);
    const at = (s: string, x: number, y: number) => page.drawText(s, { x, y, size: 10, font });
    at("Registro trattamenti - Azienda Rossi", 50, 800);
    const rows = [
      ["Data", "Appezzamento", "Prodotto", "Dose"],
      ["03/09/2026", "Vigna nord", "Rame", "2,5"],
      ["10/09/2026", "Vigna sud", "", "3"],
      ["17/09/2026", "Uliveto", "Zolfo bagnabile", "4"],
    ];
    rows.forEach((r, i) => r.forEach((c, k) => c && at(c, [50, 150, 280, 420][k], 760 - i * 16)));
    at("Pagina 1", 280, 40);
    const r = await extract("registro.pdf", "application/pdf", await pdf.save());
    expect(r.format).toBe("pdf");
    expect(r.table?.headers).toEqual(rows[0]);
    expect(r.table?.rows).toEqual(rows.slice(1));
    expect(r.text).toContain("Azienda Rossi");
  });

  it("keeps any other file, even unreadable, with no table", async () => {
    expect(await extract("foto.jpg", "image/jpeg", new Uint8Array([0xff, 0xd8, 0xff, 0, 1, 2]))).toEqual({ format: "image", table: null, text: null });
    expect((await extract("rotto.xlsx", "", enc("not a zip"))).table).toBeNull();
    expect((await extract("x.bin", "", new Uint8Array(200).map((_, i) => i % 7))).text).toBeNull();
  });

  it("refuses a zip that inflates past the limit before parsing it", async () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["a", "b"], ...Array.from({ length: 2000 }, () => ["x".repeat(50), 1])]), "S");
    const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx", compression: true }));
    await expect(extract("bomba.xlsx", "", bytes, { maxInflatedBytes: 50_000 })).rejects.toMatchObject({ limit: "inflated" });
    expect((await extract("bomba.xlsx", "", bytes)).table).not.toBeNull();
  });
});
