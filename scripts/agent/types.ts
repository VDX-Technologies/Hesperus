// VDX Agent telemetry as configuration: an anonymous install (random id, hardware, no user data)
// and one event per model turn. The open-source agent pushes them with a custom source token,
// only after its user allows it. Running it again replaces the definitions in place.
import type { TenantDb } from "../../lib/engine/db";
import type { Author } from "../../lib/engine/manual";
import { saveEventType, type EventTypeInput } from "../../lib/engine/registers";
import { saveObjectType, type ObjectTypeInput } from "../../lib/engine/custom-objects";

const l = (it: string, en: string) => ({ it, en });

export const objectTypes: ObjectTypeInput[] = [
  {
    key: "agent_install",
    name: l("Installazione VDX Agent", "VDX Agent install"),
    properties: {
      app_version: { type: "string", label: l("Versione app", "App version") },
      mac_model: { type: "string", label: l("Modello Mac", "Mac model") },
      chip: { type: "string", label: l("Chip", "Chip") },
      cpu_cores: { type: "integer", min: 0, label: l("Core CPU", "CPU cores") },
      ram_gb: { type: "number", min: 0, label: l("RAM (GB)", "RAM (GB)") },
      macos: { type: "string", label: l("macOS", "macOS") },
      python: { type: "string", label: l("Python", "Python") },
      ollama: { type: "string", label: l("Ollama", "Ollama") },
    },
  },
];

const int = (it: string, en: string) => ({ type: "integer" as const, min: 0, label: l(it, en) });

export const eventTypes: EventTypeInput[] = [
  {
    key: "agent_turn",
    name: l("Turno del modello", "Model turn"),
    subject: "custom.agent_install",
    fields: {
      model: { type: "string", required: true, label: l("Modello", "Model") },
      family: { type: "string", label: l("Famiglia", "Family") },
      parameter_size: { type: "string", label: l("Parametri", "Parameters") },
      quantization: { type: "string", label: l("Quantizzazione", "Quantization") },
      model_bytes: int("Dimensione modello (byte)", "Model size (bytes)"),
      vram_bytes: int("VRAM usata (byte)", "VRAM used (bytes)"),
      prompt_tokens: int("Token prompt", "Prompt tokens"),
      completion_tokens: int("Token risposta", "Completion tokens"),
      duration_ms: int("Durata (ms)", "Duration (ms)"),
      load_ms: int("Caricamento (ms)", "Load (ms)"),
      prompt_ms: int("Prompt (ms)", "Prompt eval (ms)"),
      gpu_ms: int("Tempo GPU (ms)", "GPU time (ms)"),
      cpu_ms: int("Tempo CPU (ms)", "CPU time (ms)"),
      tokens_per_s: { type: "number", min: 0, label: l("Token/s", "Tokens/s") },
      tools: { type: "integer", min: 0, label: l("Tool chiamati", "Tool calls") },
      ok: { type: "boolean", label: l("Riuscito", "Succeeded") },
    },
  },
];

/** Saves the telemetry types, the install first since turns point at it. */
export async function seedAgent(db: TenantDb, owner: Author): Promise<string[]> {
  const saved: string[] = [];
  for (const t of objectTypes) saved.push(await saveObjectType(db, owner, t));
  for (const t of eventTypes) saved.push(await saveEventType(db, owner, t));
  return saved;
}
