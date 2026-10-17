// A module package is configuration plus a normalizer: the engine never knows what a
// greenhouse or a drone is. Packages declare their object types and metric keys; the
// engine registers them and turns normalized messages into objects, metrics and events.

export type PropertyType = "string" | "number" | "integer" | "boolean" | "object" | "array" | "timestamp";

export interface PropertySpec {
  type: PropertyType;
  required?: boolean;
  enum?: unknown[];
  min?: number;
  max?: number;
}

export interface ObjectTypeDef {
  key: string;
  name: Record<string, string>;
  properties: Record<string, PropertySpec>;
}

export interface MetricDef {
  key: string;
  unit?: string;
  label?: Record<string, string>;
}

export type Severity = "info" | "warn" | "alarm";

/** What one raw message means, in engine terms. */
export interface Normalized {
  object: { type: string; externalId: string; name?: string; properties?: Record<string, unknown> };
  /** Measurement time; the engine uses the receive time when absent. */
  ts?: Date;
  metrics: Record<string, number | null | undefined>;
  events?: { type: string; severity: Severity; payload?: Record<string, unknown> }[];
}

export class ValidationError extends Error {}

export interface ModulePackage {
  id: string;
  objectTypes: ObjectTypeDef[];
  metrics: MetricDef[];
  /** Validates and maps one message. Throws ValidationError for bad input. */
  normalize(message: Record<string, unknown>): Normalized | Normalized[];
}
