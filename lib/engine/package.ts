export type PropertyType = "string" | "number" | "integer" | "boolean" | "object" | "array" | "timestamp" | "quantity";

export interface PropertySpec {
  type: PropertyType;
  required?: boolean;
  enum?: unknown[];
  units?: string[];
  min?: number;
  max?: number;
  label?: Record<string, string>;
  options?: Record<string, Record<string, string>>;
  format?: "schema" | "text";
  schemaFrom?: string;
}

export interface ObjectTypeDef {
  key: string;
  name: Record<string, string>;
  properties: Record<string, PropertySpec>;
}

export interface EventTypeDef {
  key: string;
  name: Record<string, string>;
  fields: Record<string, PropertySpec>;
  subject?: string;
  fromSubject?: Record<string, string>;
  also?: string[];
}

export interface MetricDef {
  key: string;
  unit?: string;
  label?: Record<string, string>;
}

export type Severity = "info" | "warn" | "alarm";

export interface Normalized {
  object: { type: string; externalId: string; name?: string; properties?: Record<string, unknown> };
  ts?: Date;
  metrics: Record<string, number | null | undefined>;
  events?: { type: string; severity: Severity; payload?: Record<string, unknown> }[];
  configAck?: number;
}

export interface DerivedDef extends MetricDef {
  fn: "avg" | "sum" | "min" | "max" | "diff" | "ratio" | "delta" | "rate";
  inputs: string[];
}

export interface PackageStepContext {
  config: Record<string, unknown>;
  properties: Record<string, unknown>;
}

export class ValidationError extends Error {}

export interface ModulePackage {
  id: string;
  objectTypes: ObjectTypeDef[];
  eventTypes?: EventTypeDef[];
  metrics: MetricDef[];
  derived?: DerivedDef[];
  normalize(message: Record<string, unknown>): Normalized | Normalized[];
  step?(metrics: Record<string, number | null | undefined>, ts: Date, state: Record<string, unknown>, context?: PackageStepContext): void;
}
