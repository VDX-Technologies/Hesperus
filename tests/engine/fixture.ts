import { ValidationError, type ModulePackage } from "../../lib/engine/package";

export const testPkg: ModulePackage = {
  id: "testmod",
  objectTypes: [{ key: "sensor", name: { en: "Sensor" }, properties: { model: { type: "string" } } }],
  metrics: [{ key: "temp", unit: "°C" }, { key: "hum", unit: "%" }],
  normalize(m) {
    if (typeof m.sensor !== "string") throw new ValidationError("sensor is required");
    return {
      object: { type: "sensor", externalId: m.sensor, properties: m.model ? { model: m.model } : undefined },
      ts: m.t ? new Date(m.t as string) : undefined,
      metrics: { temp: m.temp as number, hum: m.hum as number, other: 1 },
      events: m.alarm ? [{ type: "overheat", severity: "alarm", payload: { temp: m.temp } }] : [],
    };
  },
};
