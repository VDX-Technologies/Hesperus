import { ValidationError, type ModulePackage } from "../../engine/package";
import { records } from "./model";

export { records };

const TEXT = ["kind", "unit", "product", "adversity", "operator", "note"] as const;
const NUMBERS = ["quantity", "dose", "area"] as const;

export function parseDate(v: unknown): Date {
  const s = String(v ?? "").trim();
  const eu = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(s);
  if (eu) {
    const [, d, m, y, hh, mm] = eu.map(Number);
    const year = y < 100 ? 2000 + y : y;
    const date = new Date(Date.UTC(year, m - 1, d, hh || 12, mm || 0));
    if (date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) throw new ValidationError(`invalid date "${s}"`);
    return date;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T12:00:00Z`);
  const date = /^\d{4}-\d{2}-\d{2}T/.test(s) ? new Date(s) : null;
  if (!date || Number.isNaN(date.getTime())) throw new ValidationError(`invalid date "${s}"`);
  return date;
}

export function parseNumber(v: unknown, field: string): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "number") return v;
  let s = String(v).replace(/\s/g, "");
  const comma = s.lastIndexOf(","), dot = s.lastIndexOf(".");
  if (comma > dot) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  if (!/^-?\d*\.?\d+$/.test(s) || !Number.isFinite(n)) throw new ValidationError(`${field} is not a number: "${v}"`);
  return n;
}

export const recordsPackage: ModulePackage = {
  id: "records",
  objectTypes: [{ key: "subject", name: { en: "Register subject", it: "Soggetto del registro" }, properties: {} }],
  metrics: [
    { key: "quantity", label: { en: "Quantity", it: "Quantità" } },
    { key: "dose", label: { en: "Dose", it: "Dose" } },
    { key: "area", label: { en: "Area", it: "Superficie" } },
  ],
  normalize(m) {
    const subject = String(m.subject ?? "").trim();
    if (!subject) throw new ValidationError("subject is required");
    if (m.date === undefined || m.date === "") throw new ValidationError("date is required");
    const ts = parseDate(m.date);
    const payload: Record<string, unknown> = {};
    for (const k of TEXT) if (m[k] !== undefined && m[k] !== "") payload[k] = String(m[k]);
    const metrics: Record<string, number | undefined> = {};
    for (const k of NUMBERS) {
      const n = parseNumber(m[k], k);
      if (n !== undefined) payload[k] = metrics[k] = n;
    }
    return {
      object: { type: "subject", externalId: subject, name: subject },
      ts,
      metrics,
      events: [{ type: "entry", severity: "info", payload }],
    };
  },
};
