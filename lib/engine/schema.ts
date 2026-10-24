// The field schema shared by object types and event types, checked in the app before a write
// so people get a readable error; the database checks again with validate_properties (same
// rules, same messages). Also turns form input (text, comma decimals) into typed values.
// No server imports: the event form uses it in the browser.
import type { PropertySpec } from "./package";

export type Schema = Record<string, PropertySpec>;
export type Quantity = { value: number; unit: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const KEY = /^[a-z][a-z0-9_]{0,39}$/;

/** Problems of a field schema written by people (the schema editor, a project's result fields), null when fine. */
export function checkFields(fields: Schema, types: readonly string[]): string | null {
  if (!isObject(fields)) return "fields must be an object";
  const entries = Object.entries(fields);
  if (entries.length > 40) return "too many fields";
  for (const [k, s] of entries) {
    if (!KEY.test(k) || k === "ts") return `invalid field key "${k}"`;
    if (!isObject(s) || !types.includes(s.type)) return `invalid type for "${k}"`;
    if (s.type === "quantity" && !s.units?.length) return `"${k}" needs at least one unit`;
    if (s.min !== undefined && s.max !== undefined && s.min > s.max) return `"${k}": min is above max`;
    if (s.enum && (s.type !== "string" || !Array.isArray(s.enum) || !s.enum.length)) return `invalid options for "${k}"`;
  }
  return null;
}

const pgList = (a: unknown[]) => `[${a.map((x) => JSON.stringify(x)).join(", ")}]`;

const jsonType = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/** Mirror of the SQL validate_properties: null when valid, else the same error text. */
export function validateProperties(schema: Schema, props: unknown): string | null {
  if (!isObject(props)) return "properties must be an object";
  for (const k of Object.keys(props)) if (!(k in schema)) return `unknown property "${k}"`;

  for (const [k, spec] of Object.entries(schema)) {
    const v = props[k];
    if (v === undefined || v === null) {
      if (spec.required) return `property "${k}" is required`;
      continue;
    }
    let n: unknown = v;
    switch (spec.type) {
      case "integer":
        if (typeof v !== "number" || !Number.isInteger(v)) return `property "${k}" must be an integer`;
        break;
      case "timestamp":
        if (typeof v !== "string" || Number.isNaN(Date.parse(v))) return `property "${k}" must be a timestamp`;
        break;
      case "quantity":
        if (!isObject(v) || typeof v.value !== "number" || typeof v.unit !== "string" || Object.keys(v).some((x) => x !== "value" && x !== "unit"))
          return `property "${k}" must be a quantity {value, unit}`;
        if (spec.units && !spec.units.includes(v.unit)) return `property "${k}" unit must be one of ${pgList(spec.units)}`;
        n = v.value;
        break;
      case "string":
      case "number":
      case "boolean":
      case "object":
      case "array":
        if (jsonType(v) !== spec.type) return `property "${k}" must be a ${spec.type}`;
        break;
      default:
        return `property "${k}" has unknown type "${spec.type as string}"`;
    }
    if (spec.enum && !spec.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) return `property "${k}" must be one of ${pgList(spec.enum)}`;
    if (typeof n === "number") {
      if (spec.min !== undefined && n < spec.min) return `property "${k}" must be >= ${spec.min}`;
      if (spec.max !== undefined && n > spec.max) return `property "${k}" must be <= ${spec.max}`;
    }
  }
  return null;
}

/** Accepts 1234.5, 1234,5, 1.234,5 and 1,234.5; null when not a number. */
export function parseDecimal(v: string): number | null {
  let s = v.replace(/\s/g, "");
  const comma = s.lastIndexOf(","), dot = s.lastIndexOf(".");
  if (comma > dot) s = s.replace(/\./g, "").replace(",", ".");
  else s = s.replace(/,/g, "");
  const n = Number(s);
  return /^-?\d*\.?\d+$/.test(s) && Number.isFinite(n) ? n : null;
}

/** Day-only input (yyyy-mm-dd) is kept at midday UTC so it stays on its day in any zone. */
export function parseTimestamp(v: string): string | null {
  const s = v.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T12:00:00Z`) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Builds a payload from form strings: `name` for the value, `name.unit` for a quantity's unit.
 * Empty fields are left out. Returns the payload or, per field, why the text is not usable;
 * the schema rules themselves (required, enum, min, max) are checked by validateProperties.
 */
export function payloadFromForm(schema: Schema, form: Record<string, string | undefined>): { payload: Record<string, unknown>; errors: Record<string, string> } {
  const payload: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const [k, spec] of Object.entries(schema)) {
    const raw = form[k]?.trim() ?? "";
    if (!raw) continue;
    switch (spec.type) {
      case "number":
      case "integer": {
        const n = parseDecimal(raw);
        if (n === null) errors[k] = "notNumber";
        else payload[k] = n;
        break;
      }
      case "quantity": {
        const n = parseDecimal(raw);
        const unit = form[`${k}.unit`]?.trim() || (spec.units?.length === 1 ? spec.units[0] : "");
        if (n === null) errors[k] = "notNumber";
        else if (!unit) errors[k] = "unitRequired";
        else payload[k] = { value: n, unit };
        break;
      }
      case "boolean":
        payload[k] = raw === "true" || raw === "on";
        break;
      case "timestamp": {
        const t = parseTimestamp(raw);
        if (t === null) errors[k] = "notDate";
        else payload[k] = t;
        break;
      }
      case "object":
      case "array":
        try {
          payload[k] = JSON.parse(raw);
        } catch {
          errors[k] = "notJson";
        }
        break;
      default:
        payload[k] = raw;
    }
  }
  return { payload, errors };
}
