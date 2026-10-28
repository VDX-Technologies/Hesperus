import { describe, expect, it } from "vitest";
import { guessFields } from "../../lib/packages/records/model";

describe("guessing fields from headers", () => {
  it("matches names, synonyms and headers with units, each field once", () => {
    expect(guessFields(["Data", "Campo", "Prodotto", "Dose (l/ha)", "Superficie ha", "Operatore"])).toEqual(["date", "subject", "product", "dose", "area", "operator"]);
    expect(guessFields(["operatore", "prodotto", "data", "superficie", "appezzamento", "dose"])).toEqual(["operator", "product", "date", "area", "subject", "dose"]);
    expect(guessFields(["Data", "Località", "Quantità (kg/ha)", "Note interne", "Colonna X"])).toEqual(["date", "subject", "quantity", "note", ""]);
    expect(guessFields(["Data trattamento", "Data registrazione", "Field"])).toEqual(["date", "", "subject"]);
  });
});
