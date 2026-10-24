// A module package is configuration plus a normalizer: the engine never knows what a
// greenhouse or a drone is. Packages declare their object types and metric keys; the
// engine registers them and turns normalized messages into objects, metrics and events.

export type PropertyType = "string" | "number" | "integer" | "boolean" | "object" | "array" | "timestamp" | "quantity";

/** One field of an object or event schema. A "quantity" is {value, unit}, unit one of `units`. */
export interface PropertySpec {
  type: PropertyType;
  required?: boolean;
  enum?: unknown[];
  units?: string[];
  min?: number;
  max?: number;
  /** Form label, {"en": "...", "it": "..."}; ignored by validation. */
  label?: Record<string, string>;
  /** Text for enum values, {value: {"en": ..., "it": ...}}; ignored by validation. */
  options?: Record<string, Record<string, string>>;
  /** "schema": an object property holding a field schema itself (a project's result fields). */
  format?: "schema";
  /** "link.property": an object property validated against the schema held by the linked object. */
  schemaFrom?: string;
}

export interface ObjectTypeDef {
  key: string;
  name: Record<string, string>;
  properties: Record<string, PropertySpec>;
}

/** An event type with a payload schema; stored as `${package}.${key}`. */
export interface EventTypeDef {
  key: string;
  name: Record<string, string>;
  fields: Record<string, PropertySpec>;
  /** Object type the events are about ("agronomy.crop"); the entry form offers only those. */
  subject?: string;
  /** Fields filled in from the chosen object: {field: property}. */
  fromSubject?: Record<string, string>;
  /** Other object types an event may be linked to after its subject (a run's datasets). */
  also?: string[];
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
  /** Config version the device reports as applied (see rules pushed to devices). */
  configAck?: number;
}

/**
 * A metric computed by the engine from other metrics of the same message.
 * avg/sum/min/max take any number of inputs, diff and ratio take two (a - b, a / b);
 * delta and rate take one and compare it with the previous value of the same object
 * (rate is per second).
 */
export interface DerivedDef extends MetricDef {
  fn: "avg" | "sum" | "min" | "max" | "diff" | "ratio" | "delta" | "rate";
  inputs: string[];
}

export interface PackageStepContext {
  /** Effective organization and object settings for this object. */
  config: Record<string, unknown>;
  /** Properties emitted by the current normalized message. */
  properties: Record<string, unknown>;
}

export class ValidationError extends Error {}

export interface ModulePackage {
  id: string;
  objectTypes: ObjectTypeDef[];
  /** Event types whose payload the engine validates (push, upload, manual, replay). */
  eventTypes?: EventTypeDef[];
  metrics: MetricDef[];
  derived?: DerivedDef[];
  /** Validates and maps one message. Throws ValidationError for bad input. */
  normalize(message: Record<string, unknown>): Normalized | Normalized[];
  /**
   * Optional stateful step per object, run in time order after derived metrics: it may add
   * metrics that need history (counters, accumulated hours, ...). `state` is the package's own
   * state for the object (objects.state.pkg), updated in place.
   */
  step?(metrics: Record<string, number | null | undefined>, ts: Date, state: Record<string, unknown>, context?: PackageStepContext): void;
}
